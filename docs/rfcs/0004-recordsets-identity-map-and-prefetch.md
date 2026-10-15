# RFC 0004 — Recordsets, identity map & batched prefetch

- **Status:** Accepted (2026-10-14)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** 0001, 0002, 0003
- **Related:** 0005 (queries issued by loads and flushes), compute-engine RFC (Phase 3), security RFC (rule checks at flush)

---

## 1. Summary

A **recordset** is an immutable, ordered set of records of one model, bound to an `Env` (RFC 0003). Every ORM operation
works on recordsets (`CLAUDE.md` principle 5).

Each transaction scope owns an **identity map + cache**: one entry per `(model, id)`, with field values and dirty state.
Reading data is **explicitly asynchronous and batched**: `await orders.load({ partner: ['name'], lines: { product: true } })`.
After that, field access is **synchronous and typed**.

Recordsets track their **loaded shape in the type system**. Reading a field that wasn't loaded is a compile error whose
message says which `load()` call is missing.

Loads use **Odoo-style prefetch groups**. Loading a relation for one record loads it for every record in the same group.
So even a naive `for … await o.lines.load()` loop costs one query, not N.

Writes go into a **unit of work** and are flushed in set-based statements (one `UPDATE … FROM unnest(...)` per model and
field set). Record rules are enforced in the same statement.

---

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | **No N+1, by construction.** The number of queries depends on the shape of the access, never on the number of records. Verified by query-count assertions. |
| R2  | **Batch-first API.** Compute, constraints and methods get sets. Per-record code (a loop) must still be efficient. |
| R3  | **Typed reads.** Accessing a field returns its exact type (RFC 0001 faces) without casts. |
| R4  | **One identity per `(model, id)` per transaction.** Two paths to the same record see the same values, including uncommitted writes. |
| R5  | **Efficient writes.** Writing many records issues few statements, and ordering respects foreign keys. |
| R6  | **Cache correctness:** consistent with the database snapshot, savepoint rollbacks, raw SQL and DB-side computed columns. |
| R7  | **Bounded memory** for large jobs (posting 200k journal items, recomputing stock valuation). |
| R8  | **Security at the data layer:** writes and deletes must not bypass record rules, even in bulk. |
| R9  | **Plain-data output** for APIs and Kosh (`read()` returns serializable objects). |

---

## 3. How Odoo does it

```python
orders = env['sale.order'].search([('state', '=', 'sale')])   # one query: ids only
for order in orders:                     # recordset of 1 per iteration, sharing the prefetch set of `orders`
    print(order.partner_id.name)         # 1st access: fetch stored columns of sale_order for *all* ids (≤1000);
                                          # then fetch res_partner for all partner ids of the prefetch set
    order.write({'note': 'x'})           # cache + "towrite"; flushed later in grouped UPDATEs
```

- **Lazy, synchronous field access.** The descriptor `__get__` checks `env.cache` and, on a miss, calls
  `_fetch_field`, which prefetches all prefetchable columns for every id in `_prefetch_ids`.
- Relational values propagate prefetch sets, so `order.partner_id` shares a group with the other orders' partners.
- `PREFETCH_MAX = 1000` ids per query.
- Writes are cached and flushed by `flush_model` / `flush_recordset` before searches that use the dirty fields, and before commit.
- `env.cache` is per cursor. Raw SQL writes require manual `invalidate_model()` / `invalidate_recordset()`.

### Weaknesses

| #  | Weakness | Consequence |
| -- | -------- | ----------- |
| W1 | **Implicit, heuristic prefetch.** Whether a loop is N+1 depends on how the recordset was built (`browse(id)` in a loop has no prefetch set, and `with_context()` resets the prefetch in some versions). | Hidden performance cliffs that pass in tests with 5 records and collapse at 50k. |
| W2 | **Over-fetching.** The first access to any field loads every stored column, including large text and HTML columns. | Wide-table queries for reports that need two columns. |
| W3 | **Raw SQL silently desynchronizes the cache** unless you invalidate it manually. | Stale reads after `cr.execute("UPDATE …")`, a classic Odoo bug. |
| W4 | **Unbounded cache growth** in long transactions. Developers have to call `invalidate_all()` by hand. | Memory blow-ups in imports and crons. |
| W5 | **Record-rule checks on write are separate queries**, run per call, before the write. | Extra round-trips. Time-of-check/time-of-use differences under concurrency. |
| W6 | **Untyped access.** Nothing tells you that `order.partner_id.country_id.code` costs three queries in a cold loop. | Performance only shows up in profiling. |

The good part is worth keeping: recordset-level batching *with prefetch groups* is the best N+1 defence any ORM has,
because naive per-record code is efficient most of the time.

---

## 4. Prior art

| ORM | Loading model | Identity map / UoW | Lessons |
| --- | ------------- | ------------------ | ------- |
| **Prisma** | Explicit `include` / `select` per query. `relationLoadStrategy: 'join'` (JSON aggregation in one SQL) or `'query'` (one query per relation). Batches `findUnique` calls issued in the same tick (dataloader style). | No identity map, no UoW. Every query returns fresh plain objects. | ✅ The loaded shape is part of the result type. That's the typed-load idea Shutro adopts. ❌ No shared identity: the same partner fetched twice gives two objects with possibly different data. |
| **Drizzle** | Relational queries `findMany({ with: { lines: { with: { product: true } } } })`, compiled to one SQL with lateral JSON aggregation. | None. | ✅ Typed nested shapes. ⚠️ One giant query is great for a page of 50 orders but bad for 50k (JSON building, memory, plan quality). |
| **Kysely** | Fully explicit (`jsonArrayFrom`, `jsonObjectFrom` helpers). | None. | ✅ Predictable SQL. ❌ All batching is manual. |
| **MikroORM** | Identity map per EM fork. `populate: ['lines.product']` in finds. `Reference<T>` / `Collection<T>` need `await ref.load()` (or `populate`). Optional **dataloader** batching for references and collections. Unit of work computes change sets at `flush()`. | ✅ Both. | ✅ **Async `load()` on references, with dataloader batching, is the JS answer to Odoo's sync lazy loading.** ✅ The UoW flush computes minimal change sets. ⚠️ Types don't track what is loaded (`Loaded<T, 'lines'>` exists, but it's opt-in). |

The JS constraint that shapes this RFC: **property access can't be asynchronous.** Odoo's `order.partner_id.name`
silently runs SQL inside a getter. In JS, a getter can only return a Promise (`await (await order.partner).name` is
unusable) or read synchronously from data that's already loaded. So every JS design has to decide where the `await` goes.

---

## 5. Options

### Option A — Async field access everywhere

`await order.get('partner')`, `await order.partner.get('name')`. It's always correct, but it ruins compute code and
reports, and every expression needs an `await`.

### Option B — Explicit eager shapes, no identity map (Prisma / Drizzle style)

`search({ where, with: { partner: true, lines: { with: { product: true } } } })` returns plain nested objects.

### Option C — Recordsets + identity map + typed loaded shape + prefetch groups

Async `load()` (explicit, batched across prefetch groups) followed by typed synchronous access. Writes go into a unit of work.

### Trade-offs

| Criterion | A: async access | B: eager shapes | C: typed recordsets |
| --------- | --------------- | --------------- | ------------------- |
| No N+1 by construction | ⚠️ only with a dataloader | ✅ if the shape is right, ❌ for follow-up access | ✅ prefetch groups + explicit loads |
| Sync, readable compute and report code | ❌ | ✅ | ✅ after `load` |
| Typed: compile error for not-loaded data | n/a | ✅ | ✅ |
| Shared identity, uncommitted writes visible everywhere (R4) | ✅ | ❌ | ✅ |
| Unit of work, batched writes | ✅ | ❌ | ✅ |
| Naive per-record loops stay efficient | ✅ with batching | ❌ | ✅ |
| Fits Odoo mental model (recordsets, `mapped`, `filtered`) | ⚠️ | ❌ | ✅ |
| Type-system cost | Low | Medium | **High.** The loaded-shape type parameter needs care (§7.2, §11). |

---

## 6. Decision

**Option C.** Specifically:

1. `RecordSet<M, L>`, where `L` is the **loaded shape**. The default `L` after `search()` / `browse()` + `load()` is
   `Default<M>`: all stored non-binary scalar fields, many2one **ids**, and translated fields in the env language.
2. Relation navigation is **always synchronous**. It returns a recordset whose ids may still be *pending*. Field values, ids,
   `length` and iteration require that recordset to be loaded, and the type enforces this.
3. **Prefetch groups:** `load()` on any member of a group loads for the whole group (in chunks of 1000 ids).
4. **Compute functions and constraints receive recordsets that are already loaded for their `depends`.** Methods
   receive `this` with `Default<M>`.
5. **Unit of work:** `write()` updates the cache and marks fields dirty. Flushing produces set-based SQL, with record rules
   enforced in the `WHERE` clause and checked through `RETURNING`.
6. The cache is consistent with the transaction snapshot (`REPEATABLE READ`, RFC 0003). Raw non-SELECT SQL invalidates the cache unless
   the statement declares what it touches.

---

## 7. Detailed design

### 7.1 Shapes and loading

```ts
const orders = await env.model('sale.order').search({ where: { state: 'sale' }, order: ['dateOrder desc'], limit: 200 });
// RecordSet<'sale.order', Default<'sale.order'>>: 1 query, which selects the default columns, not just ids

orders.amountTotal;            // ❌ compile error: a recordset of many records has no field values; iterate or use .mapped/.sum
for (const o of orders) {
  o.name;                      // ✅ string
  o.amountTotal;               // ✅ Money
  o.partner.id;                // ✅ Id<'res.partner'> (many2one id is part of Default)
  o.partner.name;              // ❌ NotLoaded<'res.partner', 'name'>: "load it with orders.load({ partner: ['name'] })"
}

const loaded = await orders.load({
  partner: ['name', 'vat'],                                   // 1 query: res_partner WHERE id = ANY($1) (distinct partner ids)
  lines: { product: ['name', 'defaultCode'], taxes: true },   // 1 query for lines (order_id = ANY), 1 for products, 1 for taxes (+ junction)
});
for (const o of loaded) {
  o.partner.name;                                             // ✅
  for (const l of o.lines) l.product.defaultCode;             // ✅ string | null, no queries
}
```

Shape syntax:

| Load spec | Meaning |
| --------- | ------- |
| `['a', 'b']` on a model | Exactly these scalar fields (plus `id`). Used for wide tables (W2). |
| `true` | `Default<M>` for that relation. |
| `{ rel: spec }` | Nested: the relation's `Default<T>` columns **plus** the nested relations in `spec`. Only the array form narrows columns. (Amended after spike 0001: the runtime query selects default columns anyway, so the types now match.) |
| Non-stored computed fields in a spec | Their `depends` are loaded and the compute runs (batched) as part of the load. |

`load()` returns the *same* records (same identity, same group) with a widened type. Loading something already in the
cache issues **no query**, so `load()` calls are cheap to repeat defensively.

### 7.2 Type of a recordset

```ts
type RecordSet<M extends ModelName, L extends Shape<M> = Default<M>> =
  RecordSetOps<M, L> &                                  // search/filter/mapped/write/… (§7.8)
  (IsSingleton → FieldAccess<M, L>);                    // only on iteration items and ensureOne()

type FieldAccess<M, L> = {
  readonly [K in FieldsOf<M>]:
    K extends keyof L
      ? L[K] extends Shape<Target<M, K>>                  // relation, loaded with a nested shape
        ? RecordSet<Target<M, K>, L[K]>
        : Read<M>[K]                                      // scalar, RFC 0001 read face
      : IsRelation<M, K> extends true
        ? PendingSet<Target<M, K>>                        // navigable, ids pending; async ops allowed
        : NotLoaded<M, K>;                                // branded error type with a hint message
};
```

- `PendingSet<T>` supports `load()`, async methods (`await o.lines.launchStockRules()`), `write`, `unlink`, `search`
  sub-queries and `.ids()` (async). It has **no** sync field access, `length` or iteration.
- Iteration (`for…of`) yields singletons typed `Rec<M, L>` = `RecordSet<M, L>` with `FieldAccess`. As in Odoo, a
  record *is* a recordset of length 1.
- `NotLoaded<M, K>` is a branded object type. Using it as a value fails with an error that includes the hint string,
  e.g. `Type 'NotLoaded<"res.partner","name">' is not assignable to type 'string'`, where the brand's
  property names spell out the `load()` fix. A runtime `FieldNotLoadedError` backs this up for code that casts.

Type cost is controlled by:

- having the generator (RFC 0002) emit `Default<M>` and the per-model `FieldsOf`, `Target` and `Read` tables as flat
  interfaces, and
- capping nested shape depth in types at 4. Deeper shapes are typed loosely as `RecordSet<T, Default<T>>`.

A Phase 1 benchmark with an `erp-demo` schema at Odoo-like size (~300 models) decides whether this holds up (§11).

### 7.3 Prefetch groups

A **prefetch group** is the set of `(model, ids)` that are loaded together.

| Source | Group |
| ------ | ----- |
| `search()` / `browse(ids)` result | Its ids |
| Iteration item / `filter()` / slice of a recordset | Inherits the parent's group (the item `o` loads for all `orders`) |
| `o.partner` (many2one) | The distinct partner ids of the *parent group's* records |
| `o.lines` (x2many) | All lines of all records in the parent group |

The naive loop stays efficient:

```ts
for (const o of orders) {                       // 200 orders
  const lines = await o.lines.load(['subtotal']);   // iteration 1: ONE query loads lines for all 200 orders
  total = total.plus(lines.sum('subtotal'));        // iterations 2..200: cache hits, zero queries
}
```

Groups are chunked to 1000 ids per query (`WHERE id = ANY($1::bigint[])`), so the SQL text is stable regardless of list length.
A group never crosses transactions, and it's dropped when the iteration source is garbage-collected (weak references).

### 7.4 Identity map and cache

Per `TxScope` (RFC 0003):

```
IdentityMap: Map<ModelName, Map<Id, RecordState>>
RecordState {
  values:  Map<FieldKey, Value>        // FieldKey = field, or field@lang / field@company for context-dependent fields
  dirty:   Set<Field>                  // pending writes
  status:  'clean' | 'new' | 'deleted'
}
```

- **Consistency.** Under `REPEATABLE READ` the snapshot is fixed for the transaction, so other sessions' commits can't make
  the cache stale. The only staleness sources are our own raw SQL, DB triggers and generated columns, and savepoint
  rollbacks. Each one is handled:

| Source | Handling |
| ------ | -------- |
| Own ORM writes | Write-through into the cache. Dependent stored computes are marked for recompute (compute RFC). |
| `env.sql` SELECT | No effect. |
| `env.sql` INSERT / UPDATE / DELETE | **Flush everything before, invalidate the entire cache after** (safe default, fixes W3). Opt out precisely: ``env.sql({ invalidates: ['sale.order.amountTotal'] })`…` ``. |
| Columns maintained by triggers or `GENERATED ALWAYS AS` | Declared `dbComputed: true` in the field. Re-read through `RETURNING` at flush time. |
| Savepoint rollback | Restored from the savepoint journal (§7.6). |
| `READ COMMITTED` transactions (opt-in) | The cache is invalidated per statement for models marked `volatile`, and documented as weaker. |

- **Identity semantics.** `a.equals(b)` compares model and ids. `===` on recordset objects is **not** guaranteed, because
  objects are cheap views over the shared state.

### 7.5 Loading for computes, constraints and methods

The engine knows each compute's `depends` (RFC 0001 §7.9), so it loads exactly those paths for the whole batch
**before** calling it:

```ts
computeAmounts(orders): void {             // orders: RecordSet<'sale.order', LoadedFrom<['lines.subtotal', 'lines.taxAmount']>>
  for (const o of orders) o.amountUntaxed = o.lines.sum('subtotal');   // typed, no awaits, no queries
}
```

- Accessing something that isn't declared in `depends` is a compile error. This catches missing dependencies, which
  are the most common compute bug in Odoo (a stale stored value because a path was missing from `@api.depends`).
- Computes may be `async` when they need extra queries (tax engine, currency rates). Any extra loads they make are
  batched against the same group.
- Constraints get the same treatment for their `depends`.
- Methods get `this: RecordSet<M, Default<M>>`. When a method is called on a `PendingSet`, the ids and defaults are
  resolved first, in one grouped query.
- In a compute, assigning a computed field (`o.amountUntaxed = …`) is the only way to set a value with `=`. Anywhere else, field
  properties are `readonly` in the type and frozen at runtime. You write with `write()`.

### 7.6 Unit of work and flush

```ts
for (const l of lines) await l.write({ discount: '5' });        // N cache updates, 0 queries
await orders.write({ note: 'Delivered by courier' });           // cache update, 0 queries
const late = await env.model('sale.order').search({ where: { note: { like: '%courier%' } } });
// ↑ triggers a flush of sale.order (the domain reads sale.order.note): 2 UPDATEs (one per model and field set), then the SELECT
```

**Flush points:**

- before `search` / `aggregate` / `count` that reads a dirty field of the queried models (fields referenced in where, order or group)
- before any `env.sql` (everything)
- before savepoint release
- in pre-commit (RFC 0003 §7.1 step 5)
- on explicit `env.flush()`

**Statement shape.** Records are grouped by `(model, sorted dirty-field set)`. Each group produces one statement with stable text and array parameters:

```sql
UPDATE sale_order_line AS t
SET    discount = v.discount, updated_at = $3, updated_by = $4
FROM   unnest($1::bigint[], $2::numeric[]) AS v(id, discount)
WHERE  t.id = v.id
  AND  (/* write record rules for sale.order.line, compiled by RFC 0005 */)
RETURNING t.id;
```

If `RETURNING` yields fewer ids than were sent, the missing ids failed the rule (or no longer exist). The transaction
raises `AccessError` naming those records and the rule. This puts the rule check and the write in **one statement
with no check/use race** (fixes W5).

**Creates** are not deferred. `create(valsList)` runs one multi-row `INSERT … RETURNING id, <dbComputed>` immediately,
because the ids are needed right away. For example, lines that reference the order are inserted in a second statement
of the same `create` call (one `INSERT` per model, in FK order). Very large imports use the bulk API (`COPY`, Phase 5).

**Deletes:** `unlink()` marks records `deleted` and flushes immediately as `DELETE … WHERE id = ANY($1) AND <unlink rule>`.
Cascades rely on database FKs (`ON DELETE CASCADE`, RFC 0001 `ondelete`). When tracking or audit is enabled, the ids that
will cascade are collected first, so the audit trail and the cache stay correct.

**Flush ordering:** within a flush, statements run in FK topological order of models (registry-computed). Updates come before deletes.

**Optimistic concurrency (opt-in per model):** `concurrency: 'version'` adds `version integer` and `AND t.version = v.version`
to updates. A mismatch raises `StaleRecordError`. This is meant for Kosh forms edited for minutes before saving.
Short server-side transactions rely on `REPEATABLE READ` instead.

**Savepoints:** every cache mutation after a savepoint is recorded in a journal (previous value). Rollback to the savepoint
replays the journal in reverse, and release discards it. Memory is proportional to the changes, not to the cache.

### 7.7 Memory

- The cache is per transaction, so it's freed at commit.
- `env.evict(records)` drops clean entries. Dirty entries can't be evicted until flushed.
- `model.stream(query, { batch: 2000 })` iterates with a server-side cursor (PostgreSQL `DECLARE … CURSOR` inside the
  transaction) and evicts clean records after each batch.
- `shutro.forEachChunk` (RFC 0003 §7.5) runs a fresh transaction per chunk.
- In development, a warning is logged when a scope's cache exceeds 100k records, with a hint to use `stream` or `forEachChunk` (fixes W4).

### 7.8 Recordset API (overview)

| Category | Methods |
| -------- | ------- |
| Query | `search(q)`, `searchCount(q)`, `browse(ids)`, `exists()`, `aggregate(q)` (RFC 0005), `stream(q, opts)` |
| Loading | `load(spec)`, `ids` (sync if resolved), `length`, `isEmpty()`, `ensureOne()`, `first()` (singleton or throws on empty) |
| Set algebra (ordered, deduplicated, same model) | `union(...)`, `intersect(...)`, `minus(...)`, `concat(...)` (keeps duplicates) |
| Functional | `filter(pred \| domain)`, `map(fn) → T[]`, `mapped('lines')` → `RecordSet`, `mapped('name')` → `string[]`, `sortedBy(key \| fn, dir)`, `groupBy(key) → Map<…, RecordSet>`, `sum('field')` → `Money` / `Decimal` / `Quantity` (RFC 0006, currency-checked), `minDate`, `maxDate` |
| Writes | `create(valsList, opts)`, `write(vals)`, `unlink()`, `copy(overrides)`, `lockForUpdate({ nowait?, skipLocked? })` |
| Env | `env`, `withEnv(env)`, `withCompany(c)`, `withLang(l)`, `withFlags(f)` (shorthands for the RFC 0003 derivations) |
| Output | `read(fields)` → `Array<Plain<M, F>>` (ids, `Money` as `{ amount: string; currency: string }`, dates as ISO strings), `toJSON()` |

`filter(domain)` evaluates the **same domain** that RFC 0005 compiles to SQL, in memory, against loaded data. Its semantics
are specified once and checked by property tests, SQL vs memory (RFC 0005 §7.9).

### 7.9 Verifying "no N+1"

```ts
import { expectQueries } from '@shutro/testing';

test('printing 500 invoices costs a constant number of queries', withTestEnv(…, async (env) => {
  await factories.invoices(env, 500, { linesPerInvoice: 10 });
  await expectQueries(env, async () => {
    const moves = await env.model('account.move').search({ where: { moveType: 'out_invoice' } });
    await moves.load({ partner: ['name', 'vat'], lines: { account: ['code'], taxes: ['name'] }, currency: true });
  }).toBe(6);   // moves, partners, lines, accounts, tax junction + taxes, currencies; independent of 500
}));
```

Each `examples/erp-demo` integration test asserts a query count (`CLAUDE.md` definition of done).

---

## 8. Type-level guarantees

```ts
const orders = await env.model('sale.order').search({});
for (const o of orders) {
  o.partner.name;                 // ❌ NotLoaded<'res.partner', 'name'>
  o.lines.length;                 // ❌ PendingSet has no sync length
  o.amountTotal = money;          // ❌ readonly outside a compute
}
const l = await orders.load({ partner: ['name'] });
expectTypeOf(l.first().partner.name).toEqualTypeOf<string>();
expectTypeOf(l.first().partner.vat).toMatchTypeOf<NotLoaded<'res.partner', 'vat'>>();   // only ['name'] was requested

await orders.load({ partnr: true });                 // ❌ unknown field
await orders.load({ lines: { product: ['nam'] } });  // ❌ unknown field
orders.sum('state');                                 // ❌ not a numeric/monetary field
```

---

## 9. Runtime metadata

- `env.stats()` (dev and test): queries executed, rows loaded, cache size, flush count. `expectQueries` and
  `shutro inspect --scope` use it.
- `registry.describe(model).prefetch`: the default shape and which fields are excluded (binary, `prefetch: false`).
- Query tagging: every ORM-generated statement carries a SQL comment (`/* shutro:load sale.order.lines */`, configurable),
  so `pg_stat_statements` and slow-query logs point back to the ORM operation.

---

## 10. Interactions

- **0003:** the scope owns the identity map, savepoint journals, flush in pre-commit, and the per-scope mutex.
- **0005:** load, search, flush and rule predicates are compiled by the SQL layer. Domain semantics are shared with `filter()`.
- **0006:** `sum()` on monetary fields checks currency consistency, and `read()` serializes `Money`.
- **Compute engine:** depends-driven loading (§7.5), plus marking stored computes dirty when their dependencies are written.
- **Security:** read rules are injected into load queries (records you can't read are omitted, and the group behaves as if
  they didn't exist). Write and unlink rules are enforced inside flush statements (§7.6).

---

## 11. Resolved questions

Resolved on 2026-10-14. The original questions are kept below for context.

| # | Resolution |
| - | ---------- |
| 1 | **Measured, and the full design is kept.** [Spike 0001](../spikes/0001-recordset-type-cost.md): full nested tracking costs 0.62 s for a 300-model project on TS 7 (1.16 s with Odoo-sized models) and 1.7–3.6 ms per usage function. All criteria pass. The top-level-only fallback stays documented but is not used. |
| 2 | **`search()` selects `Default<M>`**, with `search(q, { load: [...] })` and `search(q, { load: false })` to narrow it. |
| 3 | **No deferred creates in v1.** `create()` inserts immediately in one multi-row statement. |

**Original questions:**

1. **Type-system budget.** The `L` parameter is the most expensive type in the system. If the Phase 1 benchmark shows
   unacceptable editor latency on ~300 models, the fallback is to track only *top-level* loaded fields in types and make nested
   relation access runtime-checked. Is that acceptable as a fallback?
2. **`search()` default selection.** Selecting `Default<M>` (all scalar columns) makes iteration immediately useful, but
   reads wider rows than `SELECT id`. Odoo fetches ids first and columns on first access. Proposal: default columns, with
   `search(q, { load: ['name'] })` and `search(q, { load: false })` (ids only) to narrow.
3. **Deferred creates.** Should `create()` be buffered until flush (allocating ids with `nextval` in batches), so that many
   single creates in a loop become one INSERT? This makes identities available without a round-trip, but complicates
   triggers and `RETURNING` of DB-computed columns.

## 12. Deferred

- Compute and recompute scheduling, onchange: compute-engine RFC.
- Bulk import through `COPY` and partition-aware writes: Phase 5.
- Cross-transaction caches (registry-level caches for configuration models like taxes and currencies): a separate RFC, because they need invalidation through LISTEN/NOTIFY.

---

## Implementation notes (2026-10-14, recordsets: reads)

`packages/core/src/recordset/`. Where the implementation refines this RFC:

1. **Schema typing without the generator.** `defineModule` / `buildRegistry` are generic, so a registry's type is the
   schema view of its module tree and `createShutro({ registry })` types `env.model()`. The recursion is guarded against
   the wide `Module` type (fixtures that return plain `Module` contribute no model types). `shutro generate` will emit
   the same view (RFC 0002), which also removes the recursion cost for large applications.
2. **Loaded shapes are exactly spike 0001's `full` design**, including the amendment that a nested object spec loads the
   relation's defaults. A list spec loads exactly the listed keys plus `id`; on an already-loaded relation it merges.
3. **`search()` selects the defaults** (Q2 resolved) in one query: stored, non-binary, non-x2many fields.
4. **Value objects are cached per transaction:** `res.currency` and `uom.uom` records are loaded through the identity map
   the first time a monetary / quantity field needs them, so `Money` / `Quantity` never cost a query per record. The
   sibling currency / uom field is added to every load that includes a monetary / quantity field.
5. **A pending x2many set remembers its own parent and its prefetch group separately**, so `o.lines.load()` inside a loop
   fetches for the whole group but returns only `o`'s lines (a bug the N+1 test caught).
6. **Missing ids** on `load()` raise `MissingRecordError` rather than yielding empty values.
7. **`bigint` fields read as safe numbers** (the driver guards overflow), matching ids.
8. **Not yet:** writes (`create` / `write` / `unlink`, the unit of work, record-rule-enforcing flushes), non-stored computes
   on read, `stream()`, `exists()`, `sum()` on monetary fields, `withEnv`, and the full domain compiler.

## Implementation notes (2026-10-15, recordsets: writes)

`packages/core/src/recordset/writes.ts`. Where the implementation refines §7.6:

1. **Creates are immediate** (Q3 resolved) as one `INSERT … SELECT FROM unnest($1::t1[], …) RETURNING id` per model: stable
   text for any row count, one parameter per column, ids in input order (spike 0002 K7). Created records are cached in
   full, so reading them costs nothing.
2. **The flush groups dirty records by (model, sorted field set)** and emits `UPDATE … FROM unnest(…) AS v(id, …)`, with
   `updated_at` / `updated_by_id` in the same statement and `RETURNING` to verify the row count.
3. **Flush points:** before a `search()` on the model, before `env.sql`, before an x2many relation fetch of the target
   model (re-pointed children), before savepoint release, and pre-commit. Reads of cached fields never need a flush.
4. **Savepoint journal** (§7.6): value changes (with the previous dirty state), creations and deletions are undone in
   reverse on rollback; on release the entries merge into the parent savepoint's journal.
5. **x2many commands** run immediately: one2many through child creates / writes / unlinks (the inverse is set by the
   ORM; `unlink` / `clear` / `set` need a nullable inverse), many2many through junction-table statements
   (`ON CONFLICT DO NOTHING` on link). After a command the parent's cached child list is updated or invalidated.
6. **Binding inside arrays:** `Date` values are bound as ISO strings and `json` as text, because postgres.js would
   otherwise type the array parameter as a scalar and defeat the `::type[]` cast.
7. **Record rules on flush (§7.6), computes, constraints and sequences** are not implemented yet; a required field with
   a `sequence` must be given explicitly until the sequence package exists.

## Implementation notes (2026-10-15, computes)

RFC 0008 lands §7.4 "dependent stored computes are marked for recompute", §7.5 depends-driven loading (`dependsSpec`)
and the compute assignment protocol. Two runtime fixes came with it: an x2many sub-spec is now loaded for children
whose list was cached by a command (`fetchX2Many` calls `fetchMissing` for every child), and `fetchMissing` always
ensures the currency / unit value objects, even when every column was already cached.

## Implementation notes (2026-10-15, methods on recordsets)

With RFC 0010, model methods (declared ones and generated transitions) are installed on the per-model record class and
typed on recordsets: `RecordSet<S, M, L>` is `RecordSetApi<S, M, L> & MethodsOf<S, M>`. Every recordset is now created
through that class, so `orders.confirm()` works on search results, loaded sets and singletons alike (§7.5 "methods get
`this: RecordSet`").
