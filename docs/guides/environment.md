# Environment and transactions

Every Shutro operation runs inside an **environment** (`Env`): who is acting, for which company, in which language
and time zone, and in which transaction. This implements [RFC 0003](../rfcs/0003-environment-and-transaction-context.md).
Models and recordsets aren't built yet, so for now the environment exposes `env.sql` for raw SQL.

```ts
import { createShutro, toDecimal } from '@shutro/core';
import { createDriver } from '@shutro/driver-pg';

const driver = createDriver({ url: process.env.DATABASE_URL ?? '', parseNumeric: toDecimal });
const shutro = createShutro({ driver });

// One unit of work = one transaction (HTTP request, job, CLI command)
const total = await shutro.run(
  { user: session.userId, company: session.companyId, companies: session.companyIds, lang: 'bn_BD', tz: 'Asia/Dhaka' },
  async (env) => {
    const [row] = await env.sql<{ total: Decimal }>`
      SELECT sum(${sql.id('amount_total')}) AS total FROM ${sql.id('sale_order')}
      WHERE ${sql.id('company_id')} = ${env.companyId}`;
    env.afterCommit(() => notify(row?.total));   // only runs if the transaction commits
    return row?.total;
  },
);
```

## What `run()` does

1. Validates the identity (`InvalidIdentityError` before any transaction starts): positive ids, the current company
   must be among `companies`, a known IANA `tz`, a `ll_CC` language.
2. `BEGIN ISOLATION LEVEL REPEATABLE READ` (`READ ONLY` with `readOnly: true`), and sets for this transaction only:
   `shutro.user_id`, `shutro.company_ids` (for PostgreSQL row-level security later) and `timezone = UTC`.
3. Fetches the transaction timestamp once: `env.now()` and `env.today()` are stable for the whole attempt.
4. Runs your function. Commits when it resolves, rolls back when it throws.
5. **Retries** the whole function on a serialization failure or deadlock (5 attempts by default, jittered backoff).
   After the last failure you get `ConcurrentUpdateError` with the driver error as `cause`.

Because of step 5, **your function must not have side effects outside the database**. Register them with
`env.afterCommit()`: they run once, after the attempt that commits. `env.onRollback()` runs for each attempt that
rolls back. A hook that throws can't change the outcome, so it's reported through `createShutro({ onHookError })`
(default: a Node warning).

Streaming an HTTP response from inside `run()` can't be retried. Pass `retry: false` for those handlers.

## Nested transactions are savepoints

```ts
await shutro.run(identity, async (env) => {
  await env.transaction(async (sp) => {
    await sp.sql`...`;                 // rolled back alone if this callback throws
    sp.afterCommit(() => ...);         // discarded if the savepoint rolls back, kept if it's released
  });
});
```

While a savepoint is active, the **outer** env can't run statements (that would interleave work on one
connection). Use the env passed to the callback.

## Derived environments

Environments are immutable. Each `with*` call returns a new one that shares the transaction:

| Call | Rule |
| ---- | ---- |
| `env.withCompany(id)` | Must be in `env.companyIds`, or `CompanyNotAllowedError` (superuser may pick any company) |
| `env.withLang('en_US')`, `env.withTz('UTC')` | Validated |
| `env.withFlags({ activeTest: false })` | Typed flags only. `checkCompany: false` needs a superuser env (`FlagNotAllowedError`) |
| `env.asSuperuser({ reason }, (su) => ...)` | Elevation is scoped to the callback and the reason is mandatory (it goes into the audit trail). There is no `sudo()`. |

There are no `default_*` context keys. Defaults are passed explicitly to `create()` (when models exist).

## Misuse is detected

| Situation | Error |
| --------- | ----- |
| `shutro.currentEnv()` outside `run()` | `NoEnvironmentError` |
| An env used after its transaction ended (kept in a module-level variable, a cache, ...) | `TransactionScopeError` ("already committed/rolled back") |
| An env from transaction A used inside transaction B | `TransactionScopeError` ("different transaction") |
| The outer env used while a savepoint is active | `TransactionScopeError` ("nested transaction is active") |

`AsyncLocalStorage` only marks transaction boundaries. If a library callback loses the async context, the env still
works, because the env carries its own scope. Only a *conflicting* active scope is an error.

## Time

- `env.now()` is PostgreSQL's `now()` for the transaction, returned as a fresh `Date` each call.
- `env.today()` is that instant as a `'YYYY-MM-DD'` date in `env.tz`. `env.todayIn(tz)` for another zone.
  `calendarDateIn(date, tz)` is the underlying helper: `2026-10-14T20:30Z` is already `2026-10-15` in Dhaka.
