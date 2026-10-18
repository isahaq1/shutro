# Reports and totals

## `aggregate()`: grouped totals

```ts
const rows = await env.model('sale.order').aggregate({
  where: { state: 'sale', 'partner.country.code': 'BD' },
  groupBy: ['partner', 'dateOrder:month'],
  measures: { orders: 'count', total: { sum: 'amountTotal' }, biggest: { max: 'amountTotal' } },
  order: ['total desc'],
  limit: 10,
});
// [{ partner: 7, 'dateOrder:month': '2026-09-01', orders: 12, total: Money(BDT 298780.49), biggest: Money(...) }, ...]
```

- **Groups:** stored char, selection, state, boolean, integer, date and many2one fields. Dates and datetimes take a
  granularity (`:day`, `:week`, `:month`, `:quarter`, `:year`) and come back as the first day of the bucket
  (`'YYYY-MM-DD'`). Datetimes are bucketed in the user's time zone.
- **Measures:** `'count'`, or `{ sum | avg | min | max: field }` on integer, float, decimal and monetary fields.
  Monetary totals are `Money`; each currency gets its own row, so amounts in two currencies are never added.
- **Security:** the same as `search`: read access, field groups (measuring a hidden field is an `AccessError`),
  record rules, company scope, and relation paths that respect the related model's rules.
- Without `groupBy`, one row for the whole selection (`[{ orders: 0, ... }]` when nothing matches).

### Subtotals in one statement: grouping sets, rollup, cube

```ts
const rows = await env.model('sale.order').aggregate({
  groupBy: ['partner', 'dateOrder:month'],
  rollup: true, // or cube: true, or groupingSets: [['partner', 'dateOrder:month'], ['partner'], []]
  measures: { total: { sum: 'amountTotal' } },
});
// [{ $groups: ['partner', 'dateOrder:month'], partner: 7, 'dateOrder:month': '2026-09-01', total }, ...,
//  { $groups: ['partner'], partner: 7, 'dateOrder:month': null, total }, ..., { $groups: [], total }]
```

One `GROUP BY GROUPING SETS` statement with the same security as above. `$groups` tells a subtotal (the group was
aggregated away) from a group whose value is `NULL`. Rows come leaves first, then each subtotal level, then the grand
total. Monetary measures keep one row per currency at every level. `cube` takes at most 6 groups.

## `sum()`: totals of loaded records

```ts
compute(records) {
  for (const order of records) order.untaxed = order.lines.sum('subtotal', order.currency);
}
```

`Money` for monetary fields (one currency, else `CurrencyMismatchError`; pass the currency for the empty case),
`Decimal` for decimals, `number` for integers and floats. `NULL`s are skipped.

## Conversions in reports

```ts
const rates = await env.fx.prepare({ date: '2026-10-15', currencies: [usdId, eurId] });
const inBdt = rates.convert(total, rates.companyCurrency).money; // synchronous
rates.currency(usdId); // the prepared Currency, by id
```
