# RFC 0008 — Compute engine

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/core` (`compute/graph.ts`, `recordset/compute.ts`), the registry, the unit of work
- **Related:** 0001 §7.9 (compute shape), 0002 (origins of computes), 0004 §7.4–7.6 (cache, loading, flush)
- **Resolves:** the "compute-engine RFC" deferred by 0001 and 0004

## 1. Summary

Computed fields are declared with `compute` and `depends` (RFC 0001 §7.9). This RFC fixes how they run:

1. At `buildRegistry`, every `depends` path becomes **triggers**: "when field `k` of model `A` changes, the records of
   `B` reached by walking the path backwards must recompute field `f`". Computed fields get a **rank** (dependency
   depth); a cycle between computed fields is a build error.
2. Writes, creates, deletes and x2many commands **record triggers** (cheap: a set of ids per `(model, key)`) and
   **invalidate** the cached values of dependents that are already in the cache, through the cache only.
3. **Stored** computed fields are recomputed **in batches at flush points** (before any `UPDATE`, before `search`, before
   commit) and whenever a load asks for them: triggers are resolved against the database and the cache into the exact
   affected records, computes run in rank order with their `depends` paths loaded for the whole batch, and the results
   go through the unit of work like any write.
4. **Non-stored** computed fields are computed **when loaded** (`load(['margin'])` or a nested spec), for the whole
   prefetch group, and cached per transaction until a trigger invalidates them.
5. Inside its compute, a computed field is **assignable** (`o.amountTotal = money`); anywhere else assignment is a
   runtime and a type error. `inverse` makes a computed field writable through `write()`.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Totals, balances, states derived from lines must be **always correct after a flush**, whatever path changed them (a line's price, a line moved to another order, a deleted line, a changed tax). |
| R2  | **Batch**: posting 10,000 invoices recomputes totals with a bounded number of queries, not one per record. |
| R3  | Computes never see **stale dependencies**: everything in `depends` is loaded for the batch before the call. |
| R4  | **Chains** (`line.subtotal` → `order.amountUntaxed` → `order.amountTotal`) compute each field once per flush, in order. |
| R5  | Stored results are **written with the other dirty fields** (one `UPDATE … FROM unnest` per field set), so flushes stay set-based. |
| R6  | Non-stored computes cost nothing until read, and are not recomputed on every read. |
| R7  | A compute that needs queries (tax engine, FX rates) can be `async`. |
| R8  | Savepoint rollback restores computed values with the rest of the cache. |

## 3. How Odoo does it

`@api.depends('line_ids.price_subtotal')` on `_compute_amount`. `write()` calls `modified()`, which walks the inverse
of each depends path eagerly (through the cache, or `search()` when the inverse is a many2one) and marks the dependent
records "to compute" in `env.all.tocompute`. Stored fields are recomputed in `flush()` (`_recompute_recordset` /
`_compute_field_value`), non-stored fields when read (`__get__` → `_fetch_field` → compute). Computes assign through
the field descriptor, which is protected (`env.protecting`) so the assignment is not itself a write. `inverse` is called
from `write()`.

Weaknesses: depends paths are strings (a typo is a stale field in production); `modified()` is eager and can issue a
`search()` per write; the recompute order is the order of `tocompute`, not a rank (a chain can compute a field twice);
the "to compute" marker is hidden state that makes `read()` sometimes trigger writes; computed required fields rely on
the compute running before the `NOT NULL` check, which breaks in `create()` edge cases.

## 4. Prior art

| ORM | Computed fields |
| --- | --------------- |
| Prisma | None in the schema; `$extends` adds read-only derived values at query time. No storage, no dependencies. |
| Drizzle | `generatedAlwaysAs()` maps to PostgreSQL generated columns: single-row SQL expressions only. |
| Kysely | None. |
| MikroORM | `@Formula` (SQL expression at select time) and `onCreate` / `onUpdate` hooks; no dependency tracking. |
| Django | `GeneratedField` (database generated columns); otherwise `save()` overrides, with no dependency tracking across relations. |

Nothing in the TypeScript ecosystem tracks cross-record dependencies. Database generated columns (Drizzle/Django) are
the right tool for single-row expressions and stay available (`dbComputed`, RFC 0004 §7.4); they cannot express
"the sum of my lines".

## 5. Options

### Option A — Database only (generated columns + triggers)

Totals maintained by PostgreSQL triggers written by the developer. Always consistent, but logic leaves TypeScript,
is untyped, can't call the tax engine, and migrations must manage trigger code.

### Option B — Dependency graph with deferred, batched recompute (chosen)

Triggers recorded at write time; resolution and recompute at flush points, in rank order, with batch loading.

### Option C — Eager recompute on every write

Simplest to reason about, but N writes to N lines recompute the order N times and each resolution may query.
Odoo's eagerness without Odoo's batching.

### Trade-offs

| | A | B | C |
| - | - | - | - |
| Correct after flush (R1) | ✅ | ✅ | ✅ |
| Batched (R2, R5) | ✅ (in SQL) | ✅ | ❌ |
| Typed, in TypeScript, can query (R3, R7) | ❌ | ✅ | ✅ |
| Chains computed once (R4) | ✅ | ✅ rank order | ❌ |
| Non-stored on demand (R6) | ❌ | ✅ | ✅ |

## 6. Decision

Option B. The engine lives in core; it needs no new dependency.

## 7. Detailed design

### 7.1 Graph (`buildRegistry`)

For a computed field `B.f` with `depends: ['p1.p2…pn']`, each prefix defines a trigger:

```
(model_{i-1}, p_i)  →  { field: B.f, reverse: [s_1 … s_{i-1}] }        for i = 1 … n
```

where `s_j` is the step `(model_{j-1}, p_j) → model_j`. A change of `p_i` on records of `model_{i-1}` reaches `B` by
walking the steps backwards:

| Step kind | From changed ids of `model_j` to ids of `model_{j-1}` |
| --------- | ----------------------------------------------------- |
| many2one `A.k → B` | `A` records whose `k` is in the ids: cached values, plus `SELECT id FROM a WHERE k_id = ANY($1)` when resolving for a stored field. |
| one2many `A.k → B` (inverse `B.inv`) | The `inv` values of the changed `B` records (loaded if missing). |
| many2many `A.k → B` | Cached lists containing the ids, plus a junction-table query. |

A change of the relation itself (`lines` set, a line's `order` re-pointed, a line created or deleted, a tag linked)
is a trigger on the relation key of the **parent**, for the old and the new parent. The write runtime records it from
the many2one side (every one2many whose inverse is the written field) and from x2many commands.

`displayName` without a user compute depends on `recName`.

**Rank.** `rank(f) = 1 + max(rank(g))` over computed fields `g` that any path of `f` traverses or ends at, else 0. A
cycle is a `ComputeCycleError` at build time with the chain in the message.

### 7.2 Triggers and invalidation (write time)

`write()`, `create()`, `unlink()` and x2many commands call `internals.trigger(model, key, ids)`:

- the ids are added to the **raw trigger set** `(model, key) → Set<id>` of the transaction;
- the dependents already in the cache are found **through the cache only** (no queries) and their cached value for the
  computed field is deleted. For non-stored fields that is the whole invalidation; for stored fields it guarantees that
  a read between the write and the next flush point can't return a stale value (it throws `FieldNotLoadedError` with a
  recompute hint instead).

`create()` additionally marks every stored computed field of the new records for computation directly.

### 7.3 Recompute (flush points and loads)

`recompute()` runs before `flushDirty`, hence before `search`, raw SQL, savepoint release and commit, and at the start
of any `load()` while triggers are pending. It loops until no triggers remain (bounded; `RecomputeLimitError` beyond
100 rounds, which only a compute writing its own dependency can cause):

1. Take the raw triggers; resolve each through the graph (database + cache) into `(model, field) → ids` for **stored**
   fields; merge with the records marked directly.
2. Pick the entries with the **lowest rank**; group them by compute function (one function may fill several fields);
   for each group, load the union of the fields' `depends` as one spec for all ids (RFC 0004 §7.1, batched), then call
   the compute once with the recordset.
3. Assignments inside the compute journal the previous value, update the cache, mark the field dirty and record
   triggers, so chains continue in the next round at a higher rank.
4. After the call, a required field that is still null is a `ValidationError`; a field the compute did not assign is
   set to null.

A flush that happens *during* a recompute (loads flush the target model) does not start a nested recompute.

### 7.4 Non-stored fields (load time)

`loadInto` computes, for the whole group, every requested non-stored computed key that is missing from the cache,
after fetching the stored fields. `search()` never loads them (they are not default keys); `load(['margin'])`,
`load({ lines: ['margin'] })` and a `depends` path through them do.

### 7.5 Assignment and inverse

Record accessors of computed fields have a setter. It is accepted only while the engine is computing that field
(`env` tracks the set of fields being computed); otherwise `ComputeAssignmentError` tells the caller to write the
dependencies instead. The value is normalized like a write (`Money` checked against the record's currency).

`inverse` fields are not `readonly`: `write()` stores the value (dirty when stored), then calls the inverse once with
the written records, which typically writes the dependencies. The engine does not recompute the field from a value its
own inverse just set: the triggers the inverse produces are resolved normally, and the compute runs at the next flush
point; a correct inverse makes that recompute return the same value.

### 7.6 Schema

A stored computed field's column is **nullable even when the field is required**: rows are inserted before their
computes run (R5), and required-ness is enforced by the engine after the compute (§7.3). `createTableStatements` and
`@shutro/migrate` agree on this.

### 7.7 Types

`ComputeSet<S, M, L>` / `ComputeRec<S, M, L>` are the recordset / record types inside a compute: computed keys are
writable (their type is the read value or the write value), everything else is as in `Rec`. `ComputedKeys<S, M>` lists
them. Compute functions are declared `(records: ComputeSet<Schema, 'sale.order', Loaded>) => void`; the loaded shape of
`depends` (`LoadedFrom<paths>`) is generated per module later (RFC 0002 §7.7 `paths`).

## 8. Type-level guarantees

- `o.amountTotal = x` is a type error outside a compute (`Rec` keys are readonly) and accepted in a `ComputeRec`.
- `CreateOf` / `WriteOf` exclude computed fields without inverse (RFC 0001 §7.3), include them with one.

## 9. Runtime metadata

`registry.compute` exposes the graph: `fields` (model, key, stored, rank, paths), `triggers` (model → key → dependents),
for `shutro inspect` and tests.

## 10. Interactions

- **Constraints (next RFC):** reuse `depends` loading (§7.3 step 2) and run after recompute at flush.
- **Security:** record rules filter the reverse-step queries like any search (they run as the environment's user).
- **Migrate:** adding a stored computed field needs a one-off recompute of existing rows (`shutro migrate --recompute`,
  with the CLI).

## 11. Resolved questions

1. **Eager or deferred resolution?** Deferred to flush points for stored fields (batched, one query per reverse
   many2one step per round), eager through the cache for invalidation. Odoo resolves eagerly.
2. **Why rank order instead of Odoo's insertion order?** Chains compute each field once per round (R4).
3. **Reads of a stored computed field with pending triggers** throw rather than returning a stale value; `load()` or
   `env.flush()` resolves them. Returning the stale cached value silently is what Odoo does and what RFC 0004 §7.4 forbids.

## 12. Deferred

- `related` fields (sugar over a compute with a single path) and `LoadedFrom<paths>` typing: with the generator.
- Company-dependent and context-dependent computed values.
- Recompute of existing rows on migration.
