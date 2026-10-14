# Recordsets (reading)

A recordset is an ordered, immutable set of records of one model, bound to an environment
([RFC 0004](../rfcs/0004-recordsets-identity-map-and-batched-prefetch.md)). Reading is explicit and batched:
`await` a `load()`, then read fields synchronously. The types track what was loaded, so reading a field that wasn't
loaded is a compile error that names the missing `load()`.

```ts
const registry = buildRegistry({ modules: [sale] });          // its type knows every model in the module tree
const shutro = createShutro({ driver, registry });

await shutro.run({ user, company }, async (env) => {
  const orders = await env.model('sale.order').search({ where: { state: 'sale' }, order: ['dateOrder desc'], limit: 50 });
  for (const o of orders) {
    o.name;             // string: default columns are loaded by search()
    o.amountTotal;      // Money, with the order's currency
    o.partner.id;       // Id<'res.partner'>: the id is known...
    o.partner.name;     // ✗ compile error: NotLoaded<'res.partner', 'name'>
  }

  const loaded = await orders.load({ partner: ['name', 'email'], lines: { uom: true }, tags: true });
  for (const o of loaded) {
    o.partner.name;                               // string
    for (const l of o.lines) l.quantity.to(unit); // Quantity, with the line's unit loaded
    o.tags.mapped('name');                        // string[]
  }
});
```

## Loading

| Call | Loads |
| ---- | ----- |
| `search(query)` | The **defaults** of the matching records: stored, non-binary fields and many2one ids, in one query |
| `browse(ids)` | Nothing until `load()` |
| `load()` | Defaults |
| `load(['subtotal', 'currency'])` | Exactly those fields (plus `id`) |
| `load({ partner: ['name'], lines: { uom: true }, tags: true })` | Nested: `true` means the relation's defaults, a list narrows, an object loads defaults plus the nested relations |

Loading never costs more than one query per relation level, however many records are involved (ids are sent as one
array parameter, in chunks of 1,000). Loading something that is already cached costs nothing, so defensive `load()`
calls are free.

## Prefetch groups

Records loaded together form a prefetch group. Loading a relation for one record loads it for the whole group:

```ts
for (const o of orders) {
  const lines = await o.lines.load(['subtotal']);   // first iteration: ONE query for the lines of all orders
  total = total.plus(Money.sum(lines.mapped('subtotal'), currency));
}
```

## Identity map

Every record has one set of values per transaction, whatever path reached it. A partner loaded through
`orders.load({ partner: ['name'] })` is already there when you `browse([partnerId]).load(['name'])`.

## Values

| Field | Read as |
| ----- | ------- |
| `monetary` | `Money` in the record's currency. Currencies are loaded once per transaction (`res.currency`) |
| `quantity` | `Quantity` in the record's unit (`uom.uom`, cached the same way), `null` when the unit is unset |
| `decimal` | `Decimal` |
| `date` / `datetime` | `'YYYY-MM-DD'` string / `Date` |
| `many2one` | A record (navigable; its id always available) or `null` |
| `one2many` / `many2many` | A recordset once loaded, otherwise a pending set with `load()` and `ids()` |

`records.read(['name', 'amountTotal', 'lines'])` gives plain JSON rows: ids for relations, `{ amount, currency }` for
money, `{ value, uom }` for quantities, ISO strings for dates.

## Searching

`where` is an object of field → value (equality) or operators (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `notIn`,
`isNull`, `like`, `ilike`), ANDed. `ne` and `notIn` include `NULL`, as business users expect (RFC 0005 §7.3).
Every search also applies the environment's scoping: archived records are hidden unless `activeTest` is off, and
company-scoped models are limited to `env.companyIds`.

Relation paths, `or` / `not`, `any` / `all` / `none` and record rules come with the full domain compiler.

## Errors

`FieldNotLoadedError` (with the `load()` to add), `SingletonError` (`first()` on an empty set, `ensureOne()` on more
than one), `MissingRecordError` (a browsed id that doesn't exist), `InvalidDomainError`.

## Query-count assertions

`env.stats().queries` counts the statements of the current attempt. Integration tests assert it, so an N+1 shows up as
a failing number, not a slow page:

```ts
const before = env.stats().queries;
await orders.load({ partner: ['name'], lines: true });
expect(env.stats().queries - before).toBe(2);
```

## Tables for tests and examples

Until `@shutro/migrate` exists, `createTableStatements(registry)` returns `CREATE TABLE` / foreign-key / junction
statements derived from the models, to be executed in order on a fresh database.
