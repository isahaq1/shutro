# RFC 0009 — Constraints and onchange

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/core` (`recordset/constraints.ts`, `recordset/onchange.ts`), `defineModel` / `extendModel`
- **Related:** 0001 §7.7 (three levels of constraints), 0004 §7.6 (flush points), 0008 (triggers, computes)
- **Resolves:** the onchange item deferred by 0001 and 0004

## 1. Summary

1. **Business constraints** (`constraints: { key: { depends, check, message } }`, RFC 0001 §7.7) run at **flush
   points, after recompute and before any `UPDATE`**, for the records whose `depends` changed since the last check,
   in one batch per constraint with the `depends` loaded. `check` returns the failing records; a non-empty result is a
   `ConstraintError` (model, constraint key, fields, failing ids, the declared message).
2. **SQL constraints** (`sqlConstraints`, foreign keys) raised by PostgreSQL during an insert, flush or delete are mapped
   to a `ConstraintViolationError` carrying the model, the constraint key, the kind (`unique`, `check`, `exclusion`,
   `foreign_key`) and the **declared message**, so a database error reads like a business one.
3. **Onchange** is the form-assist API: `env.model('sale.order').onchange({ id?, values, changed })` builds an
   in-memory **draft** (a virtual record in the cache, never written), runs the model's `onchange` handlers for the
   changed fields (cascading once per field), runs the computes of the draft and of the new child rows given as x2many
   `create` commands, and returns the values that changed plus warnings. Nothing touches the database except reads.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | A document that breaks a business rule (expiry before order date, negative stock, unbalanced journal entry) must never reach the database, whatever path wrote it. |
| R2  | Rules run in **batches** and only for records whose inputs changed: posting 10,000 invoices checks balances in a few queries. |
| R3  | Database constraint failures surface as **typed errors with the declared, user-facing message**, not as SQLSTATE strings. |
| R4  | Forms need **derived values before saving**: choosing a partner fills currency and payment terms; adding a line shows its subtotal and the new total, without creating anything. |
| R5  | Onchange must not have side effects: no sequence consumed, no row inserted, no audit entry. |
| R6  | Modules extend constraints and onchange handlers of models they depend on (RFC 0002). |

## 3. How Odoo does it

`@api.constrains('date_order', 'validity_date')` methods run right after `create()` / `write()` on the written records
and raise `ValidationError`. `_sql_constraints` are translated by `_sql_constraint_error` from `psycopg2.IntegrityError`
into a `ValidationError` with the declared message. `@api.onchange('partner_id')` methods run on a `new()` in-memory
record built from the form's values (`onchange()` RPC); they assign fields, return `warning` / `domain`, and the
result is the diff sent back to the client.

Weaknesses: constraints run per `write()` call, so a multi-step edit fails midway; `@api.onchange` methods duplicate
compute logic (Odoo 13+ moved most of it to computed fields and kept onchange for warnings), and onchange `new()`
records have subtle differences from real ones (no ids, `NewId` comparisons).

## 4. Prior art

| ORM | Validation | Form assist |
| --- | ---------- | ----------- |
| Prisma / Drizzle / Kysely | None beyond the schema; validation lives in application code (zod). | None. |
| MikroORM | Lifecycle hooks (`@BeforeCreate`), property validation; `IntegrityError` mapping by driver. | None. |
| Django | `clean()` / `validate_constraints()` run by forms and `full_clean()`, not by `save()`. | Forms are server-rendered. |
| Rails | `validates`, run on `save` per object; `ActiveRecord::RecordNotUnique` mapping. | None. |

Nothing batches validation across records or ties it to a dependency graph.

## 5. Options

### Option A — Validate in `write()` / `create()` immediately (Odoo, Rails)

Simple, but per-call and per-record: fails multi-step edits, costs a query per write for cross-record rules.

### Option B — Validate at flush points, for records whose dependencies changed (chosen)

Reuses the compute engine's triggers: cheap to record, batched, and ordered after recompute so rules see fresh
computed values. Multi-step edits inside a unit of work are validated once.

### Option C — Database only

Every rule as `CHECK` / trigger. Cross-record rules become triggers written in PL/pgSQL, outside the typed model.

### Trade-offs

| | A | B | C |
| - | - | - | - |
| Batched, only changed records (R2) | ❌ | ✅ | ✅ |
| Sees computed values | ⚠️ needs flush first | ✅ | ✅ |
| Typed, in the model (R6) | ✅ | ✅ | ❌ |
| Multi-step edits | ❌ | ✅ | ✅ |

## 6. Decision

Option B for business constraints; SQL constraints stay in PostgreSQL with error mapping (R3). Onchange runs on an
in-memory draft built with the real cache and compute engine (no "new record" special cases in computes), with the
limits in §7.4.

## 7. Detailed design

### 7.1 Business constraints

```ts
constraints: {
  validityAfterOrderDate: {
    depends: ['validityDate', 'dateOrder'],                 // same-model field keys (no paths)
    check(orders) { return orders.filter((o) => o.validityDate !== null && o.validityDate < o.dateOrder); },
    message: (bad) => `Expiry before order date on ${bad.length} order(s). Set a later expiry.`,
  },
},
```

- `depends` are **field keys of the model** (relations included: `lines` means membership changed). Dotted paths are
  rejected at `buildRegistry` (`InvalidDependsPathError`): a rule about lines belongs on the line model, or on a
  computed field the order rule depends on.
- The compute graph indexes constraints by `(model, key)`. Every trigger (write, create, delete, x2many command,
  computed assignment) marks the records for the constraints depending on that key.
- At a flush point (`search`, raw SQL, savepoint release, commit, `env.flush()`): `recompute()`, then
  `checkConstraints()`, then the `UPDATE`s. Checks are skipped during a recompute round (nested flushes caused by loads)
  and run at the outer flush.
- Per constraint: one list load of `depends` (plus sibling currency / unit fields) for all marked records, one `check`
  call with the recordset. The result is the failing records: a recordset, an array of records or ids, or `[]`.
- Failure: `ConstraintError` (`code: 'CONSTRAINT'`, `model`, `constraint`, `fields = depends`, `records`, message
  from the declaration, string or function of the failing recordset). The transaction fails as a whole.

### 7.2 SQL constraints and foreign keys

`createRecords`, `flushDirty`, `unlinkRecords` and junction writes catch the driver's `ConstraintViolationError`:

| Kind | Mapped to |
| ---- | --------- |
| `unique`, `check`, `exclusion` on a constraint named in some model's `sqlConstraints` | `ConstraintViolationError(model, key, kind, fields, declared message)` |
| `foreign_key` named `<table>_<column>_fkey` | `ConstraintViolationError(model, key = the many2one field, 'foreign_key', [field], message about the missing / still referenced record)` |
| anything else | the driver error, unchanged |

Field-level `validate` (Standard Schema) from RFC 0001 §7.7 is deferred (§12).

### 7.3 Onchange handlers

```ts
onchange: {
  partner: async (draft, env) => {
    const partner = await draft.record('partner');            // loaded many2one, or null
    if (partner === null) return;
    draft.set('currency', partner.currency.id);
    if (partner.active === false) draft.warn('This partner is archived.');
  },
},
```

- One handler per field key, keyed by the field it reacts to. `extendModel` adds handlers for other keys; the same
  key from two modules is an `ExtensionConflictError` (wrap the behaviour in a method and call it from one handler).
- `draft`: `id` (or `null`), `get(key)`, `set(key, value)` (normalized like a write; `null` allowed everywhere),
  `record(key)` (loads a many2one), `warn(message)`, `env`.
- `set` marks the key changed: its handler runs later in the same call, once per key (cascade without loops).

### 7.4 The draft

`env.model(M).onchange({ id?, values, changed })`:

1. A **virtual id** (negative, per transaction) gets a cache entry with every stored key: the record's current values
   when `id` is given (one load), else the field defaults; x2many keys get their current id lists (or `[]`).
2. `values` are applied on top. x2many values are commands: `create` rows become **virtual child records** (defaults +
   row values, inverse set to the draft), `set` / `link` ids are real records added to the list; `update`, `delete`,
   `unlink` and `clear` are ignored in drafts (the form sends the full child row, not a diff).
3. Handlers run for `changed` (cascading as in §7.3).
4. Computes run with the real engine (`computeFields`): first the computed fields of each child model for the virtual
   children, then those of the draft's model, in rank order. Paths load real records through the normal loader
   (`partner.name`, linked tags); a path through the draft's x2many reaches the virtual children.
5. The result is `{ values, warnings, children }`: `values` holds the draft's scalar and many2one fields whose plain
   value differs from the input (computed and handler-set), `children[key]` holds the plain rows of the virtual children
   (computed fields filled), `warnings` the messages in order.
6. The virtual records and anything they triggered are purged from the cache, the unit of work and the trigger sets.
   The engine's recompute and constraint checks are suspended for the duration of the call, so nested loads flush
   nothing. Nothing is written (R5).

Limits of v1: no `domain` results, no `update`/`delete` commands in drafts, computes whose paths traverse a virtual
child's many2one to further virtual rows are not materialized (real targets are loaded normally).

### 7.5 Types

`OnchangeInput<S, M>` (`id?`, `values: WriteValues<S, M>`-like partial, `changed: keys[]`), `OnchangeResult<S, M>`,
`Draft<S, M>` with `get` / `set` typed by field (`DraftValue<F>`: ids for many2one, `Decimal` for monetary / quantity,
commands for x2many, read values otherwise). Handlers are declared `(draft: Draft<Schema, 'sale.order'>, env: Env)`,
typed through the generated bindings; in the definition they take `unknown` and cast, like computes.

## 8. Type-level guarantees

- `constraints` keys are camelCase and `depends` is non-empty (`defineModel`); `depends` names fields (`buildRegistry`).
- `onchange` keys are fields of the model (`defineModel`, so extension-added fields count after the registry rebuilds
  the model).

## 9. Runtime metadata

`describe()` lists `constraints` (key, depends, message when static) and `onchange` (keys); `registry.compute.constraints(model, key)`
gives the constraints a change of `key` triggers.

## 10. Interactions

- **Compute (0008):** constraints run after recompute in the same flush; computed assignments trigger constraints too.
- **State machines (next):** transition guards are constraints scoped to a transition; they reuse `ConstraintError`.
- **Security:** record rules filter the loads a check performs; a constraint sees what the user sees.
- **Kosh:** `onchange` is the server side of form interaction; `warnings` map to form notices.

## 11. Resolved questions

1. **Why not validate in `write()`?** Multi-step edits and batching (§5).
2. **Paths in constraint `depends`?** No: the rule belongs where the data is, and computed fields carry cross-model
   values to it. This keeps resolution trivial (changed ids are the marked ids).
3. **Onchange via savepoint + real create + rollback?** Rejected: drafts are incomplete (required fields unset), so the
   insert would fail; and sequences / audit would fire (R5).

## 12. Deferred

- Field-level `validate` with Standard Schema (RFC 0001 §7.7).
- `domain` results of onchange, `update` / `delete` commands in drafts, warnings with severity / titles.
- Constraint `message` translation (with the i18n RFC).
