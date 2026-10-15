# RFC 0007 — PostgreSQL driver

- **Status:** Accepted (2026-10-14), decided by the pre-registered rule in [spike 0002](../spikes/0002-driver-benchmark.md)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** 0003, 0004, 0005, 0006
- **Related:** `CLAUDE.md` tech stack ("benchmark both in Phase 1, pick one, record it in an RFC")

---

## 1. Summary

`@shutro/driver-pg` wraps **`postgres` (postgres.js)**. It passed every correctness check that RFCs 0003–0006 depend on,
both directly and through PgBouncer in transaction mode. It's **1.34–1.35× faster** than `pg` on the geometric mean of the
benchmark workloads, has **zero dependencies** (vs 12), and has COPY built in.

The driver is hidden behind a small internal interface (`DriverConnection`, §7.1). No other Shutro package imports
postgres.js, so replacing it later is a change to one package.

---

## 2. Problem & requirements

The driver is layer 1 of the architecture (`CLAUDE.md`). Everything above it assumes:

| # | Requirement | From |
| - | ----------- | ---- |
| R1 | Lossless `numeric` ↔ `Decimal`, and `bigint` ↔ guarded `number`, configured **per instance** (no global type registry) | 0001 Q2, 0006 §7.9, `CLAUDE.md` "no global mutable state" |
| R2 | Array parameters (`= ANY($1::bigint[])`, `unnest(...)`) with stable SQL text | 0004 §7.3/§7.6, 0005 §7.9 |
| R3 | Transactions with an isolation level, nested savepoints, `SET LOCAL` | 0003 §7.1/§7.5 |
| R4 | SQLSTATE and constraint, table and detail on errors, for retry (40001/40P01) and typed constraint errors | 0003 §7.5, 0001 §7.7 |
| R5 | Prepared statements that work behind PgBouncer ≥ 1.21 in transaction mode | 0003 R9, 0005 §7.9 |
| R6 | LISTEN/NOTIFY (outbox relay) and COPY (bulk import) | events, Phase 5 |
| R7 | Throughput on many small statements and on set-based batches | 0004 |
| R8 | Minimal dependencies | `CLAUDE.md` |

## 3. How Odoo does it

Odoo uses **psycopg2** (Python, libpq-based) through its own `Cursor` wrapper (`odoo.sql_db`). Each cursor is one
transaction from a per-database connection pool.

- ✅ psycopg2 is mature and complete: COPY, LISTEN/NOTIFY, and server-side cursors.
- ❌ Odoo works around it in places. Floats come back from `numeric` (RFC 0006 W1), and there's no native prepared-statement reuse (every
  query is parsed again). Its connection pool isn't PgBouncer-aware, so Odoo SaaS deployments add PgBouncer with care around
  `LISTEN` (the bus) and advisory locks.

## 4. Prior art in the TS ecosystem

| ORM | Driver(s) |
| --- | --------- |
| Prisma | Rust query engine historically, now also driver adapters such as `@prisma/adapter-pg` (pg) |
| Drizzle | Both `postgres` (postgres.js) and `pg`, the user's choice |
| Kysely | `pg` via `PostgresDialect`, with community postgres.js dialects |
| MikroORM | `pg` (through Knex historically, its own layer in v6) |

The ecosystem uses both, so nothing forces either choice. That's why the choice was measured.

## 5. Options

- **A. `pg` (node-postgres):** the most widely used, MIT, 12 transitive dependencies, COPY through `pg-copy-streams`.
- **B. `postgres` (postgres.js):** zero dependencies, Unlicense, automatic prepared statements and pipelining, COPY,
  LISTEN, and a callback-based `begin` / `savepoint` API.
- **C. Our own wire-protocol implementation:** maximum control, but months of work and a big correctness surface. Rejected.

### Measured trade-offs (spike 0002)

| Criterion | pg | postgres.js |
| --------- | -- | ----------- |
| K1–K7 correctness, direct and PgBouncer | ✅ all | ✅ all |
| P1 point selects (direct / bouncer) | 1.00× | **1.53× / 1.26×** |
| P2 batched `= ANY` loads | ≈ | ≈ |
| P3 set-based `unnest` update | 1.00× | **1.9× / 1.8×** |
| P4 multi-row INSERT … RETURNING | 1.00× | **1.7× / 1.5×** |
| P5 100k rows × 4 numeric → Decimal | ≈ | ≈ |
| Geometric mean | 1.00× | **1.34–1.35×** |
| LISTEN / COPY built in | ✅ / ❌ | ✅ / ✅ |
| Transitive dependencies | 12 | **0** |

## 6. Decision

**Option B, `postgres` (postgres.js) 3.x**, wrapped by `@shutro/driver-pg`.

## 7. Detailed design

### 7.1 Internal driver interface

Only `@shutro/driver-pg` imports postgres.js. Everything else uses this interface, which is the one the spike adapters
validated:

```ts
export interface DriverConnection {
  query<R extends Row>(sql: CompiledSql): Promise<R[]>;          // CompiledSql = { text, params } from @shutro/sql (RFC 0005)
  stream<R extends Row>(sql: CompiledSql, batch: number): AsyncIterable<R[]>;   // server-side cursor (RFC 0004 §7.7)
  savepoint<T>(fn: (conn: DriverConnection) => Promise<T>): Promise<T>;
  copyIn(sql: CompiledSql, rows: AsyncIterable<string>): Promise<number>;
}
export interface Driver {
  transaction<T>(opts: TxOptions, fn: (conn: DriverConnection) => Promise<T>): Promise<T>;   // RFC 0003 TxScope
  listen(channel: string, onMessage: (payload: string) => void): Promise<Unlisten>;           // dedicated connection
  end(): Promise<void>;
}
```

### 7.2 Configuration (per instance)

- `types.numeric`: OID 1700 parsed into Shutro's isolated `Decimal`, serialized with `toString()`.
- `types.bigint`: OID 20 parsed into `number`, with `RangeError` above `Number.MAX_SAFE_INTEGER`.
- `prepare: true`. Statements are cached per connection. Shutro's renderer emits stable text (`= ANY($n)`), so the cache stays
  small. Behind PgBouncer this requires `max_prepared_statements > 0` (PgBouncer ≥ 1.21). The config validator warns if a
  PgBouncer URL is detected without it.
- `onnotice` is routed to Shutro's logger, never to `console`.
- `connection.application_name = 'shutro'`, so connections are identifiable in `pg_stat_activity`.

### 7.3 Compiled SQL goes through `unsafe()`

postgres.js's tagged template is its injection-safe API, but Shutro compiles SQL itself (RFC 0005). The renderer outputs
`{ text, params }` with **only `$n` placeholders**, so the driver calls `sql.unsafe(text, params, { prepare: true })`.
Despite its name, that is parameterized. The values never touch the text.

- A Biome/grep rule bans `.unsafe(` outside `packages/driver-pg/src/`.
- The driver asserts in development that `text` contains no literal that came from `params` (the same injection oracle as RFC 0005 §7.9).

### 7.4 Errors

The driver maps `PostgresError` to Shutro's typed errors:

- `code` → class: `23505` → `ConstraintViolationError`, `40001`/`40P01` → retryable, `57014` → `StatementTimeoutError`, …
- `constraint_name` → the declared `sqlConstraints` key and message (RFC 0001 §7.7)
- `table_name`, `detail` and `hint` are passed through

### 7.5 Transactions

`sql.begin('isolation level repeatable read', fn)` backs RFC 0003's `TxScope`, and `sql.savepoint(fn)` backs nested scopes.
`SET LOCAL` values (`shutro.user_id`, `shutro.company_ids`, timeouts) are sent as the first statement of every transaction,
using `set_config(name, value, true)` in **one** round-trip.

## 8. Guarantees and tests

The spike's checks K1–K9 move into `packages/driver-pg/test` as the permanent integration suite. They run against
Testcontainers PostgreSQL, and against PgBouncer in CI, with a fast-check property test added for K1 (random numerics, including scale > 20).

## 9. Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| postgres.js has a small maintainer base (primarily one maintainer) | Wrapped behind §7.1, so swapping to pg is one package. The spike's pg adapter shows the swap works. Pin minor versions, and run the integration suite on every update. |
| Unlicense (public-domain dedication), which some legal teams query | It's permissive and OSI-approved. Document it in the license notice. |
| `unsafe()` misuse | Lint ban outside driver-pg, plus the dev-mode injection oracle (§7.3) |
| Prepared statements behind an old PgBouncer (< 1.21) | Config option `prepare: false` (its cost is not measured yet; benchmark it before recommending it), plus a startup warning |
| Return order of INSERT … RETURNING | Match by position and verify the count. Add an ordinal column if PostgreSQL ever changes the behaviour (spike 0002 note on K7). |

## 10. Interactions

- **0003:** `TxScope` uses `Driver.transaction` and `savepoint`. Retry classification comes from §7.4.
- **0004:** load and flush statements use array parameters (K3). Streaming uses `stream()`.
- **0005:** the renderer output feeds `query()` directly. The statement cache is the driver's prepared cache.
- **0006:** amended to Decimal precision 64 (spike 0002 finding).

## 11. Resolved questions

| # | Question | Resolution |
| - | -------- | ---------- |
| 1 | Keep `pg` as an optional alternative driver? | No. A single driver halves the test matrix. The interface keeps a future swap cheap. |
| 2 | Use postgres.js tagged templates directly in business code? | No. Business code uses `env.sql` (RFC 0005 §7.8), which compiles to `{ text, params }`. |

## 12. Deferred

- Read-replica routing and pool sizing: driver-pg implementation step.
- Binary protocol for `numeric` / `bytea`: only if a benchmark shows text parsing to be a bottleneck (P5 shows it isn't, at ~420k rows/s with 4 numeric columns).

---

## Implementation notes (2026-10-14, `@shutro/driver-pg` 0.0.0)

Where the implementation refines this RFC:

1. **No dependency on `@shutro/core` or `@shutro/sql`.** The driver is layer 1, and `core` will depend on it (RFC 0003), so:
   - `DriverQuery` is the structural `{ text, params }`, which `CompiledSql` satisfies without an import.
   - `numeric` parsing is **injected** (`createDriver({ parseNumeric })`). `core` will pass `toDecimal`. The default returns
     the exact string, which is lossless.
   - Errors are the driver's own `DriverError` hierarchy, using the same `code` + `hint` convention as `ShutroError`.
     `ConstraintViolationError` carries `kind`, `constraint`, `table`, `column` and `detail`. `SerializationFailureError`
     and `DeadlockError` are `retryable`.
2. **`date` (OID 1082) comes back as a `'YYYY-MM-DD'` string**, never a JS `Date` (RFC 0001 W7). `core` will wrap it in
   `CalendarDate`. `timestamptz` still parses to `Date` until `Instant` exists.
3. **`Driver.query()`** (autocommit) exists for DDL and maintenance. Business code goes through `transaction()`.
4. **The `.unsafe(` / `postgres` import ban** is enforced by `scripts/check-forbidden.ts`, which runs in `pnpm lint` and CI,
   because Biome can't express path-scoped call bans.
5. **The param-in-text guard** (§7.3) rejects a query when a string parameter of 8+ characters also appears in its text.
   It's on unless `NODE_ENV=production`, and can be turned off with `checkParamsInText: false`.

## Implementation notes (2026-10-15, array parameters)

postgres.js infers an array parameter's type from its first element and sends a JS boolean array as a *scalar*
boolean; and when the server resolves a parameter to `boolean` / `boolean[]` (from a cast), postgres.js serializes the
value with its boolean serializer, which yields `'f'` for anything but the JS value `true`, so binding booleans as text
silently stores `false`. The driver therefore declares any array containing booleans as `boolean[]` (OID 1000). Dates
inside arrays are bound as ISO strings by the ORM for the same inference reason (RFC 0004 notes).
