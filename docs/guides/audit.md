# Audit trail

[RFC 0013](../rfcs/0013-audit-trail.md). Changes to **tracked fields** are appended to `shutro_audit`, one table for
every model, protected by a trigger that refuses `UPDATE` and `DELETE`.

```ts
export const SaleOrder = defineModel('sale.order', {
  tracking: ['state', 'partner', 'note'],                       // model-level list
  fields: {
    amountTotal: f.monetary({ currency: 'currency', compute: 'computeAmounts', store: true, tracking: true }),   // or per field
    state: f.state({ ... }),                                     // state fields are tracked by default
  },
});
```

```ts
await order.write({ note: 'Deliver by courier' });
await order.confirm();
await env.flush();
const rows = await order.trail();          // newest first
// { action: 'write', field: 'state', old: 'draft', new: 'sale', uid, at, tx, reason, su, ... }
// { action: 'write', field: 'note',  old: null,    new: 'Deliver by courier', ... }
// { action: 'create', field: null,   new: { state: 'draft', partner: 12, note: null, amountTotal: {...} }, ... }
```

What is recorded:

| Change | Row |
| ------ | --- |
| `write()` of a tracked field (also transitions, `assignNumber`, recomputed stored values) | `write` with exact `old` and `new` (the old value is loaded if needed) |
| `create()` | `create` with a snapshot of the tracked fields |
| `unlink()` | `unlink` with a snapshot taken before the delete |
| `env.asSuperuser({ reason })` | `su` with the reason |

Rows carry `uid`, `companyId`, `su`, `reason` (from `shutro.run({ reason })`), `at` (the transaction timestamp) and
`tx` (one id per transaction attempt). They are collected in memory, coalesced per (record, field) within the
transaction (first old, last new; no row when the value ends where it started), dropped with a rolled-back savepoint,
and written at each flush point in the same transaction as the data: a change that rolls back leaves no trace, and a
row never describes a change that did not happen.

Values are stored as JSON in the plain form `read()` uses (ids, `{ amount, currency }`, ISO strings, decimal strings,
translation maps).

`env.withFlags({ tracking: false })` turns collection off for imports and migrations. `readTrail(runner, filter)` in
`@shutro/audit` reads any slice of the trail (by model, records, field, user, action, time) for timelines and reports.
