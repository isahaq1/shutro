# Spike 0002 — PostgreSQL driver: `postgres` (postgres.js) vs `pg`

- **Status:** Complete (2026-10-14). **Outcome: `postgres` (postgres.js), recorded in [RFC 0007](../rfcs/0007-postgresql-driver.md).**
- **Answers:** `CLAUDE.md` tech stack ("benchmark both in Phase 1, pick one, record it in an RFC"). The decision goes into RFC 0007.
- **Code:** `spikes/driver-bench/` (throwaway; not a published package)

## Question

Which driver should `@shutro/driver-pg` wrap? It has to support everything RFCs 0003–0006 assume, without global mutable
state, and both directly against PostgreSQL and behind PgBouncer in transaction mode.

## Setup

- PostgreSQL 18.6 (latest stable; 19 isn't released) via Testcontainers.
- PgBouncer 1.26, `pool_mode = transaction`, `max_prepared_statements = 200`, in front of the same server.
- Each driver is configured **per instance**. Neither test touches a driver's global type registry.

## Correctness checks (must pass, on direct and PgBouncer connections)

| #  | Check | Why (RFC) |
| -- | ----- | --------- |
| K1 | `numeric` ↔ `Decimal` is lossless: 1,000 random values up to 30 integer digits and 12 decimals round-trip exactly, and `sum()` matches decimal.js | 0006 §7.9 |
| K2 | `bigint` ids parse into `number`, with an error above `Number.MAX_SAFE_INTEGER` | 0001 Q2 |
| K3 | Array parameters: `= ANY($1::bigint[])`, `unnest($1::bigint[], $2::numeric[])`, text arrays | 0004 §7.6, 0005 §7.9 |
| K4 | Transactions at `REPEATABLE READ`, nested savepoints with rollback-to, and `set_config(…, true)` visible only inside the transaction | 0003 §7.1, §7.5 |
| K5 | Errors expose SQLSTATE `code` plus `constraint`, `table` and `detail`: 23505 unique, 40001 serialization failure (two concurrent RR transactions), 57014 `statement_timeout` | 0003 §7.5, 0001 §7.7 |
| K6 | Prepared statements with stable SQL text work behind PgBouncer across many transactions and clients | 0005 §7.9 |
| K7 | Multi-row `INSERT … RETURNING id` returns ids in input order | 0004 §7.6 |
| K8 | `LISTEN` / `NOTIFY` delivery on a direct connection | events (0003 §10) |
| K9 | `COPY … FROM STDIN` without an extra dependency | Phase 5 bulk import |

K8 and K9 are scored, but they aren't disqualifying: a missing feature can be added with a separate dependency later.

## Benchmarks (median of 3 runs, pool size 10, concurrency 16)

| #  | Workload | Shape |
| -- | -------- | ----- |
| P1 | Point select by id | 20,000 queries |
| P2 | Batched load: 12 columns `WHERE id = ANY($1)` with 1,000 ids | 200 queries |
| P3 | Set-based update `UPDATE … FROM unnest($1::bigint[], $2::numeric[])` of 1,000 rows | 100 statements |
| P4 | Multi-row `INSERT … RETURNING id` of 1,000 rows | 50 statements |
| P5 | Read 100,000 rows × 4 `numeric` columns, parsed into `Decimal` | 3 queries |

Each workload runs both directly and through PgBouncer.

## Decision rule (fixed before measuring)

1. A driver that fails any of K1–K7 is out.
2. If both pass, compare the **geometric mean of throughput over P1–P5** (direct and PgBouncer). A difference of **≥ 15%** decides.
3. Otherwise decide on, in this order: per-instance configuration without global state, then K8/K9 built in, then the transitive
   dependency count (`CLAUDE.md`: minimize dependencies).

## Results

### Benchmarks

<!-- bench:start -->
Node v25.2.1, PostgreSQL 18.6, PgBouncer 1.26 (transaction pooling), pool 10, concurrency 16, median of 3 runs after a warm-up. Docker Desktop on win32/x64.

| Workload | Target | postgres | pg | postgres / pg |
| -------- | ------ | -------: | -: | ------------: |
| P1 Point select by id (queries/s) | direct | 13,506 | 11,656 | 1.16× |
| P1 Point select by id (queries/s) | bouncer | 8,555 | 7,641 | 1.12× |
| P2 Batched load, 1,000 ids (= ANY) (queries/s) | direct | 226 | 232 | 0.97× |
| P2 Batched load, 1,000 ids (= ANY) (queries/s) | bouncer | 152 | 142 | 1.07× |
| P3 Set-based update, 1,000 rows (unnest) (rows/s) | direct | 350,744 | 179,869 | 1.95× |
| P3 Set-based update, 1,000 rows (unnest) (rows/s) | bouncer | 307,296 | 171,949 | 1.79× |
| P4 Multi-row INSERT ... RETURNING, 1,000 rows (rows/s) | direct | 286,776 | 155,938 | 1.84× |
| P4 Multi-row INSERT ... RETURNING, 1,000 rows (rows/s) | bouncer | 230,578 | 154,043 | 1.50× |
| P5 Read 100,000 rows × 4 numeric → Decimal (rows/s) | direct | 410,603 | 237,200 | 1.73× |
| P5 Read 100,000 rows × 4 numeric → Decimal (rows/s) | bouncer | 252,469 | 278,971 | 0.91× |

**Geometric mean of postgres / pg over P1–P5 × {direct, bouncer}: 1.35×**
<!-- bench:end -->

Absolute numbers depend on the machine (Docker Desktop on Windows here), but the ratios are what decides. A second
full run gave a geometric mean of **1.35×** (vs 1.34×). P3 is the noisiest: the first run directly after the bulk load measured
1.90× / 1.77×, and the second run 1.95× / 1.79×.

Where the difference comes from: postgres.js pipelines and caches prepared statements per connection automatically, and it
parses rows with less per-row overhead. The gap is largest for many small statements (P1, P3, P4). For big result sets
(P5) and the batched `= ANY` loads (P2), both drivers are bound by PostgreSQL and by Decimal construction, so it's a tie.
That's also the evidence for RFC 0004's set-based design: one 1,000-row statement costs about as much as 4–7 point selects.

### Correctness

`spikes/driver-bench/test/driver.test.ts` runs against real PostgreSQL 18.6, directly and through PgBouncer.

| # | Check | postgres direct | postgres bouncer | pg direct | pg bouncer |
| - | ----- | :-: | :-: | :-: | :-: |
| K1 | numeric ↔ Decimal lossless | ✅ | ✅ | ✅ | ✅ |
| K2 | bigint → number with overflow guard | ✅ | ✅ | ✅ | ✅ |
| K3 | Array parameters | ✅ | ✅ | ✅ | ✅ |
| K4 | RR, nested savepoints, SET LOCAL scoping | ✅ | ✅ | ✅ | ✅ |
| K5 | SQLSTATE + constraint/table/detail (23505, 40001, 57014) | ✅ | ✅ | ✅ | ✅ |
| K6 | Prepared statements across transactions and 16 clients | ✅ | ✅ | ✅ | ✅ |
| K7 | INSERT … RETURNING keeps input order | ✅ | ✅ | ✅ | ✅ |
| K8 | LISTEN / NOTIFY | ✅ | n/a | ✅ | n/a |
| K9 | COPY FROM STDIN built in | ✅ | n/a | ❌ needs `pg-copy-streams` | n/a |

Notes:

- **Per-instance configuration works for both drivers.** postgres.js uses the `types` option, and pg uses the pool's `types.getTypeParser`.
  Neither needs the global `pg.types.setTypeParser`.
- **Error field names differ:** postgres.js has `constraint_name` / `table_name`, while pg has `constraint` / `table`. `@shutro/driver-pg`
  normalizes both, so this doesn't matter for the decision.
- **pg would JSON-stringify a Decimal parameter** (giving the quoted string `"1.5"`), so it needs explicit serialization, including
  inside arrays. postgres.js serializes through its `types.numeric.serialize`.
- **K7 holds empirically.** PostgreSQL returns `INSERT … SELECT … RETURNING` rows in insertion order, but the SQL standard doesn't
  guarantee it. RFC 0004's create path will therefore match returned rows by position *and* verify the count. A per-row
  ordinal column can be added later if PostgreSQL ever changes this.

### Finding outside the driver question: Decimal precision (RFC 0006)

K1 first failed on **both** drivers. Values round-tripped exactly, but `sum()` of 1,000 values with up to 42 significant
digits differed from PostgreSQL's exact `numeric` sum. The cause was RFC 0006's `Decimal.clone({ precision: 40 })`: decimal.js
rounds every arithmetic result to 40 *significant* digits. Unconstrained `numeric` monetary columns can hold more than that.
**RFC 0006 is amended to precision 64.**

## Decision

Under the decision rule:

1. Both drivers pass K1–K7.
2. The geometric mean is **1.34–1.35× in favour of postgres.js**, which is above the 15% threshold, so that decides it.
3. The tie-breakers agree anyway: postgres.js has **0 transitive dependencies** vs 12 for pg, and COPY is built in.

**→ `@shutro/driver-pg` wraps `postgres` (postgres.js).** The rationale, risks and mitigations are in RFC 0007.
