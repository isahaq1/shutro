/**
 * Compiled SQL executed on real PostgreSQL 18 (Testcontainers), through postgres.js as @shutro/driver-pg will (RFC 0007).
 */
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import fc from 'fast-check';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compile, type SqlFragment, sql } from '../src/index.js';

let pg: StartedPostgres;
let client: postgres.Sql;

/** Runs a fragment the way the driver will: compiled text + params, prepared. */
async function run<R extends Record<string, unknown>>(fragment: SqlFragment): Promise<R[]> {
  const { text, params } = compile(fragment);
  return [
    ...(await client.unsafe<R[]>(text, params as postgres.ParameterOrJSON<never>[], {
      prepare: true,
    })),
  ];
}

beforeAll(async () => {
  pg = await startPostgres();
  client = postgres(pg.url, { max: 2, onnotice: () => {} });
  await run(sql`CREATE TABLE ${sql.id('victim')} (${sql.id('id')} int PRIMARY KEY)`);
  await run(sql`INSERT INTO ${sql.id('victim')} VALUES (${1})`);
}, 180_000);

afterAll(async () => {
  await client?.end();
  await pg?.stop();
});

async function victimSurvives(): Promise<void> {
  const rows = await run<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.id('victim')}`);
  expect(rows[0]?.n).toBe(1);
}

describe('values round-trip as parameters', () => {
  test.each([
    ["'; DROP TABLE victim; --"],
    ["' OR '1'='1"],
    ['\\'],
    ["\\'; DROP TABLE victim; --"],
    ['$1'],
    ['$$; DROP TABLE victim; $$'],
    ["E'\\x27'"],
    ['/* comment */ DROP TABLE victim'],
    ['😀 unicode ✓ ŝ'],
    ['line\nbreak\ttab'],
  ])('injection payload %j', async (v) => {
    const rows = await run<{ v: string }>(sql`SELECT ${sql.param(v, 'text')} AS v`);
    expect(rows[0]?.v).toBe(v);
    await victimSurvives();
  });

  test('random strings round-trip exactly (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'binary', maxLength: 200 }).filter((s) => !s.includes('\u0000')),
        async (v) => {
          const rows = await run<{ v: string }>(sql`SELECT ${sql.param(v, 'text')} AS v`);
          expect(rows[0]?.v).toBe(v);
        },
      ),
      { numRuns: 200 },
    );
    await victimSurvives();
  });

  test('text and bigint arrays', async () => {
    const tags = ["it's", '"quoted"', 'a,b', '{braces}', 'NULL'];
    const rows = await run<{ v: string[] }>(sql`SELECT ${sql.array(tags, 'text')} AS v`);
    expect(rows[0]?.v).toEqual(tags);
    const hit = await run<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.id('victim')} WHERE ${sql.id('id')} = ANY(${sql.array([1, 2, 3], 'int')})`,
    );
    expect(hit[0]?.n).toBe(1);
  });
});

describe('identifiers', () => {
  test('reserved words work as table and column names when quoted', async () => {
    const order = sql.id('order');
    await run(sql`CREATE TABLE ${order} (${sql.id('user')} text, ${sql.id('select')} int)`);
    await run(
      sql`INSERT INTO ${order} (${sql.id('user')}, ${sql.id('select')}) VALUES (${'admin'}, ${1})`,
    );
    const rows = await run<{ user: string }>(
      sql`SELECT ${sql.id('o', 'user')} FROM ${order} AS ${sql.id('o')} WHERE ${sql.id('o', 'select')} = ${1}`,
    );
    expect(rows).toEqual([{ user: 'admin' }]);
  });
});

describe('stable text across values', () => {
  test('one prepared statement serves different values', async () => {
    const q = (id: number): SqlFragment =>
      sql`SELECT ${sql.id('id')} FROM ${sql.id('victim')} WHERE ${sql.id('id')} = ${id}`;
    expect(compile(q(1)).text).toBe(compile(q(2)).text);
    expect(await run(q(1))).toEqual([{ id: 1 }]);
    expect(await run(q(2))).toEqual([]);
  });
});
