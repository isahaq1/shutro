import { describe, expect, test } from 'vitest';
import { createQueryBuilder, SqlError, sql } from '../src/index.js';

interface Db {
  sale_order: {
    id: number;
    name: string;
    state: string;
    partner_id: number;
    company_id: number;
    amount_total: string;
    date_order: Date | null;
  };
  res_partner: { id: number; name: string; country_id: number | null };
  sale_order_line: { id: number; order_id: number; subtotal: string };
}

const qb = createQueryBuilder<Db>();

describe('select', () => {
  test('columns, aliases, table alias', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .select(['so.id', 'so.name as reference', 'state'])
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."id", "so"."name" AS "reference", "state" FROM "sale_order" AS "so"',
      params: [],
    });
  });

  test('selectAll and a table without alias', () => {
    expect(qb.selectFrom('res_partner').selectAll().compile().text).toBe(
      'SELECT * FROM "res_partner"',
    );
  });

  test('where: comparisons become parameters, several where() calls are ANDed', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .select(['so.id'])
      .where('so.state', '=', 'sale')
      .where('so.amount_total', '>=', '100.00')
      .where('so.name', 'ilike', '%SO%')
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."id" FROM "sale_order" AS "so" WHERE "so"."state" = $1 AND "so"."amount_total" >= $2 AND "so"."name" ILIKE $3',
      params: ['sale', '100.00', '%SO%'],
    });
  });

  test('in / not in use one array parameter (stable text); empty lists fold to constants', () => {
    const q = qb
      .selectFrom('sale_order')
      .select(['id'])
      .where('id', 'in', [1, 2, 3])
      .where('state', 'not in', ['cancel'])
      .compile();
    expect(q).toEqual({
      text: 'SELECT "id" FROM "sale_order" WHERE "id" = ANY($1) AND "state" <> ALL($2)',
      params: [[1, 2, 3], ['cancel']],
    });
    expect(qb.selectFrom('sale_order').select(['id']).where('id', 'in', []).compile().text).toBe(
      'SELECT "id" FROM "sale_order" WHERE FALSE',
    );
    expect(
      qb.selectFrom('sale_order').select(['id']).where('id', 'not in', []).compile().text,
    ).toBe('SELECT "id" FROM "sale_order" WHERE TRUE');
  });

  test('is null / is not null / is distinct from', () => {
    const q = qb
      .selectFrom('res_partner as p')
      .select(['p.id'])
      .where('p.country_id', 'is', null)
      .where('p.name', 'is not', null)
      .where('p.name', 'is distinct from', 'x')
      .compile();
    expect(q).toEqual({
      text: 'SELECT "p"."id" FROM "res_partner" AS "p" WHERE "p"."country_id" IS NULL AND "p"."name" IS NOT NULL AND "p"."name" IS DISTINCT FROM $1',
      params: ['x'],
    });
  });

  test('and / or / not via the expression builder; column-to-column comparisons', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .select(['so.id'])
      .where((eb) =>
        eb.or([
          eb.and([eb('so.state', '=', 'sale'), eb('so.amount_total', '>', '0')]),
          eb.not(eb('so.partner_id', '=', eb.col('so.company_id'))),
        ]),
      )
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."id" FROM "sale_order" AS "so" WHERE (("so"."state" = $1 AND "so"."amount_total" > $2) OR NOT ("so"."partner_id" = "so"."company_id"))',
      params: ['sale', '0'],
    });
  });

  test('joins', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .innerJoin('res_partner as p', 'p.id', 'so.partner_id')
      .leftJoin('sale_order_line as l', (eb) =>
        eb.and([eb('l.order_id', '=', eb.col('so.id')), eb('l.subtotal', '>', '0')]),
      )
      .select(['so.id', 'p.name as partner', 'l.subtotal'])
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."id", "p"."name" AS "partner", "l"."subtotal" FROM "sale_order" AS "so" INNER JOIN "res_partner" AS "p" ON "p"."id" = "so"."partner_id" LEFT JOIN "sale_order_line" AS "l" ON ("l"."order_id" = "so"."id" AND "l"."subtotal" > $1)',
      params: ['0'],
    });
  });

  test('aggregates, group by, having', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .innerJoin('sale_order_line as l', 'l.order_id', 'so.id')
      .select(['so.partner_id'])
      .select((eb) => [
        eb.fn.sum('l.subtotal').as('total'),
        eb.fn.count().as('lines'),
        eb.fn.count('so.id', { distinct: true }).as('orders'),
        eb.fn.max('so.date_order').as('last'),
      ])
      .groupBy(['so.partner_id'])
      .having((eb) => eb(eb.fn.sum('l.subtotal'), '>', '1000'))
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."partner_id", sum("l"."subtotal") AS "total", count(*) AS "lines", count(DISTINCT "so"."id") AS "orders", max("so"."date_order") AS "last" FROM "sale_order" AS "so" INNER JOIN "sale_order_line" AS "l" ON "l"."order_id" = "so"."id" GROUP BY "so"."partner_id" HAVING sum("l"."subtotal") > $1',
      params: ['1000'],
    });
  });

  test('GROUPING SETS and grouping()', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .select(['so.partner_id', 'so.state'])
      .select((eb) => [
        eb.fn.sum('so.amount_total').as('total'),
        eb.fn.grouping(['so.partner_id', 'so.state']).as('level'),
      ])
      .groupingSets([['so.partner_id', 'so.state'], ['so.partner_id'], []])
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."partner_id", "so"."state", sum("so"."amount_total") AS "total", grouping("so"."partner_id", "so"."state") AS "level" FROM "sale_order" AS "so" GROUP BY GROUPING SETS (("so"."partner_id", "so"."state"), ("so"."partner_id"), ())',
      params: [],
    });
  });

  test('order by, limit, offset (limit/offset are parameters)', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .select(['so.id'])
      .orderBy('so.date_order', 'desc', { nulls: 'last' })
      .orderBy('so.id')
      .limit(80)
      .offset(160)
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."id" FROM "sale_order" AS "so" ORDER BY "so"."date_order" DESC NULLS LAST, "so"."id" ASC LIMIT $1 OFFSET $2',
      params: [80, 160],
    });
  });

  test('subqueries: exists and in', () => {
    const lines = qb
      .selectFrom('sale_order_line as l')
      .select(['l.order_id'])
      .where('l.subtotal', '>', '0');
    const q = qb
      .selectFrom('sale_order as so')
      .select(['so.id'])
      .where((eb) => eb.exists(lines.where('l.order_id', '=', eb.col('so.id'))))
      .where('so.id', 'in', lines)
      .compile();
    expect(q).toEqual({
      text: 'SELECT "so"."id" FROM "sale_order" AS "so" WHERE EXISTS (SELECT "l"."order_id" FROM "sale_order_line" AS "l" WHERE "l"."subtotal" > $1 AND "l"."order_id" = "so"."id") AND "so"."id" IN (SELECT "l"."order_id" FROM "sale_order_line" AS "l" WHERE "l"."subtotal" > $2)',
      params: ['0', '0'],
    });
  });

  test('with (CTE) adds a typed table', () => {
    const q = qb
      .with('open', (q) =>
        q
          .selectFrom('sale_order as so')
          .select(['so.id', 'so.partner_id'])
          .where('so.state', '=', 'sale'),
      )
      .selectFrom('open')
      .innerJoin('res_partner as p', 'p.id', 'open.partner_id')
      .select(['open.id', 'p.name'])
      .compile();
    expect(q).toEqual({
      text: 'WITH "open" AS (SELECT "so"."id", "so"."partner_id" FROM "sale_order" AS "so" WHERE "so"."state" = $1) SELECT "open"."id", "p"."name" FROM "open" INNER JOIN "res_partner" AS "p" ON "p"."id" = "open"."partner_id"',
      params: ['sale'],
    });
  });

  test('raw fragments can be embedded as expressions', () => {
    const q = qb
      .selectFrom('sale_order as so')
      .select((eb) => [
        eb.sql<string>(sql`date_trunc(${'month'}, ${sql.id('so', 'date_order')})`).as('month'),
      ])
      .where((eb) => eb.sql<boolean>(sql`${sql.id('so', 'amount_total')} > ${'5'}`))
      .compile();
    expect(q).toEqual({
      text: 'SELECT date_trunc($1, "so"."date_order") AS "month" FROM "sale_order" AS "so" WHERE "so"."amount_total" > $2',
      params: ['month', '5'],
    });
  });

  test('builders are immutable', () => {
    const base = qb.selectFrom('sale_order').select(['id']);
    const filtered = base.where('state', '=', 'sale');
    expect(base.compile().params).toEqual([]);
    expect(filtered.compile().params).toEqual(['sale']);
  });

  test('compiling a select without columns is an error with a hint', () => {
    expect(() => qb.selectFrom('sale_order').compile()).toThrow(SqlError);
    try {
      qb.selectFrom('sale_order').compile();
    } catch (e) {
      expect((e as SqlError).code).toBe('SQL_EMPTY_SELECT');
    }
  });
});

describe('insert / update / delete', () => {
  test('multi-row insert: column union, DEFAULT for missing keys, returning', () => {
    const q = qb
      .insertInto('sale_order')
      .values([
        { name: 'SO1', state: 'draft', partner_id: 1, company_id: 1, amount_total: '0' },
        { name: 'SO2', partner_id: 2, company_id: 1, amount_total: '10.50', state: 'sale' },
      ])
      .returning(['id', 'name'])
      .compile();
    expect(q).toEqual({
      text: 'INSERT INTO "sale_order" ("name", "state", "partner_id", "company_id", "amount_total") VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10) RETURNING "id", "name"',
      params: ['SO1', 'draft', 1, 1, '0', 'SO2', 'sale', 2, 1, '10.50'],
    });
    const sparse = qb
      .insertInto('res_partner')
      .values([{ name: 'A', country_id: 1 }, { name: 'B' }])
      .compile();
    expect(sparse).toEqual({
      text: 'INSERT INTO "res_partner" ("name", "country_id") VALUES ($1, $2), ($3, DEFAULT)',
      params: ['A', 1, 'B'],
    });
  });

  test('insert with no rows is an error', () => {
    expect(() => qb.insertInto('res_partner').values([]).compile()).toThrow(SqlError);
  });

  test('update with set, expression values, where, returning', () => {
    const q = qb
      .updateTable('sale_order as so')
      .set({ state: 'sale' })
      .set((eb) => ({
        amount_total: eb.sql<string>(sql`${sql.id('so', 'amount_total')} * ${'1.1'}`),
      }))
      .where('so.id', 'in', [1, 2])
      .returning(['so.id'])
      .compile();
    expect(q).toEqual({
      text: 'UPDATE "sale_order" AS "so" SET "state" = $1, "amount_total" = "so"."amount_total" * $2 WHERE "so"."id" = ANY($3) RETURNING "so"."id"',
      params: ['sale', '1.1', [1, 2]],
    });
  });

  test('delete', () => {
    expect(
      qb.deleteFrom('sale_order_line').where('order_id', '=', 7).returning(['id']).compile(),
    ).toEqual({
      text: 'DELETE FROM "sale_order_line" WHERE "order_id" = $1 RETURNING "id"',
      params: [7],
    });
  });

  test('update or delete without a where compiles (bulk), but says so in the AST', () => {
    const q = qb.deleteFrom('sale_order_line').compile();
    expect(q.text).toBe('DELETE FROM "sale_order_line"');
  });
});

describe('identifiers are validated like sql.id', () => {
  test('a table alias or column with a quote is rejected', () => {
    expect(() => qb.selectFrom('sale_order as so"; DROP TABLE x; --' as never)).toThrow(SqlError);
    expect(() => qb.selectFrom('sale_order').select(['id"' as never])).toThrow(SqlError);
    expect(() =>
      qb
        .selectFrom('sale_order')
        .select(['id'])
        .orderBy('id; DROP' as never),
    ).toThrow(SqlError);
  });
});
