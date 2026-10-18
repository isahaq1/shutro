# RFC 0013 — Audit trail

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/audit` (table, insert, trail queries), `@shutro/core` (collecting changes of tracked fields, flushing them, `records.trail()`)
- **Related:** 0001 §7.3 (`tracking`), 0003 §7.4 / §7.6 (`flags.tracking`, audited superuser scopes, stable `now`), 0004 §7.6 (flush points, savepoint journal), 0008 / 0010 / 0012 (changes made by computes, transitions and numbering)

## 1. Summary

Every change to a **tracked field** (`tracking: [...]` on the model or `tracking: true` on the field; state fields are
tracked by default) becomes a row in one **append-only** table, `shutro_audit`: who, when, in which transaction,
why (`reason`), with what privileges (`su`), which record, which field, old and new value as JSON. Creations and
deletions are rows too (with a snapshot of the tracked fields), and so is every superuser scope. Rows are collected
in memory while a transaction runs, coalesced per (record, field), discarded with a rolled-back savepoint, and written
in one statement at each flush point, in the same transaction as the data. A trigger refuses `UPDATE` and `DELETE`
on the table. `records.trail()` reads a record's history.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Who changed the customer, the amount or the state of a document, when, and from what to what. |
| R2  | **Append-only**: the trail is evidence; nothing in the ORM or in ordinary SQL can edit it. |
| R3  | Consistent with the data: a change that rolls back leaves no trail row; a row never describes a change that did not happen. |
| R4  | Every change path is covered: writes, creates, deletes, transitions, document numbering, recomputed stored values. |
| R5  | Cheap: no row per untracked field, one statement per flush, one old-value fetch per write of tracked fields. |
| R6  | Scoped superuser use is on record (RFC 0003 R6). |
| R7  | Imports and migrations can switch tracking off (RFC 0003 R7). |

## 3. How Odoo does it

`tracking=True` on fields creates `mail.tracking.value` rows attached to a `mail.message` on the record's chatter,
written in `write()` by comparing old and new values (`_mail_track`). It doubles as the social feed, so it needs the
`mail` module, is per-write (not per transaction), stores values as typed columns per field type, and can be edited or
deleted like any message. Separate "audit log" apps exist for the forensic use case.

## 4. Prior art

Papertrail / audited (Rails): a `versions` table with serialized object diffs per save. Django-simple-history: a
history table per model. Event sourcing: the log *is* the state. PostgreSQL audit triggers (`pgaudit`, hand-written
`audit.logged_actions`) capture every column at the database level, without business meaning (ids, not display
values; no reason).

## 5. Options

- **A — Database triggers**: complete and tamper-evident, but no `reason`, no user (unless pushed as settings), and a
  row per column change including untracked noise. The `shutro.user_id` setting makes it possible later.
- **B — ORM-collected rows in one append-only table (chosen)**: knows the tracked fields, the user, the reason, the
  transaction; coalesces per transaction; one insert per flush.
- **C — Per-model history tables**: schema churn per model, joins for cross-model timelines.

## 6. Decision

Option B, with the table protected by a trigger (R2) and all values stored as JSON in the plain form `read()` uses.

## 7. Detailed design

### 7.1 Table

`shutro_audit (id, at, tx, uid, company_id, su, reason, action, model, record_id, field, old, new)`, indexed on
`(model, record_id, id)` and `at`. `action` ∈ `create` | `write` | `unlink` | `su`. A `BEFORE UPDATE OR DELETE`
trigger raises `insufficient_privilege`. The table is created on first use through the pool (like `shutro_sequence`)
and ignored by the schema diff.

### 7.2 Collection

The transaction attempt holds a list of pending rows and a `tx` id (`crypto.randomUUID()`):

| Change | Rows |
| ------ | ---- |
| `write()` of tracked fields | the tracked fields are loaded first (one query when missing) so the old value is exact; one `write` row per (record, field) with `old` and `new` |
| `create()` | one `create` row per record with `new` = snapshot of its tracked fields |
| `unlink()` | one `unlink` row per record with `old` = snapshot, loaded before the delete |
| transition (RFC 0010), `assignNumber` (RFC 0012), computed assignment (RFC 0008) | a `write` row when the field is tracked; for recomputed fields the engine keeps the value it invalidated so `old` is exact |
| `asSuperuser()` | one `su` row with the reason |

Rows are coalesced per (model, record, field) within the attempt: the first `old`, the last `new`; a change that ends
where it started is dropped. `flags.tracking: false` (any user; imports) collects nothing.

### 7.3 Flush and rollback

`flushAll` writes the pending rows of the flushed models (all of them before commit) after the data statements,
in the same transaction, through `insertAuditStatement` (one `INSERT ... FROM unnest`). A savepoint remembers the
list length and truncates on rollback (RFC 0004 §7.6). Values are the plain JSON form of `read()`: ids for
many2one, `{ amount, currency }` for money, ISO strings for datetimes, decimal strings, translation maps.

### 7.4 Reading

`records.trail({ field?, limit?, action?, before? })` flushes and returns the record's rows newest first
(`AuditEntry[]`); `before` (a row id) pages through long histories. Field security applies: rows of fields the scope
may not read are left out and such fields are removed from create / delete snapshots; `limit` counts the rows returned. `readTrail(runner, filter)` in
`@shutro/audit` queries any scope (model, records, field, user, action, since, before) without field security, for
system code.

## 8. Type-level guarantees

`tracking` keys are checked against the model's fields at `defineModel` (RFC 0001); `trail()` is typed on recordsets.

## 9. Runtime metadata

`describe()` reports `tracking: true` per field (model list or field option). `registry` exposes nothing new.

## 10. Interactions

- **Security:** the trail is readable through `records.trail()` subject to the model's read access and field
  security (unreadable fields are left out, §7.4).
- **Migrate:** `shutro_audit` is infrastructure; the generator and the schema diff ignore it.
- **Kosh:** the chatter's change log reads `records.trail()` as the user, so field security applies.

## 11. Resolved questions

1. **Per write or per transaction?** Per transaction attempt (coalesced): a trail of business changes, not of every
   intermediate assignment a compute made.
2. **Why JSON values rather than typed columns?** One table for every field type, including translations and money.

## 12. Deferred

- Display names next to ids in `old` / `new`; retention policies; the Kosh timeline UI; hash chaining for tamper
  evidence beyond the trigger.
