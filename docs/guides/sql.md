# Writing SQL with `@shutro/sql`

`@shutro/sql` is the bottom of Shutro's SQL layer ([RFC 0005](../rfcs/0005-query-builder-and-sql-compiler.md)). Most
application code never uses it directly: recordsets, domains and the typed report builder all compile through it. Use it
when you need hand-written SQL (migrations, reports, low-level helpers).

## The rule

**SQL goes in the template. Values go in `${...}` and always become parameters.** There's no way to turn a runtime
string into SQL text.

```ts
import { compile, sql } from '@shutro/sql';

const q = sql`
  SELECT ${sql.id('so', 'name')}, ${sql.id('so', 'amount_total')}
  FROM ${sql.id('sale_order')} AS ${sql.id('so')}
  WHERE ${sql.id('so', 'partner_id')} = ${partnerId}
    AND ${sql.id('so', 'state')} = ANY(${sql.array(['sale', 'done'], 'text')})
`;

compile(q);
// {
//   text: 'SELECT "so"."name", "so"."amount_total" FROM "sale_order" AS "so" WHERE "so"."partner_id" = $1 AND "so"."state" = ANY($2::text[])',
//   params: [partnerId, ['sale', 'done']],
// }
```

## API

| Helper | Renders | Notes |
| ------ | ------- | ----- |
| `` sql`…${value}…` `` | `$n` | Any value except `undefined`, `NaN`/`±Infinity`, functions and symbols. Arrays are **one** parameter. |
| `` sql`…${fragment}…` `` | the fragment, inlined | Fragments compose. Numbering is global and in order of appearance. |
| `sql.id('so', 'amount_total')` | `"so"."amount_total"` | Lower-case snake_case, at most 63 characters, always quoted (so `order` or `user` are fine). |
| `sql.param(value, 'numeric')` | `$n::numeric` | Explicit cast. Types like `numeric(20, 6)` and `timestamp with time zone` are allowed. |
| `sql.array(ids, 'bigint')` | `$n::bigint[]` | The text is the same for 1 or 10,000 ids, so prepared statements and plans are reused. |
| `sql.join(fragments, sep?)` | items joined by `, ` (or `sep`) | An empty list renders nothing. |
| `sql.empty` | nothing | Handy for optional clauses. |
| `compile(fragment)` | `{ text, params }` | Frozen. At most 65,535 parameters, the protocol limit (use arrays). |
| `visit(fragment, fn)` | — | Walks the AST, e.g. to find every identifier a query references. |

### Optional clauses

```ts
const filters = [
  sql`${sql.id('company_id')} = ANY(${sql.array(companyIds, 'bigint')})`,
  search ? sql`${sql.id('name')} ILIKE ${`%${search}%`}` : undefined,
].filter((f) => f !== undefined);

sql`SELECT ${sql.id('id')} FROM ${sql.id('res_partner')}
    ${filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql.empty}`;
```

### Dynamic keywords

There's no "raw" escape hatch. Choose between literal fragments instead:

```ts
const direction = dir === 'desc' ? sql`DESC` : sql`ASC`;
sql`ORDER BY ${sql.id('date_order')} ${direction}`;
```

## Guarantees (tested)

- **Values never reach the SQL text.** A fast-check property builds random fragment trees full of injection payloads and
  asserts that none appears in `text`. An integration suite round-trips payloads and 200 random strings through real PostgreSQL 18.
- **Exact numbering.** Parameters are `$1..$n`, each exactly once, in order.
- **Fragments can't be forged.** Only the `sql` tag and its helpers create fragments. Hand-made objects, including
  `Object.create(SqlFragment.prototype)`, are rejected by `compile`, `join` and `isSql`, or bound as plain values.
- **Typed errors** (`SqlError`, with `code` and `hint`) say what went wrong and how to fix it.
