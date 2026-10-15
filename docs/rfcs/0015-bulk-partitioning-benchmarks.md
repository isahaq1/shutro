# RFC 0015 — Bulk operations, partitioning and benchmarks

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/core` (`ModelRef.copy`, `partition` option, partition helpers, batched nested creates), `@shutro/migrate` (partitioned tables), `benchmarks/` and CI
- **Related:** 0004 §7.6 (writes), 0007 (driver `copyIn`), 0013 / 0014 (audit and rules on bulk paths)

## 1. Summary

1. **`env.model(M).copy(rows)`**: bulk create through `COPY ... FROM STDIN` with exactly the semantics of `create()`
   — validation, defaults, sequences, computes and constraints at the flush point, audit rows, create rules — and
   one streamed statement instead of one INSERT per 1,000 rows. Needs the `import` permission (RFC 0014).
2. **Partitioned models**: `partition: { by: 'range' | 'list' | 'hash', key }` makes the table `PARTITION BY`, with
   `(id, key)` as primary key; `partitionStatements` / `rangePartitions` create partitions ahead of time.
3. **Benchmarks in CI**: `benchmarks/` runs ORM scenarios against PostgreSQL; **query budgets** fail the build,
   timings are uploaded as an artifact.
4. Found by the benchmarks and fixed: nested `one2many` creates are batched across parents (was one INSERT per
   parent), and binary values given to `create()` are written (the column list came from the default projection).

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Imports of 10⁵–10⁶ rows (opening balances, product catalogs, migrations from another ERP) in minutes, not hours. |
| R2  | Bulk paths must not be a security or consistency bypass: same rules, computes, constraints, audit. |
| R3  | Append-heavy tables (journal items, stock moves, logs) stay fast to query and cheap to archive by period. |
| R4  | Performance regressions (an N+1, a lost batch) are caught in CI before release. |

## 3. How Odoo does it

`load()` / `_load_records` for imports creates records one by one through `create` (batched by `create_multi`
since 13); there is no COPY path, so large imports are slow and people bypass the ORM with SQL (and with it,
security and computed fields). No partitioning support. Performance tests exist (`assertQueryCount`) but are per
test, not tracked across releases.

## 4. Options and decision

- **COPY directly into the table** (chosen) after reserving ids from the identity sequence: `COPY FROM` writes
  identity values as given (unlike INSERT, which needs `OVERRIDING SYSTEM VALUE`), so ids are known in input order
  without `RETURNING`, and every post-insert step of `create()` (cache, journal, triggers, audit, rules) runs
  unchanged. A staging table + `INSERT ... SELECT` was rejected: `RETURNING` order is not guaranteed.
- **Declarative partitioning** with a composite primary key (chosen) over hand-written DDL; many2one references
  *into* a partitioned model are a build error, because a foreign key would need the partition key too.
- **Query budgets** as the CI gate (chosen) over timing thresholds: deterministic on shared runners.

## 5. Detailed design

### 5.1 COPY

`copy(rows)`: ACL `create` + `import`; rows prepared exactly as `create()` (x2many commands not accepted); one
`SELECT nextval(pg_get_serial_sequence(table, 'id')) FROM generate_series(1, n)`; one `COPY table (id, cols) FROM
STDIN` with values in COPY text format (`\N` for null, backslash escapes for `\`, tab, newline, CR, bytea as
`\\x` hex), streamed through the scope's connection (`ScopeInternals.copyIn`, counted, errors mapped like other
statements). Encrypted fields are encrypted, JSON is serialized, translations merged, as for `create()`.

### 5.2 Partitioning

- `defineModel({ partition: { by, key } })`: the key must be a required stored field; unique constraints must
  include it (PostgreSQL enforces uniqueness per partition only then).
- DDL (stopgap and migrator): `CREATE TABLE t (...) PARTITION BY RANGE (col)` with `PRIMARY KEY (id, col)`; the
  migrator's catalog reads partitioned parents (`relkind 'p'`) and skips partitions (`relispartition`), so
  partitions are never reported as unknown tables; partitions are not diffed.
- `partitionStatements(model, bounds)` — range `{ from, to }`, list `{ values }`, hash `{ modulus, remainder }`,
  `{ default: true }`; `rangePartitions(model, { from: '2026-01', to: '2027-01', interval })` names them
  `<table>_YYYY_MM`. A row outside every partition is a driver error worded "No partition accepts the row".
- Many2one into a partitioned model: `InvalidRelationError` at `buildRegistry`. one2many from it is fine.

### 5.3 Benchmarks

`benchmarks/src/orm.bench.test.ts` (`pnpm bench`, `BENCH_ORDERS` to scale): create orders with nested lines,
COPY of lines, search + nested load under record rules, bulk write + two-level recompute. Each asserts a query
budget that does not grow with the data size (except per 1,000-row chunks) and writes `benchmarks/results.json`.
CI job `bench` runs 5,000 orders after `check` and uploads the results.

## 6. Results (local, 1,000 orders × 3 lines, PostgreSQL 18 in Docker)

| Scenario | Records | Queries | Time |
| -------- | ------: | ------: | ---: |
| create with nested lines (before the fix) | 4,000 | 1,006 | 1,026 ms |
| create with nested lines | 4,000 | 9 | 652 ms |
| COPY lines | 3,000 | 8 | 329 ms |
| search + load (partner, lines) with rules | 4,000 | 3 | 87 ms |
| write 3,000 lines + recompute lines and orders | 3,000 | 6 | 321 ms |

## 7. Deferred

- `COPY` for updates (staging table + `UPDATE ... FROM`) and for exports (`COPY TO` with field security applied).
- Automatic creation of upcoming range partitions; detaching / archiving old partitions.
- Timing baselines with tolerance bands once a dedicated runner exists.
