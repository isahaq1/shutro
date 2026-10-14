# @shutro/sql

Shutro's SQL layer: an immutable SQL AST, the `sql` tagged template, and a compiler to parameterized PostgreSQL
(`$1..$n`, quoted identifiers). Values only ever travel as parameters.

```ts
import { compile, sql } from '@shutro/sql';

compile(sql`SELECT ${sql.id('name')} FROM ${sql.id('res_partner')} WHERE ${sql.id('id')} = ANY(${sql.array(ids, 'bigint')})`);
// { text: 'SELECT "name" FROM "res_partner" WHERE "id" = ANY($1::bigint[])', params: [ids] }
```

Guide: [docs/guides/sql.md](../../docs/guides/sql.md) · Design: [RFC 0005](../../docs/rfcs/0005-query-builder-and-sql-compiler.md)
