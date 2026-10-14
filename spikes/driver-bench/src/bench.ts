/**
 * Spike 0002 benchmarks P1–P5, on both drivers, direct and through PgBouncer.
 * Usage: node spikes/driver-bench/src/bench.ts [--reps 3]
 * Writes results into docs/spikes/0002-driver-benchmark.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTargets } from './containers.ts';
import { Decimal, type Driver, type DriverName, drivers } from './drivers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const doc = resolve(here, '../../../docs/spikes/0002-driver-benchmark.md');
const repsArg = process.argv.indexOf('--reps');
const reps = repsArg >= 0 ? Number(process.argv[repsArg + 1] ?? '3') : 3;

const ROWS = 100_000;
const CONCURRENCY = 16;
const POOL = 10;

/** Runs `total` tasks with `CONCURRENCY` workers. */
async function parallel(total: number, task: (i: number) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < total) await task(next++);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return (performance.now() - start) / 1000;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Workload {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  /** Returns the number of units processed. */
  run(db: Driver, table: string, insertTable: string): Promise<number>;
}

const cols =
  'id, code, name, note, qty, price, discount, amount, seq, priority, active, date_order';

const workloads: readonly Workload[] = [
  {
    key: 'P1',
    label: 'Point select by id',
    unit: 'queries/s',
    async run(db, t) {
      const rnd = seeded(1);
      await parallel(20_000, () =>
        db.query(`SELECT ${cols} FROM ${t} WHERE id = $1`, [1 + Math.floor(rnd() * ROWS)]),
      );
      return 20_000;
    },
  },
  {
    key: 'P2',
    label: 'Batched load, 1,000 ids (= ANY)',
    unit: 'queries/s',
    async run(db, t) {
      const rnd = seeded(2);
      await parallel(200, () =>
        db.query(`SELECT ${cols} FROM ${t} WHERE id = ANY($1::bigint[])`, [
          Array.from({ length: 1000 }, () => 1 + Math.floor(rnd() * ROWS)),
        ]),
      );
      return 200;
    },
  },
  {
    key: 'P3',
    label: 'Set-based update, 1,000 rows (unnest)',
    unit: 'rows/s',
    async run(db, t) {
      await parallel(100, (i) => {
        const ids = Array.from({ length: 1000 }, (_, k) => i * 1000 + k + 1); // disjoint ranges: no lock waits
        const amounts = ids.map((id) => new Decimal(id).times('1.15').toDecimalPlaces(2));
        return db.query(
          `UPDATE ${t} AS x SET amount = v.amount FROM unnest($1::bigint[], $2::numeric[]) AS v(id, amount) WHERE x.id = v.id`,
          [ids, amounts],
        );
      });
      return 100 * 1000;
    },
  },
  {
    key: 'P4',
    label: 'Multi-row INSERT ... RETURNING, 1,000 rows',
    unit: 'rows/s',
    async run(db, _t, ins) {
      let batch = 0;
      await parallel(50, () => {
        const b = batch++;
        const codes = Array.from({ length: 1000 }, (_, k) => `b${b}-${k}-${Math.random()}`);
        const amounts = codes.map((_, k) => new Decimal(k).dividedBy(3).toDecimalPlaces(6));
        return db.query(
          `INSERT INTO ${ins} (code, amount) SELECT * FROM unnest($1::text[], $2::numeric[]) RETURNING id`,
          [codes, amounts],
        );
      });
      return 50 * 1000;
    },
  },
  {
    key: 'P5',
    label: 'Read 100,000 rows × 4 numeric → Decimal',
    unit: 'rows/s',
    async run(db, t) {
      for (let i = 0; i < 3; i++) {
        const rows = await db.query<{ amount: Decimal }>(
          `SELECT id, qty, price, discount, amount FROM ${t}`,
        );
        if (!(rows[0]?.amount instanceof Decimal)) throw new Error('numeric not parsed to Decimal');
      }
      return 3 * ROWS;
    },
  },
];

async function prepareTables(
  url: string,
  name: string,
): Promise<{ table: string; insertTable: string }> {
  const db = drivers.pg(url, 1);
  const table = `bench_${name}`;
  const insertTable = `bench_ins_${name}`;
  await db.query(`DROP TABLE IF EXISTS ${table}, ${insertTable}`);
  await db.query(`CREATE TABLE ${table} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL, name text NOT NULL, note text,
    qty numeric(20, 6), price numeric(20, 4), discount numeric(6, 2), amount numeric,
    seq integer, priority integer, active boolean, date_order timestamptz)`);
  await db.query(`INSERT INTO ${table} (code, name, note, qty, price, discount, amount, seq, priority, active, date_order)
    SELECT 'SO' || g, 'Product ' || g, repeat('x', 40), g % 97 + 0.125, g * 1.0001, g % 30, g * 3.3333333333,
           g % 1000, g % 5, g % 2 = 0, now() - (g || ' minutes')::interval
    FROM generate_series(1, ${ROWS}) g`);
  await db.query(
    `CREATE TABLE ${insertTable} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL, amount numeric)`,
  );
  await db.query(`VACUUM ANALYZE ${table}`);
  await db.end();
  return { table, insertTable };
}

const median = (xs: readonly number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

type Target = 'direct' | 'bouncer';
interface Result {
  readonly driver: DriverName;
  readonly target: Target;
  readonly workload: Workload;
  readonly perSecond: number;
}

const targets = await startTargets();
const results: Result[] = [];
try {
  const { table, insertTable } = await prepareTables(targets.direct, 'shared');
  for (const target of ['direct', 'bouncer'] as const) {
    for (const driver of ['postgres', 'pg'] as const) {
      const db = drivers[driver](targets[target], POOL);
      for (const w of workloads) {
        await w.run(db, table, insertTable); // warm-up: connections, prepared statements, JIT
        const runs: number[] = [];
        for (let r = 0; r < reps; r++) {
          let units = 0;
          const seconds = await timed(async () => {
            units = await w.run(db, table, insertTable);
          });
          runs.push(units / seconds);
        }
        const perSecond = median(runs);
        results.push({ driver, target, workload: w, perSecond });
        process.stdout.write(
          `${target.padEnd(7)} ${driver.padEnd(8)} ${w.key} ${perSecond.toFixed(0)} ${w.unit}\n`,
        );
      }
      await db.end();
    }
  }
} finally {
  await targets.stop();
}

// ------------------------------------------------------------------------------------------------- report

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
const get = (driver: DriverName, target: Target, key: string): number =>
  results.find((r) => r.driver === driver && r.target === target && r.workload.key === key)
    ?.perSecond ?? Number.NaN;
const lines: string[] = [
  `Node ${process.version}, PostgreSQL 18.6, PgBouncer 1.26 (transaction pooling), pool ${POOL}, concurrency ${CONCURRENCY}, median of ${reps} runs after a warm-up. Docker Desktop on ${process.platform}/${process.arch}.`,
  '',
  '| Workload | Target | postgres | pg | postgres / pg |',
  '| -------- | ------ | -------: | -: | ------------: |',
];
const ratios: number[] = [];
for (const w of workloads) {
  for (const target of ['direct', 'bouncer'] as const) {
    const a = get('postgres', target, w.key);
    const b = get('pg', target, w.key);
    ratios.push(a / b);
    lines.push(
      `| ${w.key} ${w.label} (${w.unit}) | ${target} | ${fmt(a)} | ${fmt(b)} | ${(a / b).toFixed(2)}× |`,
    );
  }
}
const geo = Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length);
lines.push(
  '',
  `**Geometric mean of postgres / pg over P1–P5 × {direct, bouncer}: ${geo.toFixed(2)}×**`,
);

const start = '<!-- bench:start -->';
const end = '<!-- bench:end -->';
const block = `${start}\n${lines.join('\n')}\n${end}`;
const current = readFileSync(doc, 'utf8');
writeFileSync(
  doc,
  current.includes(start)
    ? current.slice(0, current.indexOf(start)) +
        block +
        current.slice(current.indexOf(end) + end.length)
    : current.replace(
        '_Filled in by the spike runs._',
        `### Benchmarks\n\n${block}\n\n_Correctness results: see below._`,
      ),
);
process.stdout.write(
  `\ngeometric mean postgres/pg = ${geo.toFixed(2)}x\nResults written to ${doc}\n`,
);
