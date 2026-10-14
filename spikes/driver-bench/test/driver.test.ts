/**
 * Spike 0002 correctness checks K1–K9 (docs/spikes/0002-driver-benchmark.md), against real PostgreSQL 18,
 * directly and through PgBouncer in transaction mode.
 */
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { Decimal, type Driver, type DriverName, drivers } from '../src/drivers.ts';

const urls = { direct: inject('direct'), bouncer: inject('bouncer') } as const;
type Target = keyof typeof urls;
const combos: [DriverName, Target][] = [
  ['postgres', 'direct'],
  ['postgres', 'bouncer'],
  ['pg', 'direct'],
  ['pg', 'bouncer'],
];

/** Seeded PRNG so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDecimals(count: number): Decimal[] {
  const rnd = prng(7);
  const digits = (n: number): string =>
    Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');
  return Array.from({ length: count }, () => {
    const int = digits(1 + Math.floor(rnd() * 30)).replace(/^0+(?=\d)/, '');
    const frac = digits(Math.floor(rnd() * 13));
    const sign = rnd() < 0.3 ? '-' : '';
    return new Decimal(`${sign}${int}${frac ? `.${frac}` : ''}`);
  });
}

describe.each(combos)('%s via %s', (driverName, target) => {
  const t = `t_${driverName.replace('-', '_')}_${target}`;
  let db: Driver;

  beforeAll(async () => {
    db = drivers[driverName](urls[target], 10);
    await db.query(`DROP TABLE IF EXISTS ${t}`);
    await db.query(
      `CREATE TABLE ${t} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL UNIQUE, amount numeric, qty numeric(20, 6))`,
    );
  });
  afterAll(async () => {
    await db.end();
  });

  test('K1 numeric <-> Decimal is lossless', async () => {
    const values = randomDecimals(1000);
    const codes = values.map((_, i) => `k1-${i}`);
    await db.query(
      `INSERT INTO ${t} (code, amount) SELECT * FROM unnest($1::text[], $2::numeric[])`,
      [codes, values],
    );
    const rows = await db.query<{ code: string; amount: Decimal }>(
      `SELECT code, amount FROM ${t} WHERE code = ANY($1::text[]) ORDER BY id`,
      [codes],
    );
    expect(rows).toHaveLength(values.length);
    rows.forEach((row, i) => {
      expect(row.amount).toBeInstanceOf(Decimal);
      expect(row.amount.equals(values[i] ?? Number.NaN)).toBe(true);
    });
    const [sum] = await db.query<{ total: Decimal }>(
      `SELECT sum(amount) AS total FROM ${t} WHERE code = ANY($1::text[])`,
      [codes],
    );
    expect(sum?.total.equals(values.reduce((a, b) => a.plus(b), new Decimal(0)))).toBe(true);
    const [tenth] = await db.query<{ v: Decimal }>('SELECT 0.1::numeric + 0.2::numeric AS v');
    expect(tenth?.v.toString()).toBe('0.3');
  });

  test('K2 bigint ids parse to number, overflow is an error', async () => {
    const [ok] = await db.query<{ a: number }>('SELECT 9007199254740991::bigint AS a');
    expect(ok?.a).toBe(Number.MAX_SAFE_INTEGER);
    await expect(db.query('SELECT 9007199254740993::bigint AS a')).rejects.toThrow(
      /MAX_SAFE_INTEGER/,
    );
    const [row] = await db.query<{ id: number }>(`SELECT id FROM ${t} ORDER BY id LIMIT 1`);
    expect(typeof row?.id).toBe('number');
  });

  test('K3 array parameters: ANY(bigint[]), unnest(bigint[], numeric[]), text[]', async () => {
    const rows = await db.query<{ id: number }>(`SELECT id FROM ${t} ORDER BY id LIMIT 100`);
    const ids = rows.map((r) => r.id);
    const [count] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t} WHERE id = ANY($1::bigint[])`,
      [ids],
    );
    expect(count?.n).toBe(100);
    const amounts = ids.map((id) => new Decimal(id).dividedBy(7).toDecimalPlaces(10));
    const updated = await db.query<{ id: number }>(
      `UPDATE ${t} AS x SET amount = v.amount FROM unnest($1::bigint[], $2::numeric[]) AS v(id, amount) WHERE x.id = v.id RETURNING x.id`,
      [ids, amounts],
    );
    expect(updated).toHaveLength(100);
    const back = await db.query<{ id: number; amount: Decimal }>(
      `SELECT id, amount FROM ${t} WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ids],
    );
    back.forEach((r, i) => {
      expect(r.amount.equals(amounts[i] ?? Number.NaN)).toBe(true);
    });
    const [none] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t} WHERE id = ANY($1::bigint[])`,
      [[]],
    );
    expect(none?.n).toBe(0);
  });

  test('K4 repeatable read, nested savepoints, SET LOCAL scoped to the transaction', async () => {
    await db.transaction('repeatable read', async (tx) => {
      const [iso] = await tx.query<{ v: string }>(
        `SELECT current_setting('transaction_isolation') AS v`,
      );
      expect(iso?.v).toBe('repeatable read');
      await tx.query(`SELECT set_config('shutro.user_id', '42', true)`);
      const [user] = await tx.query<{ v: string }>(
        `SELECT current_setting('shutro.user_id', true) AS v`,
      );
      expect(user?.v).toBe('42');

      await expect(
        tx.savepoint(async (sp) => {
          await sp.query(`INSERT INTO ${t} (code) VALUES ('k4-rolled-back')`);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await tx.savepoint(async (sp) => {
        await sp.query(`INSERT INTO ${t} (code) VALUES ('k4-outer')`);
        await sp.savepoint(async (inner) => {
          await inner.query(`INSERT INTO ${t} (code) VALUES ('k4-inner')`);
        });
      });
    });
    const rows = await db.query<{ code: string }>(
      `SELECT code FROM ${t} WHERE code LIKE 'k4-%' ORDER BY code`,
    );
    expect(rows.map((r) => r.code)).toEqual(['k4-inner', 'k4-outer']);
    // After commit the setting is gone, on whichever server connection we land (PgBouncer may reuse it).
    for (let i = 0; i < 20; i++) {
      const [after] = await db.query<{ v: string | null }>(
        `SELECT current_setting('shutro.user_id', true) AS v`,
      );
      expect(after?.v ?? '').toBe('');
    }
  });

  test('K5 errors expose SQLSTATE, constraint, table and detail', async () => {
    const unique = await db
      .query(`INSERT INTO ${t} (code) VALUES ('k4-outer')`)
      .catch((e: unknown) => e);
    expect(db.normalizeError(unique)).toMatchObject({
      code: '23505',
      constraint: `${t}_code_key`,
      table: t,
    });
    expect(db.normalizeError(unique).detail).toMatch(/k4-outer/);

    const [row] = await db.query<{ id: number }>(`SELECT id FROM ${t} WHERE code = 'k4-outer'`);
    const serialization = await db
      .transaction('repeatable read', async (tx1) => {
        await tx1.query(`SELECT amount FROM ${t} WHERE id = $1`, [row?.id]);
        await db.transaction('repeatable read', (tx2) =>
          tx2.query(`UPDATE ${t} SET amount = 1 WHERE id = $1`, [row?.id]),
        );
        await tx1.query(`UPDATE ${t} SET amount = 2 WHERE id = $1`, [row?.id]);
      })
      .catch((e: unknown) => e);
    expect(db.normalizeError(serialization).code).toBe('40001');

    const timeout = await db
      .transaction('read committed', async (tx) => {
        await tx.query(`SELECT set_config('statement_timeout', '100', true)`);
        await tx.query('SELECT pg_sleep(2)');
      })
      .catch((e: unknown) => e);
    expect(db.normalizeError(timeout).code).toBe('57014');
  });

  test('K6 prepared statements stay valid across many transactions and clients', async () => {
    const [row] = await db.query<{ id: number }>(`SELECT id FROM ${t} ORDER BY id LIMIT 1`);
    const id = row?.id;
    let done = 0;
    const worker = async (): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        await db.transaction('read committed', async (tx) => {
          await tx.query(`SELECT code FROM ${t} WHERE id = $1`, [id]);
          await tx.query(`SELECT count(*)::int AS n FROM ${t} WHERE id = ANY($1::bigint[])`, [
            [id],
          ]);
          await tx.query(`UPDATE ${t} SET qty = $2 WHERE id = $1`, [id, new Decimal(i)]);
        });
        await db.query(`SELECT code FROM ${t} WHERE id = $1`, [id]);
        done++;
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    expect(done).toBe(16 * 60);
  });

  test('K7 multi-row INSERT ... RETURNING keeps input order', async () => {
    const codes = Array.from({ length: 500 }, (_, i) => `k7-${String(499 - i).padStart(3, '0')}`);
    const rows = await db.query<{ id: number; code: string }>(
      `INSERT INTO ${t} (code) SELECT * FROM unnest($1::text[]) RETURNING id, code`,
      [codes],
    );
    expect(rows.map((r) => r.code)).toEqual(codes);
    const ids = rows.map((r) => r.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  test.runIf(target === 'direct')('K8 LISTEN / NOTIFY', async () => {
    const received: string[] = [];
    const stop = await db.listen(`k8_${driverName}`, (payload) => received.push(payload));
    await db.query('SELECT pg_notify($1, $2)', [`k8_${driverName}`, 'sale.order:42']);
    for (let i = 0; i < 50 && received.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await stop();
    expect(received).toEqual(['sale.order:42']);
  });

  test.runIf(target === 'direct')('K9 COPY FROM STDIN built in', async () => {
    if (db.copyIn === undefined) {
      expect
        .soft(db.copyIn, `${driverName} has no built-in COPY (needs pg-copy-streams)`)
        .toBeUndefined();
      return;
    }
    const lines = Array.from({ length: 1000 }, (_, i) => `k9-${i}\t${i}.25`);
    await db.copyIn(`COPY ${t} (code, amount) FROM STDIN`, lines);
    const [count] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${t} WHERE code LIKE 'k9-%'`,
    );
    expect(count?.n).toBe(1000);
  });
});
