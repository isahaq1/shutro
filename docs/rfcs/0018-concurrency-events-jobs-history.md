# RFC 0018: Lost-update protection, transactional events, jobs and history

- **Status:** Implemented (§7.1–7.4); §7.5 proposed 2026-10-27, waiting for approval
- **Related:** 0003 (transactions, retries), 0004 (writes), 0013 (audit), 0014 (security)

## 1. Summary

Four capabilities the Odoo ORM does not have in core: compare-and-set writes against lost updates, a transactional
outbox for domain events, a PostgreSQL job queue, and reading records as they were at a past instant.

## 2. Problems and how Odoo handles them

- **Lost updates.** Two users open an invoice; the second save silently overwrites the first. Odoo's ORM has no
  check (the web client's `__last_update` warning is advisory and client-side).
- **Integration events.** Webhooks or messages sent from business code either fire for rolled-back transactions
  or are lost after commit. Odoo has no outbox; `bus.bus` is for UI notifications.
- **Background work.** Odoo core has crons only; the community `queue_job` module adds a queue.
- **Point-in-time reads.** Auditors ask what a record looked like at period close. Odoo keeps chatter tracking for
  some fields; there is no general way to query the past.

## 7. Decisions

### 7.1 Compare-and-set writes

`records.write(values, { expect: { updatedAt, ... } })`: the records are locked (`SELECT … FOR UPDATE`), their
stored values compared with `expect`, then written. A difference is a `StaleRecordError` naming the records and
fields. Under `REPEATABLE READ`, a concurrent committed change makes the lock fail with a serialization error; the
run is retried and the retry reports `StaleRecordError`, so of two racing saves from the same read exactly one wins.

### 7.2 Transactional events (outbox)

`env.emit(topic, payload)` inserts into `shutro_outbox` in the business transaction: an event exists if and only if
its transaction committed. `shutro.subscribe(topic, handler)` delivers each event at least once, in id order per
topic, with retries and a `dead` state after the attempts run out; `NOTIFY` wakes subscribers without polling.

### 7.3 Jobs

`env.enqueue(name, payload, { runAt, key, attempts })` inserts into `shutro_job` transactionally; `key` deduplicates
pending jobs. `shutro.work({ name: handler })` claims due jobs with `FOR UPDATE SKIP LOCKED` (any number of
workers), runs each in its own `run()` scope, and retries failures with exponential backoff.

### 7.4 History

`history: true` on a model keeps every version of its rows (a trigger writes the old row with its validity range
into `<table>_history`). `env.asOf(instant).model(M)` searches and loads the model as it was at that instant, with
the same rules and field security as current reads.

### 7.5 Change events (proposed 2026-10-27, waiting for approval)

Requested by Kosh (its request #26): an automation engine wants to react to **any** field change of a model, after
it committed, exactly once, without reading the audit table with a cursor (the audit trail records tracked fields
only, and a cursor over it is a second delivery mechanism next to the outbox).

**Proposal.** A model option `changeEvents: true` (also settable by `extendModel`, so a module can turn it on for
another module's model). Every flush that creates, writes or unlinks records of such a model emits, **in the writing
transaction** (the outbox of §7.2: it exists if and only if the change committed), one event per model and action:

```ts
// topic 'record.changed'
{ model: 'sale.order', action: 'write', ids: [12, 13], keys: ['state', 'amountTotal'] }
```

- `action`: `create`, `write` or `unlink`; `keys`: the stored fields the flush wrote (for `create`, the fields
  given; recomputed stored fields are included, so a rule on a total sees the total change); none for `unlink`.
- Batched per flush: a `write` of 500 records is one event with 500 ids (split into events of at most 1 000 ids).
- The event carries no values: subscribers read the records in their own scope (as the emitter, as for every
  event), so field security and record rules apply to what they see.
- Writes made with the option off, and writes by raw SQL, emit nothing (documented).

**Alternatives considered.** A trigger writing to the outbox (catches raw SQL too, but runs per row and cannot know
which keys the ORM meant to write); extending the audit trail to every field (heavier rows than an event, and still a
cursor); one topic per model (`record.changed:sale.order`: subscribers would need one subscription per model, and the
set of watched models changes at run time).

**Tests.** Create, write, unlink and a recompute emit one event each with the right keys; a rolled-back transaction
emits nothing; a write of 2 500 records emits three events; models without the option emit nothing; an
`extendModel` turns it on.

**Open questions.** The option per model (proposed), or one registry-wide switch for every model? The id limit per
event (1 000 proposed)?

