# RFC 0018: Lost-update protection, transactional events, jobs and history

- **Status:** Accepted (§7.1 implemented; §7.2–§7.4 implemented as they land)
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
