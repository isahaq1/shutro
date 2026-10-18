# Events and jobs

Both live in PostgreSQL, in the same transactions as your data (RFC 0018). There is no message broker to run and
no "sent the webhook but the transaction rolled back" class of bugs.

## Events (transactional outbox)

```ts
// In business code: the event exists if and only if this transaction commits.
await env.emit('invoice.posted', { invoice: move.id, total: move.amountTotal?.toJSON() });

// A subscriber (start it in your worker process):
const mailer = shutro.subscribe('mailer', 'invoice.posted', async (event, env) => {
  await sendInvoiceMail(event.payload);              // side effects outside the database: make them idempotent
  await env.model('mail.log').create([{ ref: String(event.id) }]); // committed together with the cursor
});
mailer.start();
```

- Each subscription (by name) receives every event of its topic once its transaction committed, **in order**, at
  least once. The subscription cursor advances in the handler's transaction: the handler's database work happens
  exactly once.
- The handler runs as the user and company that emitted the event, so record rules apply to it.
- A failing handler rolls back and is retried with exponential backoff (1 s, 2 s, 4 s … up to 10 min); after
  `attempts` (default 10) the event goes to `shutro_dead_event` and the subscription moves on.
- One delivery at a time per subscription name, across processes; `NOTIFY` wakes subscribers immediately.

## Jobs

```ts
await env.enqueue('report.monthly', { month: '2026-09' }, { key: 'report:2026-09', runAt: tomorrow, attempts: 5 });

const worker = shutro.work({
  'report.monthly': async (payload, env, job) => { /* ... */ },
});
worker.start(); // start as many as you like, in as many processes
```

- Enqueued in the business transaction. With `key`, enqueueing again while the job is pending or running does
  nothing (returns `null`).
- Workers claim due jobs with `FOR UPDATE SKIP LOCKED`: any number of workers, no job runs twice at once. The job
  is marked done in the handler's transaction, so its database work happens exactly once.
- Failures are retried with backoff until `attempts` run out (`dead`, with `last_error`). Jobs left `running` by a
  crashed worker are released with `releaseStale(driver, staleMs)` (run it from a cron or at worker start).
- `worker.drain()` processes what is due now and resolves with the count: handy in tests and cron jobs.
