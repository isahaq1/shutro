# Bulk operations and partitioning

[RFC 0015](../rfcs/0015-bulk-partitioning-benchmarks.md).

## COPY

```ts
const products = await env.model('product.product').copy(rows);   // 100,000 rows: one COPY statement
```

`copy()` has the semantics of `create()` — validation, defaults, sequences, computed fields and constraints at the
next flush point, audit rows, create rules — and streams every row through PostgreSQL `COPY` instead of chunked
INSERTs. It needs the `import` permission and does not accept x2many commands (copy the children separately,
with their parent ids, as the benchmark does). Ids come back in input order.

`create()` itself batches: rows go in one `INSERT ... SELECT FROM unnest(...)` per 1,000, and nested
`lines: { create: [...] }` of all parents become one insert per field. Use `copy()` when rows go into the tens of
thousands or more.

## Partitioned models

```ts
export const AccountMoveLine = defineModel('account.move.line', {
  partition: { by: 'range', key: 'date' },                 // 'range' | 'list' | 'hash'
  fields: { date: f.date({ required: true }), /* ... */ },
});

for (const s of partitionStatements(AccountMoveLine, rangePartitions(AccountMoveLine, { from: '2026-01', to: '2027-01' })))
  await driver.query({ text: s, params: [] });            // account_move_line_2026_01 ... _2026_12
```

- The key must be a required stored field and is part of the primary key `(id, key)`; unique constraints must
  include it.
- Nothing may reference a partitioned model through a many2one (the foreign key would need the key too); it can
  reference others and have one2many relations.
- Partitions are created ahead of time (`partitionStatements` takes range, list, hash and default bounds). A row
  with no partition fails with "No partition accepts the row".
- `shutro migrate plan` creates the partitioned parent and ignores partitions.

## Benchmarks

```
pnpm bench                     # 5,000 orders × 3 lines by default locally: BENCH_ORDERS=1000 for a quick run
```

Each scenario asserts a query budget (the CI gate) and writes `benchmarks/results.json` (timings, uploaded by CI).

## Documents with lines

`copy()` accepts one2many `create` commands: parents are COPY-loaded first, then all their children in one COPY per
child model, linked in order.

```ts
await env.model('account.move').copy(rows.map((r) => ({ ...r.header, lines: { create: r.lines } })));
```

## References into partitioned models

A database foreign key cannot reference a partitioned table without its partition key. Declare the reference
without one; the ORM checks that every written id exists:

```ts
move: f.many2one('stock.move', { required: true, foreignKey: false }),
```

Deleting the target is not restricted by the database (so `ondelete` cannot be set): archive instead, or check in
the target's unlink path.
