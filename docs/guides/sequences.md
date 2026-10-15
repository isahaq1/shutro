# Sequences

[RFC 0012](../rfcs/0012-sequences.md). Document numbers come from sequences declared by modules and referenced by
fields.

```ts
export const sale = defineModule({
  name: 'sale',
  sequences: [defineSequence({ code: 'sale.order', prefix: 'SO/{year}/', padding: 5, reset: 'yearly' })],
  models: [SaleOrder],
});

// Numbered when created:
name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),

// Numbered when posted (gapless, monthly, period from the document date):
export const account = defineModule({
  name: 'account',
  sequences: [defineSequence({ code: 'account.move', prefix: 'INV/{year}/{month}/', padding: 4, reset: 'monthly', gapless: true })],
  models: [AccountMove],
});
name: f.char({ required: true, readonly: true, sequence: { code: 'account.move', on: 'manual', dateField: 'date' } }),
state: f.state({ ..., transitions: { post: { from: ['draft'], to: 'posted', before: (moves) => moves.assignNumber('name') } } }),
```

- **Batches**: `create()` allocates one range per (company, period) for all rows at once; 1,000 invoices are one
  statement.
- **Per company** by default (`perCompany: false` for a shared counter); **resets** `never` / `yearly` / `monthly` /
  `daily` keyed by the document date (`dateField`, else today); placeholders `{year}`, `{yy}`, `{month}`, `{day}`.
- **Standard** sequences (default) never block: the counter is bumped in a short autonomous transaction on the pool
  (so the pool needs at least 2 connections). A rolled-back transaction leaves a gap.
- **Gapless** sequences bump the counter inside the business transaction: concurrent transactions queue on the
  counter row until the first commits, and a rollback returns the number. Use them only where numbering must be
  continuous by law, and keep those transactions short.
- `on: 'manual'` fields hold `'/'` (`UNNUMBERED`) until `records.assignNumber(key, { date? })`, which refuses records
  that already have a number. Transition hooks are the natural place to call it.
- The counter lives in `shutro_sequence (code, company_id, period, next)`, created on first use; the schema diff
  ignores it like the migration ledger.

Build-time checks: a field's sequence code must be declared by a module the field's module can see
(`UnknownSequenceError`), codes are unique across modules, a field's `gapless` must agree with the definition, and
`dateField` must be a field of the model.

## Pool size

Standard (non-gapless) sequences allocate in a short transaction of their own, on a second connection. With a pool
of one (`createDriver({ max: 1 })`) that would wait forever, so `createShutro` refuses it with an
`InvalidSequenceError` naming the sequences. Raise `max`, or make them `gapless: true`.
