# The typed query builder

Layer 2 of [RFC 0005](../rfcs/0005-query-builder-and-sql-compiler.md): a Kysely-shaped builder for reports and
anything the model-level domains can't express. It compiles through the same `sql` fragment AST as the
[`sql` tag](sql.md), so values can only ever become parameters and identifiers are always validated and quoted.

```ts
import { createQueryBuilder } from '@shutro/sql';

interface Db {                                   // the shape `shutro generate` will emit later
  sale_order: { id: number; name: string; state: string; partner_id: number; amount_total: string; date_order: Date | null };
  res_partner: { id: number; name: string; country_id: number | null };
  sale_order_line: { id: number; order_id: number; subtotal: string };
}
const qb = createQueryBuilder<Db>();

const report = qb
  .selectFrom('sale_order as so')
  .innerJoin('res_partner as p', 'p.id', 'so.partner_id')
  .leftJoin('sale_order_line as l', (eb) => eb('l.order_id', '=', eb.col('so.id')))
  .select(['so.id', 'p.name as partner'])
  .select((eb) => [eb.fn.sum('l.subtotal').as('total'), eb.fn.count().as('lines')])
  .where('so.state', '=', 'sale')
  .where((eb) => eb.or([eb('so.amount_total', '>', '1000'), eb('p.country_id', 'is', null)]))
  .groupBy(['so.id', 'p.name'])
  .having((eb) => eb(eb.fn.sum('l.subtotal'), '>', '0'))
  .orderBy('so.date_order', 'desc', { nulls: 'last' })
  .limit(50);

report.compile();
// { text: 'SELECT "so"."id", "p"."name" AS "partner", sum("l"."subtotal") AS "total", count(*) AS "lines" FROM ... WHERE "so"."state" = $1 AND ...', params: ['sale', '1000', '0', 50] }

type Row = RowOf<typeof report>;  // { id: number; partner: string; total: string | null; lines: number }
```

## What it covers

| Feature | API |
| ------- | --- |
| Tables and aliases | `selectFrom('sale_order as so')`, columns as `'so.id'` or bare `'id'`, renamed with `'so.name as reference'` |
| Joins | `innerJoin` / `leftJoin` with `(table, left, right)` or a callback building any condition |
| Conditions | `where(col, op, value)` and `where((eb) => ...)` with `eb.and`, `eb.or`, `eb.not`, `eb.exists(subquery)`, `eb.col`, `eb.val`, `eb.sql(fragment)` |
| Operators | `=`, `<>`, `<`, `<=`, `>`, `>=`, `like`, `ilike`, `not like`, `not ilike`, `is` / `is not` (null, true, false), `is distinct from`, `in` / `not in` (array or sub-query) |
| Aggregates | `eb.fn.count()`, `count(col, { distinct: true })`, `sum`, `avg`, `min`, `max`, `grouping([...])` |
| Grouping | `groupBy([...])`, `groupingSets([[...], [...], []])`, `having(...)` |
| Ordering and paging | `orderBy(col, 'asc' \| 'desc', { nulls })`, `limit(n)`, `offset(n)` (both parameters) |
| CTEs | `qb.with('open', (q) => q.selectFrom(...)...).selectFrom('open')`: the CTE is a typed table |
| Writes | `insertInto(t).values([...]).returning([...])`, `updateTable(t).set({...}).where(...).returning([...])`, `deleteFrom(t).where(...).returning([...])` |

Every call returns a new query; builders are immutable, so a base query can be reused.

## Rules that keep it safe

- **Lists are one parameter.** `where('id', 'in', ids)` compiles to `"id" = ANY($1)` whatever the list length, so the
  SQL text, and with it the prepared statement, stays stable. An empty list folds to `FALSE` (`TRUE` for `not in`).
- **Missing insert keys become `DEFAULT`.** Columns are the union of the keys present across rows, in order of first
  appearance; rows without a value for a column get `DEFAULT`.
- **No raw strings become SQL.** Table names, aliases, columns and CTE names go through `sql.id`; anything else is a
  parameter. Raw SQL is only possible by embedding a `sql` fragment with `eb.sql(...)`.
- **Errors are typed** (`SqlError`): `SQL_EMPTY_SELECT`, `SQL_EMPTY_VALUES`, `SQL_INVALID_OPERATOR`, `SQL_INVALID_IDENTIFIER`.

## Not yet

- **Record-rule enforcement (`.withRules()`, RFC 0005 §7.7).** It needs the registry to know which tables are models.
  Until then the builder is a plain SQL builder: apply scoping yourself, or run reports as superuser deliberately.
- Window functions, `FILTER (WHERE ...)`, `ROLLUP` / `CUBE`, `ON CONFLICT`, sub-queries as tables. Use `eb.sql(...)`
  for these for now.
