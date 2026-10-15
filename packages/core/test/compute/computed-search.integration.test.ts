/** Searching non-stored computed fields through their `search` function (Odoo `search=`). */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildRegistry,
  createShutro,
  createTableStatements,
  defineModel,
  defineModule,
  f,
  InvalidFieldError,
  toDecimal,
} from '../../src/index.js';

const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
const Currency = defineModel('res.currency', {
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
const Company = defineModel('res.company', {
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
const Product = defineModel('product.product', {
  fields: {
    name: f.char({ required: true }),
    price: f.decimal({ scale: 2, required: true }),
    expensive: f.boolean({
      depends: ['price'],
      compute(records: unknown): void {
        for (const p of records as Iterable<{
          price: { gt(n: number): boolean };
          expensive: boolean;
        }>)
          p.expensive = p.price.gt(100);
      },
      search: (op: string, value: unknown) => {
        const yes = (op === 'eq' && value === true) || (op === 'ne' && value === false);
        return yes ? { price: { gt: '100' } } : { price: { lte: '100' } };
      },
    }),
  },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Product] })],
  security: { enforce: false },
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('a computed field filters through the domain its search returns', async () => {
  await createShutro({ driver, registry }).run({ user: 1, company: 1 }, async (env) => {
    const products = env.model('product.product');
    await products.create([
      { name: 'Pen', price: '2.50' },
      { name: 'Chair', price: '150.00' },
      { name: 'Desk', price: '420.00' },
    ]);
    expect(
      (await products.search({ where: { expensive: true }, order: ['name'] })).mapped('name'),
    ).toEqual(['Chair', 'Desk']);
    expect((await products.search({ where: { expensive: { ne: true } } })).mapped('name')).toEqual([
      'Pen',
    ]);
    expect(
      (
        await products.search({
          where: { or: [{ expensive: false }, { name: 'Desk' }] },
          order: ['name'],
        })
      ).mapped('name'),
    ).toEqual(['Desk', 'Pen']);
    const loaded = (await products.search({ where: { name: 'Chair' } })).first();
    expect((await products.browse([loaded.id]).load(['expensive'])).first().expensive).toBe(true);
  });
  expect(() => f.boolean({ search: () => ({}) } as never)).toThrow(InvalidFieldError);
});
