# Feedback from building `examples/erp-demo`

Pain points hit while building the partner, product, sale and invoice modules entirely on Shutro (and, earlier, the
engine's own test fixtures and benchmarks), written as issues ready to file. **Fixed** issues were found and fixed
during the work; their commits are named. **Open** issues are ordered by how much they hurt.

Labels: `bug`, `dx` (developer experience), `types`, `security`, `perf`, `api`, `docs`. Severity: S1 (blocks or
corrupts) … S4 (papercut).

---

## Fixed while building

### F1 — Nested `one2many` creates issued one INSERT per parent
`bug` `perf` · S2 · fixed in `5b01b0d`

`create([{ ..., lines: { create: [...] } }] × 1,000)` ran 1,006 statements: the child rows of each parent were
inserted separately. Found by the CI benchmark. `create` commands of all new parents are now batched into one child
insert per field (1,006 → 9 statements, 1.03 s → 0.65 s for 4,000 records).

### F2 — Binary values given to `create()` were silently dropped
`bug` · S1 · fixed in `5b01b0d`

The INSERT column list came from the default projection, which excludes binary fields, so `create({ data: bytes })`
stored `NULL` without an error. Every explicitly given stored key is now part of the column list.

### F3 — No module could add a `one2many` to another module's model
`bug` · S2 · fixed in this commit

The extension rule "a new required field needs a default" (RFC 0002 S1) treated `one2many` / `many2many` as required
without a default. `invoice` adding `sale.order.invoices` was rejected. x2many fields are exempt now, like booleans.

### F4 — Onchange drafts kept defaults un-normalized
`bug` · S2 · fixed in this commit

A draft line took `quantity`'s default `'1'` as a string, so `l.quantity.times(...)` threw inside computes. Draft
defaults now go through the same normalization as given values.

### F5 — A monetary field with a `NULL` currency threw "currency not loaded"
`bug` `dx` · S3 · fixed in this commit

A draft line without its order has no currency; reading `subtotal` threw a misleading `FieldNotLoadedError`. A
monetary value whose currency field is null now reads as `null` (no currency, no Money).

### F6 — A partial reload overwrote unflushed values in the cache
`bug` · **S1** · fixed in this commit (regression test in `write.integration.test.ts`)

When a load needed fields missing from a cached record, the record was re-read and *every* requested column replaced
the cached value — including values written or computed in the transaction and not yet flushed. Invoice lines lost
their computed `subtotal` before the flush and the invoice total came out 0. The cache is authoritative within a
transaction now: hydration only fills keys that are not cached.

### F7 — Fields sharing a compute method ran at the lowest rank among them
`bug` · S1 · fixed in this commit (regression test in `shared-rank.integration.test.ts`)

`amountUntaxed` (rank 1) and `amountTax` (rank 2) share `computeAmounts`; the group ran at rank 1, before the lines'
`taxAmount`, and the re-trigger was then suppressed as "just computed". Invoices had no tax. A shared group now runs
at the highest rank among its fields.

---

## Open

### #1 — Compute, constraint, onchange, transition and method bodies are untyped
`dx` `types` · S2 · **fixed**: generated bindings export `compute` / `check` / `onchange` / `records` / `method` typed against the module's view; the demo's `modules/` has no casts (`docs/guides/generate.md`).

Every function inside `defineModel` takes `unknown` and casts: `compute(records: unknown) { for (const l of records as
ComputeRecords<'sale.order.line', { tax: ['rate'] }>) ... }`. The demo needs an `app/types.ts` with five aliases over
the application schema, and each module imports types from the application (a module should not know the app).
RFC 0002 plans per-module generated bindings (`defineModel` typed by the module's view); `shutro generate` emits
schemas and aliases but not typed definition functions yet.

**Proposal:** generated `bindings.ts` exports `defineModel` / `extendModel` whose callbacks are typed against the
module's view, and `LoadedFrom<depends>` for compute records. **Acceptance:** the demo compiles with no casts in
`modules/`.

### #2 — Inside a compute, computed fields read as `read | write`
`types` · S2 · **fixed**: `compute(model, assigns, …)` makes only the assigned fields writable; other computed fields read with their read type.

To make `o.amountTotal = x` legal, `ComputeRec` types computed keys as the union of read and write types
(`Money | Decimal | string`). Reading one computed field from another compute (`taxAmount` reads `subtotal`) needs a
cast; the demo ships `readMoney()` / `readId()` helpers. TypeScript mapped types cannot declare a getter and a setter
with different types.

**Proposal:** keep reads typed as read values and assign through `rec.assign('amountTotal', value)` (typed by the
write face), or generate accessor interfaces per model.

### #3 — Defaults live in the ORM, not in the database
`dx` · S3 · **fixed** (`columnDefault` in core, used by the DDL stopgap and the migrator)

*Resolution:* boolean, non-negative numeric, text, selection, state and date literals are SQL `DEFAULT`s in the
form PostgreSQL's catalog shows them, so plans stay empty after applying (`migrate.integration.test.ts`). Function,
translated, encrypted, numbered and negative defaults stay in the ORM.

`f.decimal({ default: '0.01' })`, `f.char({ default })`, `f.date({ default })` produce no SQL `DEFAULT`, so any raw
`INSERT` (fixtures, data migrations, other services) must spell every required column. Hit four times while writing
tests ("null value in column rounding"). Only boolean and integer literals become database defaults today.

**Proposal:** emit `DEFAULT` for every literal default (decimal, text, date, selection) in the DDL and the migrator.

### #4 — Drafts break the "required" promise inside computes
`types` · S3

An onchange draft of `sale.order.line` has no `order`, so `l.order` is `null` in the `currency` compute although the
field is required and typed non-null. The demo guards with `l.order as ... | null`.

**Proposal:** either skip computes whose required inputs are missing in a draft, or type compute records as
"possibly incomplete" when called from onchange.

### #5 — The first user cannot be created through the ORM
`dx` · S3 · **fixed** (`bootstrap.integration.test.ts`)

*Resolution:* `shutro.bootstrap({ reason: 'install' }, fn)` runs as the system (`SYSTEM_UID`, 0) in an audited
superuser scope; `created_by` / `updated_by` are `NULL`, so the first currency, company and user are ORM creates.

Every create records `created_by`, a foreign key to `res.users`; with no user yet, `shutro.run({ user: 1 })` cannot
insert the first one. The seed uses raw SQL.

**Proposal:** `shutro init` / the first migration creates a system user (`__system__`, id 1), or `created_by` is
null when the acting user row does not exist yet.

### #6 — The identity is not checked against the database
`security` · S3 · **fixed** in `feat/security-paths` (`paths.integration.test.ts`)

*Resolution:* `createShutro({ identity: async (uid) => ({ companies, groups }) | null })`. Every `run` verifies the user
(unknown → `InvalidIdentityError`), each requested company (→ `CompanyNotAllowedError`) and requested groups (must be a
subset); omitted groups come from the loader.

`shutro.run({ user, company, companies, groups })` trusts the caller: the company need not exist, the user need not be
allowed in it, and groups come from the application. That is by design (RFC 0003), but nothing helps an application
load them correctly.

**Proposal:** an optional `identity: (uid) => Promise<{ companies, groups }>` hook on `createShutro`, cached per run.

### #7 — `sql` is not exported by `@shutro/core`
`dx` · S4 · **fixed**: `sql`, `compile`, `SqlFragment` and `CompiledSql` are re-exported (`shutro` on npm).

Check constraints and partial indexes need the `sql` tag, so model files import `@shutro/sql` as well.

**Proposal:** re-export `sql` from `@shutro/core`.

### #8 — Methods need ACL grants on every model they touch
`security` `api` · S3

`sale.order.createInvoices()` run by an accountant reads order lines, so `invoice` must grant `account.user` read on
`sale.order.line` (an extension that exists only for that). Odoo uses `sudo()` inside such methods; Shutro's
`asSuperuser` is audited but coarse.

**Proposal:** per-method elevation declared in the definition (`methods: { createInvoices: { elevate: ['sale.order.line:read'], fn } }`),
audited like superuser scopes.

### #9 — `PreparedRates.convert` needs `Currency` objects
`api` · S3 · **fixed**: `PreparedRates` has `currency(id)`, `companyCurrency`, and `convert` / `rate` take ids.

There is no synchronous way to get a `Currency` from an id, so the demo's company-currency total does one
`env.fx.convert(Money.zero(...), id)` just to obtain the target currency before `prepare()`.

**Proposal:** `prepare()` returns the currencies it loaded (`rates.currency(id)`), and `convert(money, to: Currency | number)`.

### #10 — Child onchange handlers do not run inside the parent's onchange
`api` · S3 · **fixed**: child handlers run for the fields of each `create` row, inside the parent draft (`d.record('order')` works).

`sale.order.onchange({ lines: { create: [...] } })` computes the virtual lines but does not run `sale.order.line`'s
`product` handler, so the form calls the line onchange separately, without the order context (and without a currency,
see #4).

**Proposal:** run child handlers for the fields given in each `create` row, inside the parent draft.

### #11 — Domains cannot follow relations
`security` `api` · S2 · **fixed** in `feat/security-paths` (`paths.integration.test.ts`)

*Resolution:* dotted many2one paths (`'order.user'`, `'partner.country.code'`) and x2many `{ any | none: domain }`
compile to `IN (SELECT …)` sub-selects, in searches, record rules and generated RLS policies. Field groups and the
target's read ACL are checked along the path, so a hidden field cannot be probed through it.

`{ 'order.user': { $env: 'uid' } }` is not supported, so a record rule cannot say "lines of my orders": in the demo
every salesperson can read every order line. Searches cannot filter orders by `partner.name` either.

**Proposal:** relation paths in the domain compiler (EXISTS sub-selects for x2many, joins for many2one), usable in
rules and in RLS policies.

### #12 — Recordset helpers for amounts are missing
`dx` · S3 · **fixed**: `records.sum(key, currency?)` (RFC 0016).

Every total compute repeats `let x = toDecimal(0); for (...) x = x.plus(l.subtotal?.amount ?? 0)`. The target API in
`CLAUDE.md` shows `o.lines.sum('subtotal')`.

**Proposal:** `records.sum(key)` returning `Money` (currency-checked) or `Decimal`.

### #13 — No aggregation API for reports
`api` `security` · S3 · **fixed**: `env.model(M).aggregate()` with rules, field groups, per-currency Money (RFC 0016, `docs/guides/reports.md`).

There is no `read_group` equivalent on `ModelRef`; reports drop to `env.sql`, which skips ORM rules and field groups
(RLS covers rows only when enabled).

**Proposal:** `env.model(M).aggregate({ groupBy, measures, where })` compiled with rules and field checks.

### #14 — `browse()` returns a pending set without write, unlink or methods
`dx` · S4 · **fixed**: `browse(ids)` is a full recordset: `write`, `unlink`, methods without a load.

`env.model('res.partner').browse([id]).write(...)` does not type-check; every test writes `(await browse([id]).load()).write(...)`.

**Proposal:** `browse()` returns a recordset with the ids (no values) whose writes and methods work without a load.

### #15 — Reading a stored compute between a write and a flush throws
`dx` · S4

Deliberate (RFC 0008 §11.3: no stale values), but scripts trip on it: after `line.write({ priceUnit })`,
`order.amountTotal` throws "pending recompute" until `env.flush()` or `load()`.

**Proposal:** recompute on read of a pending stored field (one batched recompute, like Odoo's lazy compute), keeping
the throw as an opt-in strict mode.

### #16 — Running the CLI on TypeScript sources needs a loader
`dx` · S3 · **fixed**: the CLI registers a `.js` → `.ts` resolve hook (`ts-sources.test.ts` spawns the built CLI).

The CLI imports module files at runtime; `./x.js` specifiers between `.ts` files (the `nodenext` convention) fail under
Node's type stripping. The demo uses `.ts` specifiers and `allowImportingTsExtensions` instead.

**Proposal:** document one blessed setup, or have the CLI register a resolver for `.js → .ts`.

### #17 — Generated type-view goldens churn on unrelated changes
`dx` · S4 · **fixed**: the hash covers field types, origins and transitions only.

The definitions hash covers the whole `describe()` output; adding metadata to `describe()` (encrypted, groups shape,
checkCompany) changed every generated file three times. 

**Proposal:** hash only what the generated types depend on.

### #18 — Transitions added by extensions are untyped
`types` · S3 · **fixed**: the view's `<Model>Methods` interface lists every transition, extensions' included.

`transitionsAdd: { hold, resume }` creates `order.hold()`, but no type carries it; callers cast.

**Proposal:** the generator emits added transitions as `(): Promise<void>` members of the view's `methods`.

### #19 — Default deny makes prototypes and fixtures verbose
`dx` `security` · S4 · **fixed** (`bootstrap.integration.test.ts`)

*Resolution:* `security: { enforce: 'warn', onDenied? }` reports each missing ACL / field grant once and allows it;
record rules still apply; refused when `NODE_ENV=production`.

Every model needs `access` before anyone can use it; the engine's own non-security fixtures run with
`security: { enforce: false }`.

**Proposal:** `enforce: 'warn'` for development (log the access that would be denied, allow it), never for production.

### #20 — `copy()` does not take x2many commands
`api` · S4

Bulk imports of documents with lines need two passes (headers, then lines with parent ids).

**Proposal:** accept `create` commands and COPY the children after the parents.

### #21 — Standard sequences need a pool of at least two connections
`dx` · S4 · **fixed**: `createShutro` throws `InvalidSequenceError` naming the sequences when `driver.max` is 1.

The non-blocking counter runs in an autonomous transaction on the pool; with `max: 1` it waits for the connection the
business transaction holds.

**Proposal:** detect `max: 1` at `createShutro` and fail fast with a hint (or fall back to in-transaction allocation).

### #22 — Partitioned models cannot be referenced
`api` · S4

A many2one into a partitioned model is a build error (the FK would need the partition key).

**Proposal:** allow references without a database foreign key (`f.many2one(target, { foreignKey: false })`), checked by
the ORM.
