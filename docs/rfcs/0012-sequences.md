# RFC 0012 — Sequences

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/sequence` (definitions, format, allocation SQL), `@shutro/core` (module registration, create-time numbering, `assignNumber`)
- **Related:** 0001 §7.3 (`sequence` attribute, create face), 0003 (company, `today()`), 0010 (numbering on a transition)

## 1. Summary

Document numbers come from **sequences** declared by modules (`defineSequence({ code, prefix, padding, reset,
gapless, perCompany })`) and referenced by fields (`f.char({ sequence: 'sale.order' })`). Numbers are allocated in
**ranges** (one statement for a batch of 1,000 invoices) from one counter table, per company and per period. Two
guarantees are offered and named honestly:

- **Standard**: concurrency-safe and non-blocking; a rolled-back transaction leaves a gap. The counter is bumped in a
  short autonomous transaction.
- **Gapless**: no holes ever; the counter row is updated in the business transaction, so concurrent transactions queue
  on it until commit, and a rollback hands the number to the next one. For legally numbered documents only.

Fields fill at `create()` by default; `on: 'manual'` leaves the placeholder `'/'` until `records.assignNumber(key,
{ date })` is called (invoices are numbered when posted, not when drafted).

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Unique, readable document numbers (`SO/2026/00042`, `INV/2026/03/0007`) with yearly / monthly resets. |
| R2  | Safe under concurrency: two users confirming at once never get the same number. |
| R3  | **Gapless** numbering where tax law requires it (invoices in most jurisdictions), without pretending it is free. |
| R4  | Per company counters (each legal entity numbers its own invoices). |
| R5  | Batch creation allocates in one round trip. |
| R6  | Numbering at the right moment: on creation for orders, on posting for invoices. |

## 3. How Odoo does it

`ir.sequence` with `implementation = 'standard'` (a PostgreSQL sequence per record: non-transactional, gaps) or
`'no_gap'` (`SELECT ... FOR UPDATE` on the `ir_sequence` row, then `number_next` + 1: gapless, serializing). Prefix
and suffix with `%(year)s`-style placeholders, `use_date_range` for yearly resets through child date-range sequences.
Invoices get `'/'` as name until posted; `_compute_name` assigns the number. Odoo's design is right; what hurts is
that the standard/no_gap choice is a database row (changed in production without anyone noticing), date ranges are
extra records to administer, and numbering per batch is one query per record.

## 4. Prior art

Databases: `nextval()` sequences (gaps by design) and the "counter row + `SELECT FOR UPDATE`" idiom for gapless
numbers (the canonical answer in PostgreSQL literature). ORMs (Prisma, Drizzle, MikroORM, Rails) offer autoincrement
only; document numbering is left to applications.

## 5. Options

### Option A — PostgreSQL sequences for standard, counter row for gapless (Odoo)

Two storages and two code paths; period resets need a sequence per period created with DDL at runtime.

### Option B — One counter table; standard = autonomous short transaction, gapless = in-transaction row lock (chosen)

Same table, same statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`), different executor. Period resets are
just another key column. Batches are one statement.

### Option C — Application-generated numbers (UUIDs, timestamps)

Not readable, not gapless, not what accountants accept.

### Trade-offs

| | A | B | C |
| - | - | - | - |
| Gapless available (R3) | ✅ | ✅ | ❌ |
| Resets without DDL | ❌ | ✅ | n/a |
| One statement per batch (R5) | ❌ | ✅ | ✅ |
| Standard numbers never block | ✅ | ✅ (needs a second pooled connection) | ✅ |

## 6. Decision

Option B. The autonomous transaction for standard sequences uses the driver pool, so a pool of size 1 would deadlock
against itself: `createShutro` documents a minimum of 2 connections when standard sequences are used.

## 7. Detailed design

### 7.1 Declaration

```ts
export const sale = defineModule({
  name: 'sale',
  sequences: [defineSequence({ code: 'sale.order', prefix: 'SO/{year}/', padding: 5, reset: 'yearly' })],
  models: [SaleOrder],
});

name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),                 // filled at create()
name: f.char({ required: true, readonly: true, sequence: { code: 'account.move', on: 'manual', dateField: 'date' } }),
```

`buildRegistry` indexes sequences by code (`registry.sequences`), rejects duplicates across modules and fields that
reference an undeclared code (`UnknownSequenceError`). A field's `gapless` option, if given, must agree with the
definition.

### 7.2 Allocation

Table `shutro_sequence (code, company_id, period, next)`, primary key on the first three (`company_id` 0 for shared
counters). One statement reserves `count × step` numbers:

```sql
INSERT INTO shutro_sequence (code, company_id, period, next) VALUES ($code, $company, $period, $start + $total)
ON CONFLICT (code, company_id, period) DO UPDATE SET next = shutro_sequence.next + $total
RETURNING next - $total AS first
```

- **Gapless**: run through the scope's connection. The row lock is held until the transaction ends; a rollback
  returns the numbers. Concurrent transactions on the same counter wait in `ON CONFLICT DO UPDATE` (R2, R3).
- **Standard**: run through `driver.transaction()` on another pooled connection and committed at once. Nothing
  blocks; a later rollback of the business transaction leaves a gap.
- The table is created on first use (`CREATE TABLE IF NOT EXISTS`) through the pool, once per process.

### 7.3 Period and company

The period key comes from the document date: `dateField` of the row when declared and present, else `env.today()`.
The company is the record's `company` when the model is companyScoped, else `env.companyId`; `perCompany: false`
uses 0.

### 7.4 Numbering moments (R6)

- `on: 'create'` (default): `create()` groups the rows lacking a value by (company, period), allocates one range per
  group and formats the numbers before the `INSERT`.
- `on: 'manual'`: `create()` stores `'/'`; `records.assignNumber(key, { date? })` allocates (grouped the same way),
  writes through the unit of work (journal, dirty, triggers) and refuses records that already have a number
  (`ValidationError`). Call it from a transition's `before` hook: `before: (moves) => moves.assignNumber('name', ...)`.

### 7.5 Types

`SequenceKeys<S, M>` are the fields whose flags say `sequence: true`; `assignNumber` takes only those. The create
face already excludes sequence fields from the mandatory set (RFC 0001 §7.3).

## 8. Type-level guarantees

`sequence: 'typo'` is a build error, not a runtime one; `assignNumber('note')` is a type error.

## 9. Runtime metadata

`registry.sequences` (code → definition); `describe()` of a field shows `sequence: { code, gapless, on, dateField }`.

## 10. Interactions

- **0010:** numbering on a transition through `before` / `after` hooks.
- **Migrate:** `shutro_sequence` is an infrastructure table (skipped by the schema diff like `shutro_migration`).
- **Audit:** the number assignment is a tracked write when the field is tracked.

## 11. Resolved questions

1. **Why not PostgreSQL sequences for the standard kind?** Period resets and per-company counters would need DDL at
   runtime; the autonomous counter row gives the same non-blocking behaviour with one storage.
2. **Gapless and serialization.** Accepted and documented: it is the price of the guarantee, as in Odoo `no_gap`.

## 12. Deferred

- Preview of the next number (`peek`) for UI hints; renumbering tools; sequence administration records.
