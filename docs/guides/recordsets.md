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

# Recordsets (writing)

```ts
const orders = await env.model('sale.order').create([
  {
    name: 'SO100', partner: partnerId, currency: bdtId, dateOrder: new Date(),
    lines: { create: [{ name: 'Laptop', currency: bdtId, uom: unitId, quantity: '2', priceUnit: '700', subtotal: '1400' }] },
    tags: { link: [vipId] },
  },
]);                                   // one INSERT per model; the records come back with their defaults loaded

await orders.write({ note: 'bulk', amountTotal: Money.of('10', orders.first().amountTotal.currency) });
await orders.first().lines.load().then((lines) => lines.unlink());
```

## `create()`

- Values follow the model's **create face**: required fields without a default are mandatory; readonly, computed and
  state fields are rejected (`ValidationError`, with the offending `fields`); the implicit `company` defaults to
  `env.companyId`; `createdAt` / `updatedAt` / `createdBy` / `updatedBy` are set by the ORM.
- One `INSERT … SELECT FROM unnest(...)` per model whatever the row count (ids come back in input order).
- x2many fields take **commands**: `create`, `update: [{ id, values }]`, `delete`, `link`, `unlink`, `set`, `clear`.
  Nested creates fill in the inverse field; many2many links are written to the junction table at once.
- `Money` and `Quantity` values are accepted and checked against the record's currency / unit
  (`CurrencyMismatchError`, `UomMismatchError`).

## `write()` and the unit of work

`write()` changes the cache immediately (reads see the new values with no query) and marks the records dirty. The
database is updated at the next **flush point**: a `search()` on that model, raw SQL through `env.sql`, the end of a
savepoint, or commit. A flush issues one `UPDATE … FROM unnest(...)` per (model, set of changed fields), so writing a
field on 10,000 records is one statement. `updatedAt` / `updatedBy` are set on every flushed record.

## `unlink()`

Deletes immediately (`ON DELETE` rules of the schema apply) and drops the records from the cache.

## Savepoints

Inside `env.transaction(fn)`, every cache change is journaled. If `fn` throws, the database rolls back to the savepoint
**and** the cache is restored: written values revert, records created inside disappear, records deleted inside
come back, and nothing dirty is left behind. If `fn` succeeds, pending writes are flushed before the savepoint is
released.

## Not yet

Computed-field recomputation, constraints, onchange, record rules on flush, sequences (a required `sequence` field
currently has to be given explicitly), and `write()` on pending x2many sets.

## Lost-update protection

Forms read a record, users edit it, and two users can save the same record. Pass what you read as `expect`:

```ts
const invoice = (await env.model('account.move').browse([id]).load()).first();
// ... the user edits ...
await invoice.write({ amount: '95.00' }, { expect: { updatedAt: invoice.updatedAt } });
```

The records are locked and compared before the write; if someone saved first, the write is a `StaleRecordError`
(records and fields named) instead of silently overwriting their change. Any stored fields can be expected
(`{ state: 'draft' }` as a guard). Of two racing saves from the same read, exactly one wins.

## Time travel

```ts
export const AccountMove = defineModel('account.move', { history: true, fields: { /* ... */ } });

// What did posted invoices look like at the September close?
const atClose = await env.asOf(new Date('2026-09-30T23:59:59+06:00'), async (past) =>
  (await past.model('account.move').search({ where: { state: 'posted' } })).read(['name', 'amountTotal']),
);
```

- With `history: true`, a trigger archives each row's previous version into `<table>_history` with its validity
  range: on the first change in each transaction (versions nobody else could see are not kept) and on delete.
  Raw SQL changes are versioned too. `shutro migrate apply` installs the triggers; the migrator keeps the history
  table's columns in step with the model.
- `env.asOf(instant, fn)` reads the models with history as they were at `instant` (search, load, relations,
  filters through paths, aggregates), with today's record rules and field security. Models without history are read
  as they are now. The past is read-only and has its own cache.
