# @shutro/driver-pg

Shutro's PostgreSQL connection layer ([RFC 0007](../../docs/rfcs/0007-postgresql-driver.md)). It wraps postgres.js
behind `Driver` / `DriverConnection`. No other Shutro package imports postgres.js.

```ts
import { compile, sql } from '@shutro/sql';
import { createDriver, isRetryable } from '@shutro/driver-pg';

const driver = createDriver({ url: process.env.DATABASE_URL ?? '', parseNumeric: (s) => toDecimal(s) });

await driver.transaction(
  { settings: { 'shutro.user_id': '42' }, statementTimeoutMs: 5_000 },   // default isolation: repeatable read
  async (conn) => {
    const rows = await conn.query<{ id: number }>(compile(sql`SELECT ${sql.id('id')} FROM ${sql.id('sale_order')} WHERE ${sql.id('state')} = ${'sale'}`));
    await conn.savepoint((sp) => sp.query(compile(sql`...`)));      // rolled back if the callback throws
  },
);
```

| Feature | API |
| ------- | --- |
| Transactions (isolation, read-only, `SET LOCAL` settings and timeouts in one round-trip) | `driver.transaction(options, fn)` |
| Savepoints | `conn.savepoint(fn)` |
| Server-side cursor | `for await (const batch of conn.stream(query, 1000))` |
| `COPY … FROM STDIN` | `conn.copyIn(query, lines)` → rows written |
| `LISTEN` | `driver.listen(channel, onMessage)` → `unlisten()` |
| Typed errors | `ConstraintViolationError` (`kind`, `constraint`, `table`, `detail`), `SerializationFailureError` / `DeadlockError` (`retryable`), `StatementTimeoutError`, `LockTimeoutError`, `ReadOnlyTransactionError`, `ConnectionError`, `QueryError` · `isRetryable(e)` |

Values: `numeric` goes through `parseNumeric` (default: exact string). `bigint` becomes a safe `number`, or
`BIGINT_OUT_OF_RANGE`. `date` becomes a `'YYYY-MM-DD'` string.

Behind PgBouncer, use transaction pooling with `max_prepared_statements > 0` (PgBouncer ≥ 1.21). The integration suite
runs against exactly that setup.
