/**
 * The query builder against real PostgreSQL 18, executed through postgres.js as @shutro/driver-pg does.
 */
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { compile, createQueryBuilder, type Query, type RowOf, sql } from '../src/index.js';

interface Db {
  partner: { id: number; name: string; country: string | null };
  orders: { id: number; partner_id: number; state: string; total: string; day: string | null };
}
const qb = createQueryBuilder<Db>();

let pg: StartedPostgres;
let client: postgres.Sql;

async function run<Q extends Query>(query: Q): Promise<RowOf<Q>[]> {
  const { text, params } = query.compile();
  return [
    ...(await client.unsafe<RowOf<Q>[]>(text, params as postgres.ParameterOrJSON<never>[], {
      prepare: true,
    })),
  ];
}

beforeAll(async () => {
  pg = await startPostgres();
  client = postgres(pg.url, { max: 2, onnotice: () => {} });
  await client.unsafe(
    compile(sql`CREATE TABLE partner (id serial PRIMARY KEY, name text NOT NULL, country text)`)
      .text,
  );
  await client.unsafe(
    compile(
      sql`CREATE TABLE orders (id serial PRIMARY KEY, partner_id int NOT NULL REFERENCES partner(id), state text NOT NULL DEFAULT 'draft', total numeric NOT NULL DEFAULT 0, day date)`,
    ).text,
  );
}, 180_000);

afterAll(async () => {
  await client?.end();
  await pg?.stop();
});

describe('end to end', () => {
  test('insert returning, update, select with joins/aggregates/grouping sets, delete', async () => {
    const partners = await run(
      qb
        .insertInto('partner')
        .values([{ name: 'Acme', country: 'BD' }, { name: "O'Brien" }])
        .returning(['id', 'name']),
    );
    expect(partners.map((p) => p.name)).toEqual(['Acme', "O'Brien"]);
    const [acme, obrien] = partners;
    if (acme === undefined || obrien === undefined) throw new Error('inserts failed');

    const orders = await run(
      qb
        .insertInto('orders')
        .values([
          { partner_id: acme.id, state: 'sale', total: '100.50', day: '2026-10-01' },
          { partner_id: acme.id, state: 'sale', total: '50.25' },
          { partner_id: obrien.id, total: '7' },
        ])
        .returning(['id', 'state']),
    );
    expect(orders.map((o) => o.state)).toEqual(['sale', 'sale', 'draft']);

    const updated = await run(
      qb
        .updateTable('orders')
        .set({ state: 'sale' })
        .where('state', '=', 'draft')
        .returning(['id']),
    );
    expect(updated).toHaveLength(1);

    const report = await run(
      qb
        .selectFrom('orders as o')
        .innerJoin('partner as p', 'p.id', 'o.partner_id')
        .select(['p.name'])
        .select((eb) => [
          eb.fn.sum('o.total').as('total'),
          eb.fn.count().as('n'),
          eb.fn.grouping(['p.name']).as('g'),
        ])
        .groupingSets([['p.name'], []])
        .orderBy('p.name', 'asc', { nulls: 'last' }),
    );
    expect(report.map((r) => [r.name, String(r.total), Number(r.n), Number(r.g)])).toEqual([
      ['Acme', '150.75', 2, 0],
      ["O'Brien", '7', 1, 0],
      [null, '157.75', 3, 1],
    ]);

    const big = await run(
      qb
        .selectFrom('orders as o')
        .select(['o.id', 'o.total'])
        .where((eb) => eb.or([eb('o.total', '>', '100'), eb('o.day', 'is', null)]))
        .where('o.partner_id', 'in', [acme.id])
        .orderBy('o.total', 'desc')
        .limit(1),
    );
    expect(big.map((r) => String(r.total))).toEqual(['100.50']);

    const withCte = await run(
      qb
        .with('acme_orders', (q) =>
          q
            .selectFrom('orders as o')
            .select(['o.id', 'o.total'])
            .where('o.partner_id', '=', acme.id),
        )
        .selectFrom('acme_orders')
        .select((eb) => [eb.fn.count().as('n')]),
    );
    expect(Number(withCte[0]?.n)).toBe(2);

    const exists = await run(
      qb
        .selectFrom('partner as p')
        .select(['p.name'])
        .where((eb) =>
          eb.exists(
            qb
              .selectFrom('orders as o')
              .select(['o.id'])
              .where('o.partner_id', '=', eb.col('p.id'))
              .where('o.total', '>', '60'),
          ),
        ),
    );
    expect(exists.map((r) => r.name)).toEqual(['Acme']);

    const deleted = await run(
      qb.deleteFrom('orders').where('partner_id', '=', obrien.id).returning(['id']),
    );
    expect(deleted).toHaveLength(1);
  });

  test('injection payloads through the builder round-trip as values', async () => {
    const name = "x'); DROP TABLE partner; --";
    const [row] = await run(qb.insertInto('partner').values([{ name }]).returning(['name']));
    expect(row?.name).toBe(name);
    const [found] = await run(qb.selectFrom('partner').select(['name']).where('name', '=', name));
    expect(found?.name).toBe(name);
    const [count] = await run(qb.selectFrom('partner').select((eb) => [eb.fn.count().as('n')]));
    expect(Number(count?.n)).toBeGreaterThan(0);
  });
});
