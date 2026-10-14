# RFC 0005 — Query builder & SQL compiler

- **Status:** Accepted (2026-10-14)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** 0001, 0002, 0003
- **Related:** 0004 (loads, flushes, in-memory `filter`), 0006 (monetary aggregation), security RFC (record rules)

---

## 1. Summary

There are three layers, and all of them compile to **one SQL AST**. The AST is rendered to **parameterized** SQL with stable
text, so plans and prepared statements get reused.

1. **Domains** (model level). Typed, **JSON-serializable** filters over model fields with relation paths:
   `{ partner: { country: { code: 'BD' } }, state: { in: ['sale'] } }`. They're used by `search`, `aggregate`, record
   rules, saved filters and Kosh. The compiler injects company, active and record-rule filters automatically.
2. **The typed SQL builder** (`@shutro/sql`). A Kysely-style builder over tables and columns from the generated schema,
   meant for reports and complex queries (CTEs, window functions, `GROUPING SETS`, `LATERAL`).
3. **The `sql` tagged template.** The only raw-SQL escape hatch. Interpolated values are always parameters, and
   identifiers go through `sql.id()`.

Security by default: the model layer always applies rules. Layers 2 and 3 run without rules **only** in an `su`
environment, or when every model table in the AST has been explicitly passed through `.withRules()`. The compiler can
check that because Shutro owns the AST.

---

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | **Typed filters** on fields and relation paths (`partner.country.code`), with operators valid for each field type. |
| R2  | **Serializable filters.** Record rules, saved searches, dashboard filters and action domains are stored in the database and sent over APIs. |
| R3  | **Automatic scoping:** multi-company (`company IN env.companies`), archived records (`active`), record rules, and translations (JSONB by language). |
| R4  | **Reporting power:** group by with date granularity, multiple measures, `ROLLUP` / `GROUPING SETS`, `HAVING`, window functions. Currency-safe sums (RFC 0006). |
| R5  | **Zero injection surface.** Values are always parameters. Identifiers come only from registry metadata or validated `sql.id()`. |
| R6  | **Stable SQL text** for plan caching and `pg_stat_statements` (`= ANY($1)` instead of `IN ($1,$2,…)`). |
| R7  | **Hierarchies:** `childOf` / `parentOf` for accounts, product categories, locations and partners. |
| R8  | **Relational semantics without row duplication:** filtering orders by a line condition must not duplicate orders. |
| R9  | **The same semantics in SQL and in memory** (`recordset.filter(domain)`, onchange, Kosh client previews). |
| R10 | **Pagination** (offset and keyset), locking (`FOR UPDATE SKIP LOCKED` for job queues and stock reservation). |

---

## 3. How Odoo does it

```python
orders = env['sale.order'].search(
    ['|', ('state', '=', 'sale'), '&', ('state', '=', 'draft'), ('partner_id.country_id.code', '=', 'BD'),
     ('order_line', 'any', [('product_id.type', '=', 'service')])],
    order='date_order desc', limit=80)

env['account.move.line']._read_group(
    [('parent_state', '=', 'posted')], groupby=['account_id', 'date:month'], aggregates=['balance:sum'])

self.env.cr.execute(SQL("SELECT id FROM sale_order WHERE partner_id = %s", partner.id))   # SQL wrapper, Odoo 17+
```

- **Domains** are lists in Polish (prefix) notation, with the operators `=`, `!=`, `in`, `like`, `ilike`, `=like`,
  `child_of`, `parent_of`, `any`, `not any`, …
- They're compiled by `_where_calc` into a `Query` object. Many2one paths become `LEFT JOIN`s or subqueries.
  x2many paths become `IN (SELECT …)` / `EXISTS` (newer versions).
- Record rules are domains stored in `ir.rule`, evaluated with `user`, `company_ids` and `time` in a safe-eval
  context, and `AND`ed into the query.
- `read_group` / `_read_group` handle aggregation, with date granularity, `lazy` grouping and `__count`.
- Ordering by a many2one uses the *target model's* `_order` (it joins `res_partner` to sort by name).
- Odoo 17 introduced the `SQL` class for safe composition of raw SQL.

### Weaknesses

| #  | Weakness | Consequence |
| -- | -------- | ----------- |
| W1 | **Untyped and hard to read.** Polish notation (`'|', '&', …`), stringly-typed field paths and operators. | Bugs from misplaced operators. Typos found at runtime. |
| W2 | **Record rules are Python strings evaluated with `safe_eval`.** | Hard to test and review. Rules can't be statically checked against the model. |
| W3 | **`!=` and null semantics are surprising.** `('x', '!=', v)` also matches NULL (Odoo adds `OR x IS NULL`), and `('x', '=', False)` means IS NULL. Semantics differ subtly between the SQL path and `filtered_domain`. | Off-by-one rows in reports. Behaviour differs in Python vs SQL. |
| W4 | **Ordering by many2one silently joins** the target and sorts by its `_order`. | Unexpected slow queries (sorting 1M move lines by `partner_id` sorts by partner name through a join). |
| W5 | **`read_group` is limited.** No window functions, no `GROUPING SETS` beyond what the API offers, awkward `HAVING`. | Reports fall back to raw SQL, and **raw SQL bypasses record rules and multi-company filters**, which is a frequent source of data-leak bugs in custom reports. |
| W6 | **The history of string-formatted `cr.execute`** (pre-`SQL` class) left injection-prone patterns in many modules. | Security debt. |
| W7 | **Monetary sums across currencies** are allowed in `read_group` (summing `amount_total` across BDT and USD orders). | Meaningless totals in dashboards. |

---

## 4. Prior art

| ORM | Filtering | Raw SQL | Lessons |
| --- | --------- | ------- | ------- |
| **Prisma** | Typed object filters, `where: { state: { in: [...] }, partner: { is: { country: { is: { code: 'BD' } } } }, lines: { some: { … } } }`. `groupBy` / `aggregate` are limited. | `$queryRaw` tagged template, `TypedSQL` (`.sql` files with generated types). | ✅ **Object filters are typed *and* serializable.** ✅ `some` / `every` / `none` for to-many semantics. ❌ Weak aggregation. |
| **Drizzle** | SQL-shaped builder: `where(and(eq(o.state, 'sale'), inArray(...)))`. | `sql` template everywhere, composable fragments. | ✅ Very close to SQL. ✅ The `sql` template is ergonomic. ❌ Filters are code, not data, so they can't be stored as record rules. |
| **Kysely** | The most thoroughly typed SQL builder: `selectFrom('sale_order as so').innerJoin(...).where('so.state', '=', 'sale')`. Expression builder. | `sql` template, `sql.ref`, `sql.id`. | ✅ **The model for layer 2:** typed tables and aliases, `compile()` → `{ sql, parameters }`, an immutable builder, an AST operation-node tree, plugins. ⚠️ General-purpose and multi-dialect, so it doesn't know about record rules. |
| **MikroORM** | Mongo-like `FilterQuery`: `{ $or: [{ state: 'sale' }], partner: { country: { code: 'BD' } } }`. QueryBuilder. **Global filters** (`@Filter({ name: 'tenant', cond: … })`) are applied automatically. | `em.execute`, `raw()`. | ✅ **Global filters**, which is the idea behind automatic company and active scoping. ✅ Serializable object filters. |

**Build vs depend.** Using Kysely directly as layer 2 was considered. It's rejected for v1 for three reasons:

1. Shutro needs to *inspect* every AST, to find model tables for the rule check (§7.7), and that's internal API in Kysely.
2. It's PostgreSQL-only, and Kysely's dialect abstraction is cost without benefit here.
3. `CLAUDE.md` says to minimize dependencies.

Shutro's builder API deliberately mirrors Kysely's naming, so Kysely users feel at home.

---

## 5. Options

### Option A — Odoo-style domain arrays, with types

`[['state', '=', 'sale'], '|', …]`, typed through tuple templates. It's familiar to Odoo developers, but types over
Polish notation are brittle and the notation is still hard to read.

### Option B — A single SQL-shaped builder for everything (Drizzle / Kysely style)

Powerful, but filters become code. Record rules and saved filters can't be stored, and automatic scoping has to be
reconstructed from arbitrary SQL.

### Option C — Layered

Serializable **domain objects** at the model level, a **typed SQL builder** for reports, and the **`sql` template** for
escapes. All three share one AST, which allows a single rule-enforcement and rendering pipeline.

### Trade-offs

| Criterion | A | B | C |
| --------- | - | - | - |
| Readability | ❌ | ✅ | ✅ |
| Serializable (rules, saved filters, API) | ✅ | ❌ | ✅ (domains) |
| Reporting power (window functions, grouping sets, CTEs) | ❌ | ✅ | ✅ (layer 2) |
| Automatic company, active and rule scoping | ✅ | ⚠️ hard | ✅ model layer, plus AST-checked enforcement in layer 2 |
| Same semantics in memory | ✅ | ❌ | ✅ (domains only) |
| Implementation cost | Medium | Medium | **High.** Two front-ends, one AST, one renderer. |

---

## 6. Decision

**Option C.**

- **Domains** are plain JSON-compatible objects with typed construction, **two-valued null semantics** specified once
  (§7.3), relation operators `any` / `all` / `none`, and hierarchical operators.
- The model-level compiler **always** injects scoping: company, active, read rules, and the translation language.
- The SQL builder and the `sql` template share the AST. Running them in a non-`su` env requires every model table to be
  scoped with `.withRules(alias)`. Otherwise the query fails with `UnscopedQueryError` before it reaches the database (fixes W5).
- Rendering: `$n` parameters, `= ANY($n)` for lists, and a cache of normalized SQL text keyed by AST shape.

---

## 7. Detailed design

### 7.1 Domains

```ts
// Customers in Bangladesh, or confirmed orders, that contain at least one service line, over 10,000 BDT
const orders = await env.model('sale.order').search({
  where: {
    or: [
      { partner: { country: { code: 'BD' } } },
      { state: 'sale' },                                      // shorthand for { eq: 'sale' }
    ],
    lines: { any: { product: { type: 'service' } } },         // EXISTS, never a row-multiplying join (R8)
    amountTotal: { gte: '10000' },                            // monetary vs Decimal-string literal: compared in the record's own currency
    dateOrder: { gte: Instant.parse('2026-01-01T00:00:00+06:00') },
  },
  order: [['dateOrder', 'desc'], ['id', 'desc']],
  limit: 80,
});
```

**Grammar** (the TypeScript type `Domain<M>` is generated per model):

```
Domain<M>     := { [field]: Condition<M, field> } & { and?: Domain<M>[]; or?: Domain<M>[]; not?: Domain<M> }
Condition     := Literal                                   // eq shorthand
               | { eq | ne | lt | lte | gt | gte: Literal }
               | { in | notIn: Literal[] }
               | { isNull: boolean }
               | { like | ilike | notLike | notIlike: string }       // char/text
               | { childOf | parentOf: Id[] }                          // hierarchical models (parent_path)
               | Domain<Target>                                       // many2one: nested condition on the target
               | { any | all | none: Domain<Target> }                // x2many
               | { search: string }                                   // full text / trigram on indexed char fields
Literal       := field read type (RFC 0001), Decimal-string for decimals, Id<T> for relations,
                 or a Param: { $param: 'name' } | { $env: 'uid' | 'company' | 'companies' | 'today' | 'now' }
```

- Keys inside one object are combined with **AND**. `or` / `and` / `not` are explicit, which avoids Polish notation (fixes W1).
- Operators are typed per field kind: `like` only on char/text, `lt` only on ordered types, `childOf` only on models with `hierarchy: true`.
- **`$env` placeholders** make domains storable *and* environment-dependent. That's how record rules and saved filters reference
  "current user" or "allowed companies" without code (fixes W2):

```ts
// security rule (security RFC), stored as data and typed when declared in code
rules: {
  salesmanOwnOrders: { groups: ['sale.group_salesman'], perm: ['read', 'write'],
                       domain: { or: [{ user: { $env: 'uid' } }, { user: { isNull: true } }] } },
}
```

### 7.2 Typed construction helpers (optional sugar)

The object form *is* the API. A typed builder exists for conditional composition:

```ts
import { d } from '@shutro/core';
const domain = d.and<'sale.order'>(
  { state: { in: ['sale', 'done'] } },
  filters.country ? { partner: { country: { code: filters.country } } } : d.true,
  filters.minAmount ? { amountTotal: { gte: filters.minAmount } } : d.true,
);
```

`d.true` and `d.false` are identity and absorbing elements, and they're simplified away at compile time.

### 7.3 Semantics (identical in SQL and memory)

| Domain | Meaning | SQL emitted |
| ------ | ------- | ----------- |
| `{ x: v }` | x equals v (null never equals) | `x = $1` |
| `{ x: null }` | not allowed, use `isNull` | — (type error) |
| `{ x: { ne: v } }` | **x is distinct from v (includes null)** | `x IS DISTINCT FROM $1` |
| `{ x: { in: [] } }` | false | `FALSE` |
| `{ x: { notIn: [a] } }` | x not in list, **includes null** | `NOT (x = ANY($1)) OR x IS NULL`, simplified to `x IS NULL OR x <> ALL($1)` |
| `{ m2o: { name: 'A' } }` | the related record exists and its name = 'A' | `LEFT JOIN res_partner p1 ON …` + `p1.name = $1` (one join per distinct path) |
| `{ m2o: { isNull: true } }` | no related record | `t.partner_id IS NULL` (no join) |
| `{ lines: { any: D } }` | at least one line matches D | `EXISTS (SELECT 1 FROM sale_order_line l WHERE l.order_id = t.id AND D)` |
| `{ lines: { all: D } }` | every line matches D (true when there are no lines) | `NOT EXISTS (… AND NOT D)` |
| `{ lines: { none: D } }` | no line matches D | `NOT EXISTS (… AND D)` |
| `{ categ: { childOf: [id] } }` | id or any descendant | `t.categ_id IN (SELECT id FROM product_category WHERE parent_path LIKE $1 \|\| '%')` (parent_path materialized as in Odoo) |
| translated `{ name: { ilike: 'mouse' } }` | match in env lang, falling back to `en_US` | `COALESCE(t.name->>$lang, t.name->>'en_US') ILIKE $1` |

Writing `{ x: { ne: v } }` therefore behaves like a business user expects: "everything except v", including empty. The
in-memory evaluator implements exactly this table. Property tests generate random domains and data and assert
`sql(domain) == memory(domain)` (§7.9).

### 7.4 Automatic scoping (model level)

For `search`, `aggregate`, `load` and flush `WHERE` clauses, the compiler `AND`s these onto the user's domain, in this order:

1. **active**: `t.active` when the model is `archivable` and `env.flags.activeTest`. It's skipped if the domain mentions `active` itself.
2. **company**: `t.company_id = ANY($companies) OR t.company_id IS NULL` (nullable `companyScoped`), or `= ANY(...)` (required).
   This is skipped only under `su` with `withFlags({ checkCompany: false })`.
3. **record rules** for the operation (`read` / `write` / `unlink`): group rules are OR-ed together, and global rules are AND-ed (security RFC).
   Skipped under `su`.
4. **translation projection:** translated columns are selected as `COALESCE(col->>$lang, col->>'en_US')`.

All four are visible in the AST and in `shutro inspect --sql`, so nothing is hidden.

### 7.5 Ordering and pagination

- `order` takes field paths: `[['partner.name', 'asc'], ['id', 'asc']]`. Ordering by a many2one **without a sub-field orders by the
  id**. Joining to sort by name is explicit (`'partner.name'`), which removes surprise joins (fixes W4).
- `nulls: 'first' | 'last'` per key. The default follows PostgreSQL (`NULLS LAST` for ASC).
- Every ordered query gets a final `id` tiebreaker (deterministic pagination).
- Keyset pagination: `search({ order, after: cursor, limit })`, where the cursor is an opaque token of the last row's
  order-key values. `offset` is still supported.
- Locking: `search({ …, lock: { mode: 'update', skipLocked: true } })` → `FOR UPDATE OF t SKIP LOCKED`.

### 7.6 Aggregation (reporting at model level)

```ts
const rows = await env.model('account.move.line').aggregate({
  where: { move: { state: 'posted' }, date: { gte: CalendarDate.of(2026, 1, 1) } },
  groupBy: ['account', { field: 'date', granularity: 'month' }, 'companyCurrency'],
  measures: { balance: { sum: 'balance' }, debit: { sum: 'debit' }, lines: { count: true } },
  groupingSets: [['account', 'date:month', 'companyCurrency'], ['account', 'companyCurrency'], ['companyCurrency']],
  having: { balance: { ne: '0' } },
  order: [['account.code', 'asc'], ['date:month', 'asc']],
});
// rows: Array<{
//   account: Rec<'account.account', { id; code; name }> | null;   // null in rolled-up rows
//   'date:month': CalendarDate | null;
//   companyCurrency: Rec<'res.currency', { id; name }> | null;
//   balance: Money; debit: Money; lines: number;
//   grouping: { account: boolean; 'date:month': boolean; companyCurrency: boolean };   // from GROUPING()
// }>
```

- Granularities: `day | week | month | quarter | year`, computed in the **env time zone** for datetimes
  (`date_trunc('month', ts AT TIME ZONE $tz)`).
- **Monetary sums must group by the field's currency field** (or filter it to a single currency), so `sum` over
  `balance` without `companyCurrency` in every grouping set is a type error. At runtime it's `CurrencyMismatchError` (fixes W7, RFC 0006).
- Grouped many2one keys come back as records with their `recName` loaded in one extra query, as part of the same aggregate call.

### 7.7 The typed SQL builder (`@shutro/sql`)

This layer is for reports the domain layer can't express. Tables and columns come from the generated schema (RFC 0002),
and types follow RFC 0001 read faces (`numeric` → `Decimal`, `date` → `CalendarDate`).

```ts
// Aged receivables per partner with a running total, as a window function
const q = env.query
  .with('open_items', (db) => db
    .selectFrom('account_move_line as aml')
    .withRules('aml', 'account.move.line')             // REQUIRED in a non-su env (see below)
    .innerJoin('account_account as acc', 'acc.id', 'aml.account_id')
    .withRules('acc', 'account.account')               // every model table needs it, including joins
    .where('acc.account_type', '=', 'asset_receivable')
    .where('aml.reconciled', '=', false)
    .select(['aml.partner_id', 'aml.date_maturity', 'aml.amount_residual', 'aml.company_currency_id']))
  .selectFrom('open_items as oi')
  .select((eb) => [
    'oi.partner_id',
    eb.fn.sum<Decimal>('oi.amount_residual').filterWhere('oi.date_maturity', '<', eb.val(env.today())).as('overdue'),
    eb.fn.sum<Decimal>('oi.amount_residual').as('total'),
    // window over the grouped rows: SUM(SUM(x)) OVER (PARTITION BY currency ORDER BY partner)
    eb.fn.sum<Decimal>(eb.fn.sum('oi.amount_residual'))
      .over((w) => w.partitionBy('oi.company_currency_id').orderBy('oi.partner_id')).as('running'),
  ])
  .groupBy(['oi.partner_id', 'oi.company_currency_id']);

const rows = await q.execute();   // typed rows
q.compile();                      // { sql: 'WITH open_items AS (…) …', params: [...] }
```

Enforcement:

- Before execution, the compiler walks the AST and collects every table that belongs to a model (registry mapping
  table → model). In a non-`su` env, each such table reference must carry a `.withRules(alias, model)` marker, which
  injects §7.4 scoping for that alias. Otherwise:
  `UnscopedQueryError: table account_account (model account.account) is read without record rules. Add .withRules('acc', 'account.account'), or run the query inside env.asSuperuser({ reason }) if this report is intentionally unrestricted.`
  If the example above omitted `.withRules('acc', 'account.account')` on the join, it would fail with exactly this error.
- The window example keeps sums per `company_currency_id`. Grouping and partitioning by the currency column is what makes summing `numeric` amounts meaningful (RFC 0006 §7.7).
- Non-model tables (e.g. Postgres catalogs, user-defined materialized views registered as `view` models) follow their own rules.
- Writes through the builder (`insertInto` / `updateTable` / `deleteFrom`) on model tables are **forbidden outside `su`** in v1.
  Business writes go through recordsets, which keeps audit, compute and the cache correct (RFC 0004 §7.4).

### 7.8 The `sql` template

```ts
const rows = await env.sql<{ id: Id<'sale.order'>; total: Decimal }>`
  SELECT so.id, so.amount_total AS total
  FROM ${sql.table('sale.order')} so                 -- resolves to "sale_order", registry-validated
  WHERE so.partner_id = ${partner.id}                -- $1
    AND so.state = ANY(${['sale', 'done']})          -- $2 (text[])
    AND ${sql.rules('so', 'sale.order')}             -- rule/company/active scoping as a fragment
`;
```

- Every `${value}` is a parameter. Identifiers only come from `sql.table(model)`, `sql.column(model, field)` or `sql.id(name)`.
  `sql.id(name)` validates against `^[a-z_][a-z0-9_]*$` and quotes the name.
- There's **no** `sql.raw(string)`. `sql.unsafe(string)` exists for migrations only. It's banned by a lint rule outside
  `packages/migrate` and needs an `su` env.
- An `env.sql` query **without** `sql.rules(...)` for its model tables fails in a non-`su` env, because the template
  fragments are part of the AST (tables come from `sql.table`). Plain table names written as text are invisible to the
  checker, so the lint rule requires `sql.table()` for model tables in `env.sql`.
- Results are typed by the generic parameter, and they're runtime-checked in development against column OIDs (numeric must be `Decimal`).

### 7.9 Rendering, caching and testing

- **AST → SQL:** a single renderer quotes identifiers (`"amount_total"`), numbers parameters `$1…$n`, and emits `= ANY($n::type[])`
  for lists. Constant folding happens here (`d.true`, empty `in`).
- **Statement cache:** the normalized SQL text is keyed by the AST shape hash. With the driver's prepared statements this gives plan
  reuse. It's compatible with PgBouncer ≥ 1.21 (`max_prepared_statements`) in transaction mode. The final call belongs to the driver RFC.
- **Comments:** `/* shutro:search sale.order */` (configurable) for `pg_stat_statements` attribution.
- **Testing** (`CLAUDE.md` definition of done):
  - Property tests with fast-check: random domains over the `erp-demo` schema → (a) the compiled SQL parses and executes on
    Testcontainers PostgreSQL, (b) SQL results equal the in-memory evaluator, (c) every value appears only in `params`, never in
    `sql` text (an injection oracle: random strings containing `'; DROP …` must round-trip as parameters).
  - Snapshot tests of rendered SQL for representative domains.
  - Permission-bypass tests: an unscoped builder or `env.sql` in a non-su env must throw before any statement is sent.

---

## 8. Type-level guarantees

```ts
search({ where: { stat: 'sale' } });                          // ❌ unknown field
search({ where: { state: 'confirmed' } });                    // ❌ not in 'draft' | 'sent' | 'sale' | 'cancel'
search({ where: { name: { gt: 5 } } });                       // ❌ number vs string
search({ where: { amountTotal: { gte: 10000 } } });           // ❌ number not allowed for monetary: use '10000' or Decimal
search({ where: { partner: { country: { cod: 'BD' } } } });   // ❌ path checked through relations
search({ where: { lines: { product: { type: 'service' } } } });// ❌ x2many requires any | all | none
search({ where: { partner: { childOf: [1] } } });             // ❌ res.partner is not a hierarchy model (if not declared)
aggregate({ groupBy: ['account'], measures: { b: { sum: 'balance' } } });
                                                              // ❌ monetary sum must group by 'companyCurrency'
env.query.selectFrom('sale_ordr');                            // ❌ unknown table
```

---

## 9. Runtime metadata

- `registry.describe(model).operators`: valid operators per field, for Kosh filter UIs.
- `Domain` JSON Schema per model (generated), for API validation of saved filters.
- `shutro inspect --sql "<model>" '<domain-json>'` prints the compiled SQL and parameters, with injected scoping annotated.

---

## 10. Interactions

- **0003:** the compiler reads `env.companies`, `env.lang`, `env.tz`, `env.su` and `flags.activeTest`. `$env` placeholders resolve from the env.
- **0004:** load, flush and lock statements come from this compiler. `filter(domain)` uses the in-memory evaluator, which shares the semantics in §7.3.
- **0006:** monetary aggregation rules and `numeric` → `Decimal` parsing.
- **Security RFC:** rule domains are `Domain<M>` with `$env` placeholders, and the optional PostgreSQL RLS policies are generated from the same domains where possible.

---

## 11. Resolved questions

Resolved on 2026-10-14. The original questions are kept below for context.

| # | Resolution |
| - | ---------- |
| 1 | **`ne` / `notIn` include nulls**, as specified in §7.3, in both SQL and memory. |
| 2 | **No builder writes outside `su` in v1.** A rule-enforcing `bulkUpdate` is to be revisited in Phase 5. |
| 3 | **`pg_trgm` is the default for `search`.** `tsvector` per translated field can be added later as an opt-in. |

**Original questions:**

1. **`ne` / `notIn` including nulls.** This matches business intent and Odoo, but differs from SQL. Do you agree, given that it's
   documented and identical in memory?
2. **Writes through the SQL builder outside `su`.** Forbidden in v1. Do we need a `bulkUpdate` with rule enforcement in Phase 5 instead?
3. **Full-text search operator.** A trigram (`pg_trgm`) default for `search`, or PostgreSQL `tsvector` with language configs per translated field?

## 12. Deferred

- Materialized-view models and report models backed by SQL views (`view: sql\`…\``).
- Replica routing hints per query (driver RFC).
- The `parent_path` maintenance mechanism for hierarchy models (business-features RFC).
