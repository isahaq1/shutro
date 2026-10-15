# RFC 0003 — Environment & transaction context

- **Status:** Accepted (2026-10-14)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** 0001, 0002
- **Related:** 0004 (recordsets, cache, flush), 0005 (rule injection), 0006 (currency conversion dates), security (RLS)
- **Assumes** the recommended answers to 0001/0002 open questions (branded `number` ids, one module set per application).

---

## 1. Summary

Every ORM operation runs inside an **environment** (`Env`), an immutable value that holds who is acting (user,
superuser flag), for which company (current company plus allowed companies), how (language, time zone, typed flags),
and **in which transaction** (connection, savepoint stack, record cache, pending writes and recomputes, after-commit
hooks).

Recordsets carry their environment **explicitly** (`orders.env`), as in Odoo. **`AsyncLocalStorage` (ALS) carries the
*transaction scope*.** It's used to open the root environment at entry points (HTTP handlers, jobs, CLI, tests), to
nest transactions as savepoints, and to detect misuse, such as a recordset used after its transaction ended or a
recordset used inside a different transaction.

Additional decisions:

- The default isolation level is `REPEATABLE READ`, with automatic retry on serialization failures and deadlocks.
- Side effects run only after commit, which makes those retries safe.
- Superuser mode is **scoped and audited**, never a value that leaks.
- Context is a **typed** object. Odoo's `default_*` keys and other magic keys are not supported.

---

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Every query must know the user, the current company, allowed companies, language and time zone. Security (record rules, RLS), multi-company checks, translations and date handling depend on them. |
| R2  | Business code must not thread `ctx` through every function, but the context must never be ambiguous. |
| R3  | **One transaction per unit of work** (request, job, command). Nested "transactions" become savepoints. |
| R4  | Concurrency-safe by default. Two users confirming the same order or posting the same invoice must not double-post. |
| R5  | **Side effects (email, webhooks, queue messages) must never happen for a rolled-back transaction.** |
| R6  | Elevated privileges (sudo) must be explicit, scoped, auditable, and must not leak through returned records. |
| R7  | Typed context flags, extensible by modules (e.g. `mail.tracking = false` during imports). |
| R8  | A stable "now" per transaction for `createdAt`, sequences and audit. |
| R9  | Works behind **PgBouncer in transaction mode**, and supports read replicas for reports. |
| R10 | Testable: each test runs in its own transaction or savepoint and is rolled back. Tests run in parallel without leaking context. |

---

## 3. How Odoo does it

```python
env = api.Environment(cr, uid, context)    # cr = cursor (one PG transaction), uid, context dict, su flag
orders = env['sale.order'].search([...])
orders.with_context(lang='bn_BD').name
orders.with_company(company).action_confirm()
orders.sudo().write({...})

with env.cr.savepoint():
    try_something()
```

- `self.env` is attached to every recordset. `with_user`, `with_company`, `with_context` and `sudo` return the same records in a new env.
- One cursor per HTTP request. Odoo runs at `REPEATABLE READ` and retries the whole request on serialization failures.
- `env.cache` is shared by all environments on the same cursor, keyed by field and record, with context-dependent fields
  (translations, `company_dependent`) keyed further.
- `cr.postcommit.add(fn)` runs functions after commit (Odoo 13+). `cr.precommit` handles flush and recompute.

### Weaknesses

| #  | Weakness | Consequence |
| -- | -------- | ----------- |
| W1 | **The context is an untyped dict** with magic keys: `active_test`, `tracking_disable`, `force_company` (legacy), `lang`, `tz`, many more. | Typos are silent, and nobody knows which keys are honoured where. |
| W2 | **`default_<field>` keys leak.** A context containing `default_type='out_invoice'` passed from an action applies to *any* model with a `type` field created deeper in the call stack. | A well-known class of Odoo bugs: wrong move types, wrong product types created far from the action that set the key. |
| W3 | **`sudo()` leaks.** A recordset obtained with `sudo()` keeps superuser rights wherever it travels (returned from helpers, stored in variables, passed to other methods). | Privilege-escalation bugs and accidental bypass of record rules. |
| W4 | **`cr.commit()` inside business code** (crons, imports) splits atomic operations arbitrarily, and the ORM can't stop it. | Partial data on failure, and broken retry semantics. |
| W5 | **Retries replay side effects** unless every developer remembers `postcommit`. | Duplicate emails and webhooks. |
| W6 | **`env.company` vs `allowed_company_ids`** are set from cookies/context by the web layer. Background jobs often run with the wrong company. | Records created in the wrong company by crons and queue jobs. |
| W7 | **Time-zone handling** depends on `tz` in context and on the user. `fields.Date.today()` vs `context_today(record)` is a constant source of off-by-one-day bugs. | Wrong invoice dates around midnight. |

---

## 4. Prior art

| ORM | Mechanism | Lessons |
| --- | --------- | ------- |
| **Prisma** | `prisma.$transaction(async (tx) => …)`, so `tx` must be passed explicitly. Batch `$transaction([...])`. No ambient context, and nested interactive transactions aren't supported. | ✅ Explicit and simple. ❌ Every helper needs a `tx` parameter. With no nesting, you can't compose helpers that each "want a transaction". |
| **Drizzle** | `db.transaction(async (tx) => …)`. Nested `tx.transaction()` becomes a savepoint. | ✅ Nested transactions map to savepoints, as Shutro wants. ❌ Still explicit `tx` passing, and no user/company concept. |
| **Kysely** | `db.transaction().setIsolationLevel('serializable').execute(async (trx) => …)`, `db.connection()`. | ✅ Isolation level is part of the API. ❌ No retry, no context. |
| **MikroORM** | `RequestContext.create(em, next)` forks the `EntityManager` per request using **AsyncLocalStorage**. `em.transactional(cb)`, `@Transactional()`. Using the global EM without a fork throws a validation error. | ✅ **ALS-based per-request scoping works well in production Node.** ✅ It fails loudly when there's no context, which Shutro adopts. ❌ The implicit EM makes it unclear which identity map an entity belongs to. Shutro avoids this by binding recordsets to their env. |

Platform notes:

- In Node 24 LTS, `AsyncLocalStorage` uses `AsyncContextFrame` by default, which is much cheaper than the old
  `async_hooks` implementation.
- Context can still be lost across some callback-based libraries (event emitters, some pool callbacks). Shutro must
  not depend on ALS for anything that *flows through* such callbacks, only for scope boundaries.

---

## 5. Options

### Option A — Explicit only

The env is passed explicitly everywhere (`fn(env, …)`) and carried by recordsets. There's no ALS.

### Option B — Implicit only

`currentEnv()` can be called anywhere, and recordsets look it up at the time of use.

### Option C — Hybrid

Recordsets carry their env explicitly. ALS carries the active **transaction scope**, which is used to:

1. open root environments at entry points (`shutro.run(...)`),
2. map nested `transaction()` calls to savepoints,
3. let infrastructure code (audit, sequences, logging, outbox) find the current scope, and
4. detect misuse.

### Trade-offs

| Criterion | A: explicit | B: implicit | C: hybrid |
| --------- | ----------- | ----------- | --------- |
| Clear which user/company a record operation uses | ✅ | ❌ depends on where the call runs | ✅ the recordset's env |
| Helpers composable without threading `tx` | ❌ | ✅ | ✅ |
| `with_company` / sudo per call (Odoo idiom) | ✅ | ⚠️ needs `run()` blocks everywhere | ✅ |
| Detects use-after-commit and cross-transaction mixing | ⚠️ needs manual checks | ⚠️ | ✅ the scope is compared on every operation |
| Robust if ALS context is lost in a library callback | ✅ | ❌ silently wrong env | ✅ falls back to the recordset's env, and errors only on a scope mismatch |
| "Explicit over magic" (`CLAUDE.md`) | ✅ | ❌ | ✅ (ALS is only a boundary mechanism) |

---

## 6. Decision

**Option C, the hybrid.**

1. `Env` is immutable. Recordsets hold their `env`. Derived environments (`withCompany`, `withLang`, `withFlags`, …) are new values.
2. Each `Env` belongs to exactly one **`TxScope`** (transaction scope). A `TxScope` is created by `shutro.run()` or `shutro.transaction()`
   and stored in ALS for the duration of the callback.
3. Every ORM operation checks that `recordset.env.scope` is open, and that it is the ALS-active scope (or its ancestor).
   Otherwise it throws `TransactionScopeError`.
4. `REPEATABLE READ` is the default. Retries on `40001` (serialization failure) and `40P01` (deadlock) are automatic and bounded.
5. Side effects go through `env.afterCommit()` or the transactional outbox (events RFC). There's no API to commit mid-scope.
6. Superuser access is scoped: `env.asSuperuser({ reason }, fn)`. Recordsets returned by `fn` are rebound to the caller's env.
7. The context is typed (`Flags`), modules can extend it, and there are **no `default_*` keys**. Defaults are passed explicitly
   to `create()`.

---

## 7. Detailed design

### 7.1 Entry points

```ts
import { shutro } from './app/.shutro/index.js';   // application view (RFC 0002)

// HTTP (Hono / Fastify / Express all look like this)
app.post('/api/sale-orders/:id/confirm', async (c) => {
  const session = await auth(c);
  return shutro.run(
    {
      user: session.userId,                      // Id<'res.users'>
      company: session.activeCompanyId,          // must be in the user's allowed companies (checked)
      companies: session.selectedCompanyIds,     // optional subset of allowed, defaults to [company]
      lang: session.lang,                        // 'bn_BD'
      tz: session.tz,                            // 'Asia/Dhaka'
    },
    async (env) => {
      const order = await env.model('sale.order').browse([Number(c.req.param('id'))]).ensureExists();
      await order.confirm();
      return c.json(await order.read(['name', 'state', 'amountTotal']));
    },
  );                                             // commit here, then run afterCommit hooks
});

// Background job: the company is mandatory. No "whatever the cron user's default company is" (W6).
await shutro.run({ user: SYSTEM_USER, company: job.companyId, reason: 'job:invoice-reminders' }, sendReminders);
```

`shutro.run(identity, fn)`:

1. Loads the user's allowed companies, groups, language and tz defaults once per run. These go into a small cache
   keyed by user and write-version.
2. Begins a transaction on a pooled connection and creates the `TxScope`.
3. Pushes the session settings with **`SET LOCAL`** (`set_config(..., true)`), which is safe under PgBouncer in transaction mode:
   - `shutro.user_id`, `shutro.company_ids` (used by the optional RLS policies in the security RFC)
   - `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`
   - `TimeZone = 'UTC'`. Storage is always UTC, and conversion to the env tz is done in TS.
4. Runs `fn(env)` inside `als.run(scope, …)`.
5. **Pre-commit:** flushes pending writes, recomputes stored computed fields, runs constraints (RFC 0004 and the compute
   RFC), and writes the audit and outbox rows. Then it commits.
6. **Post-commit:** runs `afterCommit` hooks. They're outside the transaction, and failures are logged but don't affect the result.
7. On error: rolls back, runs `onRollback` hooks, and decides whether to retry (§7.5).

### 7.2 The `Env` interface

```ts
interface Env<S extends SchemaView = AppView> {
  readonly user: Record<'res.users'>;
  readonly uid: Id<'res.users'>;
  readonly su: boolean;                          // superuser, only inside asSuperuser()
  readonly company: Record<'res.company'>;       // current company: defaults, sequences, currency
  readonly companies: RecordSet<'res.company'>;  // allowed (active) companies: record-rule scope
  readonly lang: LangCode;                       // 'en_US' | 'bn_BD' | …
  readonly tz: TimeZone;                         // IANA, validated
  readonly flags: Readonly<Flags>;               // typed context (§7.4)
  readonly scope: TxScope;                       // opaque

  model<N extends keyof S & string>(name: N): RecordSet<N>;   // empty recordset bound to this env

  now(): Instant;                                // transaction timestamp (PG now()), stable within one attempt
  today(): CalendarDate;                         // now() converted to env.tz, which fixes W7
  todayIn(tz: TimeZone): CalendarDate;

  withCompany(company: Id<'res.company'> | Record<'res.company'>): Env<S>;  // must be in allowed companies unless su
  withCompanies(companies: RecordSet<'res.company'>): Env<S>;
  withLang(lang: LangCode): Env<S>;
  withTz(tz: TimeZone): Env<S>;
  withFlags(flags: Partial<Flags>): Env<S>;
  withUser(user: Id<'res.users'>): Promise<Env<S>>;   // loads the target user's rights; needs su or permission 'base.impersonate'

  asSuperuser<T>(opts: { reason: string }, fn: (su: Env<S>) => Promise<T>): Promise<Rebound<T>>;

  transaction<T>(fn: (env: Env<S>) => Promise<T>, opts?: SavepointOptions): Promise<T>;  // nested → savepoint
  flush(): Promise<void>;                        // explicit flush (RFC 0004)
  afterCommit(fn: () => void | Promise<void>): void;
  onRollback(fn: () => void | Promise<void>): void;

  sql: SqlRunner;                                // tagged-template raw SQL in this transaction (RFC 0005 rules apply)
}
```

### 7.3 Derived environments and cache sharing

`withCompany`, `withLang` and similar create a new `Env` in the **same** `TxScope`. They share the scope's identity map and
cache (RFC 0004). Fields whose value depends on the env, like translated fields (`lang`), `companyDependent` fields
(`company`) and computed fields declared `dependsOnContext: ['company']`, are cached under a key that includes that
part of the env. Everything else is shared, so switching company doesn't refetch partner names.

```ts
const bd = env.withCompany(paragonBd);
const sg = env.withCompany(paragonSg);
await product.withEnv(bd).load(['standardPrice']);   // cost per company (companyDependent)
await product.withEnv(sg).load(['standardPrice']);   // second query, different cache key
product.withEnv(bd).name === product.withEnv(sg).name;   // shared, no extra query
```

### 7.4 Typed flags (the context)

```ts
// @shutro/core built-ins
interface Flags {
  activeTest: boolean;          // default true: searches hide archived records
  tracking: boolean;            // default true: audit/tracking messages (imports may turn this off)
  recompute: 'immediate' | 'beforeCommit';   // default 'beforeCommit'
  checkCompany: boolean;        // default true: multi-company consistency (only su may disable)
}

// A module contributes flags in defineModule; they appear only in the views of modules that depend on it (RFC 0002)
export default defineModule({
  name: 'mail',
  flags: {
    mailNotify: flag.boolean({ default: true, help: 'Send notification emails to followers' }),
    mailCreateNosubscribe: flag.boolean({ default: false }),
  },
  …
});

await orders.withFlags({ mailNotify: false }).confirm();       // typed, no magic strings
await orders.withFlags({ mailNotfy: false });                  // ❌ compile error
```

**Defaults are not context.** Values that Odoo passes as `default_type` are passed explicitly, and they apply only to the
model being created:

```ts
await env.model('account.move').create([{ partner, lines }], { defaults: { moveType: 'out_invoice' } });
// Nested creates (lines) and records created by overrides deeper in the stack don't see `moveType`, which fixes W2.
```

UI actions in Kosh that need to carry defaults (e.g. "New invoice" from a menu) pass them as action parameters, never through the env.

### 7.5 Transactions, isolation, retries

```ts
await shutro.transaction(
  { isolation: 'repeatable read', retry: { attempts: 5, backoff: 'jittered-exponential' } },   // the defaults
  async (env) => { … },
);
```

| Situation | Behaviour |
| --------- | --------- |
| Top-level `run` / `transaction` | `BEGIN ISOLATION LEVEL REPEATABLE READ`. Odoo also uses `REPEATABLE READ`, which avoids non-repeatable reads in long business operations, at the cost of serialization failures. |
| `40001` / `40P01` | Roll back, discard the scope (cache, pending writes, hooks), and **re-run `fn` from scratch** with a new scope. When attempts run out: `ConcurrentUpdateError` explaining which statement conflicted and how to reduce contention. |
| Nested `env.transaction(fn)` | `SAVEPOINT sp_n`. If `fn` throws, the scope rolls back to the savepoint, restores the cache and pending-write state captured at the savepoint (RFC 0004 §7.6), and rethrows. On success: `RELEASE`. |
| `isolation: 'serializable'` | Opt-in for critical sections (e.g. stock reservation), with the same retry logic. |
| `readOnly: true` | `BEGIN … READ ONLY`. Writes throw `ReadOnlyTransactionError`. With `replica: 'allow-stale'` it may be routed to a read replica (connection layer). |

Retries are only safe because `fn` must not have side effects outside the database:

- `env.afterCommit(fn)` registers work that runs only after a successful commit of *this attempt*.
- The **transactional outbox** (events RFC) writes events to a table in the same transaction, and a relay publishes them
  after commit (LISTEN/NOTIFY wakes it). This is the recommended path for email, webhooks and integrations.
- A lint rule flags common side-effecting calls (`fetch`, mailer SDKs) inside model methods.

**No mid-scope commit.** There's no `env.commit()`. Long jobs process data in **chunked transactions** instead (fixes W4):

```ts
await shutro.forEachChunk(
  { user: SYSTEM_USER, company, reason: 'job:recompute-margins' },
  async (env) => (await env.model('sale.order').search({ where: { state: 'sale' } })).ids,  // ids collected in a read-only snapshot
  { size: 500 },
  async (env, orders) => { await orders.recomputeMargin(); },               // one transaction per chunk, each retried independently
);
```

### 7.6 Superuser: scoped, audited, not leaky

```ts
// In a payment webhook: the portal user can't read the company's bank journals, but posting the payment must.
const payment = await env.asSuperuser({ reason: 'payment-webhook: register payment' }, async (su) => {
  const journal = await su.model('account.journal').search({ where: { type: 'bank', company: su.company.id }, limit: 1 });
  return su.model('account.payment').create([{ journal, amount, partner: env.user.partner, … }]);
});

payment.env.su;   // false: the returned recordset was rebound to the caller's env (fixes W3)
```

- `Rebound<T>` rebinds a top-level recordset, or recordsets in a top-level array or plain object. Any other value is returned as is.
- Every `asSuperuser` call writes `{ reason, user, at }` into the audit trail when tracking is enabled.
- There's no `recordset.sudo()`. The only way to get an `su` env is inside the callback.
- Security checks (ACL, record rules, field groups) are skipped only when `env.su` is true. Multi-company consistency
  checks (`checkCompany`) **still apply** under su unless explicitly disabled with `withFlags({ checkCompany: false })`.

### 7.7 ALS and misuse detection

The ALS holds only `{ scope: TxScope }`. Checks run on every ORM entry point (search, load, write, create, unlink, flush, sql):

| Detected | Error |
| -------- | ----- |
| No active scope, and no recordset env (e.g. calling `shutro.model()` at module top level) | `NoEnvironmentError: No Shutro environment is active. Wrap the call in shutro.run({ user, company }, …) or use the env of an existing recordset.` |
| The recordset's scope has already committed or rolled back (e.g. records kept in a module-level variable or a cache between requests) | `TransactionScopeError: sale.order(42) belongs to a transaction that already ended. Re-browse it inside the current shutro.run(): env.model('sale.order').browse(ids).` |
| The recordset's scope differs from the active one (records from request A used in request B) | Same error, with "belongs to a different transaction". |
| ALS context lost in a library callback, but the recordset's scope is still open | **No error.** The recordset's env is authoritative. ALS is only a safety net. |

Inside one scope, operations are **serialized** by a per-scope async mutex. A single PG connection can't run statements
concurrently anyway, and serializing prevents interleaved flush/recompute. `Promise.all` inside one transaction is
allowed but gives no speed-up, so the docs point to `forEachChunk` or separate `run()` calls for parallelism.

### 7.8 Time

- `env.now()` returns the PostgreSQL transaction timestamp (`now()`), fetched once at `BEGIN` and stable within an attempt.
  `createdAt` / `updatedAt` / audit rows use it, so all rows written by a transaction share one timestamp.
- `env.today()` = `env.now()` in `env.tz`. Field defaults use it: `invoiceDate: f.date({ default: (env) => env.today() })`.
- Converting a datetime to a business date always requires an explicit tz:
  `order.dateOrder.toCalendarDate(env.tz)` (RFC 0001 example). There's no implicit server-local time.

### 7.9 Testing

```ts
import { withTestEnv } from '@shutro/testing';

test('confirming an order creates a picking', withTestEnv({ modules: [saleStock], user: 'sales.user' }, async (env) => {
  const order = await factories.saleOrder(env, { lines: 2 });
  await order.confirm();
  const loaded = await order.load({ pickings: true });   // explicit load, see RFC 0004
  expect(loaded.pickings.length).toBe(1);
}));   // the whole test runs in a transaction that is rolled back; parallel tests use separate scopes and connections
```

`withTestEnv` can also expose `commit: 'simulate'`, which runs pre-commit and post-commit phases and then rolls back. That
lets tests verify `afterCommit` hooks and constraints without leaving data behind.

---

## 8. Type-level guarantees

```ts
env.model('sale.ordr');                              // ❌ not a model in this view
env.withFlags({ mailNotify: false });                // ❌ in a module that does not depend on `mail`
env.withCompany(42);                                 // ❌ number is not Id<'res.company'>
orders.sudo();                                       // ❌ does not exist; use env.asSuperuser
const r = await env.asSuperuser({ reason: 'x' }, async (su) => su.model('res.partner').search({}));
expectTypeOf(r).toEqualTypeOf<RecordSet<'res.partner'>>();   // rebound
env.asSuperuser({}, fn);                             // ❌ reason is required
```

---

## 9. Runtime metadata

`registry.describeFlags()` lists every flag, with its default and origin module (for Kosh developer tools).
`shutro inspect --scope` (dev mode) prints the active scope: user, companies, isolation, savepoint depth, pending writes,
and the number of queries so far.

---

## 10. Interactions

- **0004:** the scope owns the identity map, cache, dirty set and savepoint snapshots, and the flush points hook into §7.1 step 5.
- **0005:** the compiler reads `env.companies`, `env.lang`, `env.su` and `flags.activeTest` to inject filters.
- **0006:** currency conversion takes a `date`, never "today" implicitly. `env.today()` is available, but it must be passed explicitly.
- **Security:** `SET LOCAL shutro.user_id / shutro.company_ids` is the bridge to PostgreSQL RLS policies.
- **Events:** the outbox is written in pre-commit, and LISTEN/NOTIFY wakes the relay after commit.

---

## 11. Resolved questions

Resolved on 2026-10-14. The original questions are kept below for context.

| # | Resolution |
| - | ---------- |
| 1 | **Retry is on by default** (5 attempts). `shutro.run({ …, retry: false })` is for handlers that stream. The docs state that a response must not be streamed from inside a retried scope. |
| 2 | **`withUser` requires an `su` env** in v1. That's the more secure default, and a dedicated permission can be added later without breaking anything. |
| 3 | **Concurrent operations on one scope are serialized**, and dev mode warns once per scope, with a hint to use `forEachChunk` or separate `run()` calls. |

**Original questions:**

1. **Retry by default for all `run()` calls.** HTTP handlers that stream a response can't be retried after the first byte. Should
   the default be `retry: 5` with a documented "don't stream inside run()" rule, or opt-in retries?
2. **`withUser` permission.** Is a dedicated permission (`base.impersonate`) acceptable, or should only su envs switch users?
3. **Per-scope mutex vs error.** Should concurrent operations on one scope be serialized silently (current proposal), or should they
   throw, to force callers to write sequential code?

## 12. Deferred

- Connection layer details (driver choice, pool sizing, replica routing): driver RFC (Phase 1 benchmark).
- Outbox schema and relay: events RFC.
- RLS policy generation: security RFC.

---

## Implementation notes (2026-10-14, `@shutro/core` env layer, first step)

Implemented in `packages/core/src/env/` without models or the registry. Where the implementation refines this RFC:

1. **No global state.** `createShutro({ driver })` returns an instance owning its own `AsyncLocalStorage`. There is no
   module-level `shutro` singleton; applications create one per driver.
2. **`Env.sql`** is the raw-SQL entry point for now (RFC 0005 §7.8 rules apply: values become parameters). `env.model()`,
   `env.user` / `env.company` records and module-contributed flags arrive with the registry (RFC 0002).
3. **Time:** `env.now()` returns a `Date` copy and `env.today()` a `'YYYY-MM-DD'` string until `Instant` / `CalendarDate`
   exist (RFC 0001 Q3). `now()` costs one `SELECT now()` per attempt, separate from the settings round-trip; folding it
   into the driver's settings statement is a later optimization.
4. **Savepoint hooks:** `afterCommit` hooks registered inside a savepoint are merged into the parent when the savepoint is
   released and discarded when it rolls back. `onRollback` hooks of a rolled-back savepoint run immediately.
5. **Scope checks (§7.7)** are implemented in this order: scope ended → nested savepoint active on this connection →
   another transaction active in the async context. A lost async context is never an error on its own.
6. **Retry (Q1 resolved):** on by default, `retry: false` per run. `env.attempt` tells hooks and logs which attempt they
   belong to. Read-only violations and other non-retryable driver errors surface unchanged after one attempt.
7. **Settings** use lower-case names (`timezone`, not `TimeZone`), because the driver validates setting names strictly
   and PostgreSQL treats them case-insensitively.
8. **Superuser** (`asSuperuser`) is scoped to the callback. Rebinding returned recordsets to the caller's env (`Rebound<T>`)
   waits for recordsets; today plain values are returned as is.

## Implementation notes (2026-10-15, multi-company)

- Automatic filtering: `search()` adds `company IN allowed` (`OR company IS NULL` for optional scopes) under
  `flags.checkCompany` (`scopingConditions`); `create()` defaults `company` to `env.companyId`.
- Cross-company links: `f.many2one(target, { checkCompany: true })` on a companyScoped model synthesizes a
  `companyConsistency` constraint (RFC 0009 machinery) that throws `CrossCompanyError` at the flush point when a target
  has a company different from the record's; shared targets (no company) pass. The registry requires the target to be
  companyScoped. `withFlags({ checkCompany: false })` (superuser) disables both the filter and the check.
- `env.company` / `env.companies` records (§7.2) are not implemented; `companyId` / `companyIds` are.
