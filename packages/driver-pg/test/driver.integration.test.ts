/**
 * @shutro/driver-pg against real PostgreSQL 18, directly and through PgBouncer (transaction pooling).
 * This is the permanent version of spike 0002's checks K1–K9 (RFC 0007 §8).
 */
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { Decimal as DecimalJs } from 'decimal.js';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ConstraintViolationError,
  createDriver,
  type Driver,
  DriverError,
  ReadOnlyTransactionError,
  SerializationFailureError,
  StatementTimeoutError,
} from '../src/index.js';

const Decimal = DecimalJs.clone({ precision: 64 });

let pg: StartedPostgres;
beforeAll(async () => {
  pg = await startPostgres({ pgbouncer: true });
}, 300_000);
afterAll(async () => {
  await pg?.stop();
});

const targets = ['direct', 'bouncer'] as const;

describe.each(targets)('via %s', (target) => {
  const table = `items_${target}`;
  const t = sql.id(table);
  let db: Driver;

  beforeAll(async () => {
    const url = target === 'direct' ? pg.url : pg.bouncerUrl;
    if (url === undefined) throw new Error('PgBouncer was not started');
    db = createDriver({ url, max: 10, parseNumeric: (text) => new Decimal(text) });
    await db.query(compile(sql`DROP TABLE IF EXISTS ${t}`));
    await db.query(
      compile(sql`CREATE TABLE ${t} (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        code text NOT NULL UNIQUE,
        amount numeric,
        day date
      )`),
    );
  });
  afterAll(async () => {
    await db?.end();
  });

  test('K1 numeric → injected parser (Decimal), lossless, including arrays of params', async () => {
    const values = [
      '123456789012345678901234567890.123456789012',
      '-0.000000000001',
      '0',
      '85000.00',
    ];
    const codes = values.map((_, i) => `k1-${i}`);
    await db.query(
      compile(
        sql`INSERT INTO ${t} (code, amount) SELECT * FROM unnest(${sql.array(codes, 'text')}, ${sql.array(
          values.map((v) => new Decimal(v)),
          'numeric',
        )})`,
      ),
    );
    const rows = await db.query<{ amount: DecimalJs }>(
      compile(
        sql`SELECT amount FROM ${t} WHERE code = ANY(${sql.array(codes, 'text')}) ORDER BY id`,
      ),
    );
    expect(rows.map((r) => r.amount.toFixed())).toEqual(
      values.map((v) => new Decimal(v).toFixed()),
    );
    expect(rows[0]?.amount).toBeInstanceOf(DecimalJs);
  });

  test('K1 property: random decimal strings round-trip exactly', async () => {
    const decimal = fc
      .tuple(fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n }), fc.integer({ min: 0, max: 20 }))
      .map(([n, s]) => new Decimal(n.toString()).dividedBy(new Decimal(10).pow(s)));
    await fc.assert(
      fc.asyncProperty(decimal, async (v) => {
        const [row] = await db.query<{ v: DecimalJs }>(
          compile(sql`SELECT ${sql.param(v, 'numeric')} AS v`),
        );
        expect(row?.v.eq(v)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test('numeric defaults to the exact string when no parser is injected', async () => {
    const url = target === 'direct' ? pg.url : (pg.bouncerUrl ?? '');
    const plain = createDriver({ url, max: 1 });
    const [row] = await plain.query<{ v: string }>(compile(sql`SELECT 1.50::numeric AS v`));
    expect(row?.v).toBe('1.50');
    await plain.end();
  });

  test('K2 bigint → safe number (also in arrays); overflow is a typed error', async () => {
    const [row] = await db.query<{ a: number; xs: number[] }>(
      compile(sql`SELECT 9007199254740991::bigint AS a, ARRAY[1, 2]::bigint[] AS xs`),
    );
    expect(row).toEqual({ a: Number.MAX_SAFE_INTEGER, xs: [1, 2] });
    const err = await db
      .query(compile(sql`SELECT 9007199254740993::bigint AS a`))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('BIGINT_OUT_OF_RANGE');
  });

  test('date columns come back as YYYY-MM-DD strings, never JS Date', async () => {
    const [row] = await db.query<{ d: string }>(compile(sql`SELECT DATE '2026-10-14' AS d`));
    expect(row?.d).toBe('2026-10-14');
  });

  test('K4 transactions: default repeatable read, settings scoped, savepoints', async () => {
    await db.transaction({ settings: { 'shutro.user_id': '42' } }, async (tx) => {
      const [iso] = await tx.query<{ v: string }>(
        compile(sql`SELECT current_setting('transaction_isolation') AS v`),
      );
      expect(iso?.v).toBe('repeatable read');
      const [user] = await tx.query<{ v: string }>(
        compile(sql`SELECT current_setting('shutro.user_id', true) AS v`),
      );
      expect(user?.v).toBe('42');
      await expect(
        tx.savepoint(async (sp) => {
          await sp.query(compile(sql`INSERT INTO ${t} (code) VALUES (${'k4-rolled-back'})`));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await tx.savepoint((sp) =>
        sp.query(compile(sql`INSERT INTO ${t} (code) VALUES (${'k4-kept'})`)),
      );
    });
    const rows = await db.query<{ code: string }>(
      compile(sql`SELECT code FROM ${t} WHERE code LIKE 'k4-%'`),
    );
    expect(rows.map((r) => r.code)).toEqual(['k4-kept']);
    for (let i = 0; i < 10; i++) {
      const [after] = await db.query<{ v: string | null }>(
        compile(sql`SELECT current_setting('shutro.user_id', true) AS v`),
      );
      expect(after?.v ?? '').toBe('');
    }
  });

  test('read-only transactions reject writes with a typed error', async () => {
    const err = await db
      .transaction({ readOnly: true }, (tx) =>
        tx.query(compile(sql`INSERT INTO ${t} (code) VALUES (${'ro'})`)),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadOnlyTransactionError);
  });

  test('statement timeout from transaction options', async () => {
    const err = await db
      .transaction({ statementTimeoutMs: 100 }, (tx) => tx.query(compile(sql`SELECT pg_sleep(2)`)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatementTimeoutError);
  });

  test('invalid setting names are rejected before the transaction starts', async () => {
    const err = await db
      .transaction({ settings: { 'bad name; drop': 'x' } }, async () => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('INVALID_SETTING');
  });

  test('K5 constraint violations and serialization failures are typed', async () => {
    const unique = await db
      .query(compile(sql`INSERT INTO ${t} (code) VALUES (${'k4-kept'})`))
      .catch((e: unknown) => e);
    expect(unique).toBeInstanceOf(ConstraintViolationError);
    expect(unique).toMatchObject({ kind: 'unique', constraint: `${table}_code_key`, table });

    const [row] = await db.query<{ id: number }>(
      compile(sql`SELECT id FROM ${t} WHERE code = ${'k4-kept'}`),
    );
    const conflict = await db
      .transaction({}, async (tx1) => {
        await tx1.query(compile(sql`SELECT amount FROM ${t} WHERE id = ${row?.id ?? 0}`));
        await db.transaction({}, (tx2) =>
          tx2.query(compile(sql`UPDATE ${t} SET amount = 1 WHERE id = ${row?.id ?? 0}`)),
        );
        await tx1.query(compile(sql`UPDATE ${t} SET amount = 2 WHERE id = ${row?.id ?? 0}`));
      })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(SerializationFailureError);
    expect((conflict as SerializationFailureError).retryable).toBe(true);
  });

  test('K6 prepared statements across many transactions and clients', async () => {
    let done = 0;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (let i = 0; i < 40; i++) {
          await db.transaction({ isolation: 'read committed' }, async (tx) => {
            await tx.query(
              compile(
                sql`SELECT count(*)::int AS n FROM ${t} WHERE id = ANY(${sql.array([1, 2], 'bigint')})`,
              ),
            );
            await tx.query(compile(sql`SELECT code FROM ${t} WHERE code = ${'k4-kept'}`));
          });
          done++;
        }
      }),
    );
    expect(done).toBe(640);
  });

  test('K7 INSERT ... RETURNING keeps input order', async () => {
    const codes = Array.from({ length: 300 }, (_, i) => `k7-${String(299 - i).padStart(3, '0')}`);
    const rows = await db.query<{ code: string }>(
      compile(
        sql`INSERT INTO ${t} (code) SELECT * FROM unnest(${sql.array(codes, 'text')}) RETURNING code`,
      ),
    );
    expect(rows.map((r) => r.code)).toEqual(codes);
  });

  test('stream() yields batches from a server-side cursor', async () => {
    const batches: number[] = [];
    await db.transaction({}, async (tx) => {
      for await (const batch of tx.stream<{ n: number }>(
        compile(sql`SELECT g AS n FROM generate_series(1, ${10_000}) g`),
        1_000,
      )) {
        batches.push(batch.length);
      }
    });
    expect(batches).toEqual(Array.from({ length: 10 }, () => 1_000));
  });

  test('the dev-mode guard rejects a value that was also pasted into the SQL text', async () => {
    // A hand-built query that interpolated a value into the text *and* passed it as a parameter.
    const value = 'customer-supplied-value';
    const err = await db
      .query({ text: `SELECT '${value}' AS a, $1::text AS b`, params: [value] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('PARAM_IN_TEXT');
  });
});

describe('direct-only features', () => {
  let db: Driver;
  beforeAll(() => {
    db = createDriver({ url: pg.url, max: 4 });
  });
  afterAll(async () => {
    await db?.end();
  });

  test('K8 LISTEN / NOTIFY', async () => {
    const received: string[] = [];
    const unlisten = await db.listen('shutro_outbox', (payload) => received.push(payload));
    await db.query(compile(sql`SELECT pg_notify(${'shutro_outbox'}, ${'sale.order:42'})`));
    for (let i = 0; i < 50 && received.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    await unlisten();
    expect(received).toEqual(['sale.order:42']);
  });

  test('K9 COPY FROM STDIN returns the number of rows written', async () => {
    await db.query(compile(sql`CREATE TABLE ${sql.id('copy_target')} (code text, amount numeric)`));
    const written = await db.transaction({}, (tx) =>
      tx.copyIn(
        compile(sql`COPY ${sql.id('copy_target')} (code, amount) FROM STDIN`),
        Array.from({ length: 1000 }, (_, i) => `c-${i}\t${i}.25`),
      ),
    );
    expect(written).toBe(1000);
    const [row] = await db.query<{ n: number }>(
      compile(sql`SELECT count(*)::int AS n FROM ${sql.id('copy_target')}`),
    );
    expect(row?.n).toBe(1000);
  });

  test('the param-in-text guard can be disabled', async () => {
    const lax = createDriver({ url: pg.url, max: 1, checkParamsInText: false });
    const rows = await lax.query<{ a: string }>({
      text: "SELECT 'repeated-value' AS a, $1::text AS b",
      params: ['repeated-value'],
    });
    expect(rows[0]?.a).toBe('repeated-value');
    await lax.end();
  });
});
