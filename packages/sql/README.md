# @shutro/sql

Shutro's SQL layer (RFC 0005): an immutable SQL AST, the `sql` tagged template, a parameterized compiler, and a
typed query builder. Values only ever travel as parameters; identifiers are validated and quoted.

```ts
import { compile, createQueryBuilder, sql } from '@shutro/sql';

compile(sql`SELECT ${sql.id('name')} FROM ${sql.id('res_partner')} WHERE ${sql.id('id')} = ANY(${sql.array(ids, 'bigint')})`);
// { text: 'SELECT "name" FROM "res_partner" WHERE "id" = ANY($1::bigint[])', params: [ids] }

const qb = createQueryBuilder<Db>();
qb.selectFrom('sale_order as so').select(['so.id']).where('so.state', '=', 'sale').limit(10).compile();
// { text: 'SELECT "so"."id" FROM "sale_order" AS "so" WHERE "so"."state" = $1 LIMIT $2', params: ['sale', 10] }
```

Guides: [sql tag](../../docs/guides/sql.md) · [query builder](../../docs/guides/query-builder.md) ·
Design: [RFC 0005](../../docs/rfcs/0005-query-builder-and-sql-compiler.md)
