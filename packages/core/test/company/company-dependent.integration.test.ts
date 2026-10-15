/**
 * Company-dependent fields (Odoo `company_dependent`): one value per company in a JSONB map; reads, writes, filters
 * and sorts use the current company's value with the default as fallback.
 */
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
  type Env,
  f,
  type Id,
  InvalidFieldError,
  MissingRecordError,
  type Shutro,
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
const Account = defineModel('account.account', { fields: { code: f.char({ required: true }) } });
const Product = defineModel('product.product', {
  fields: {
    name: f.char({ required: true }),
    cost: f.decimal({ scale: 2, companyDependent: true, default: '0' }),
    note: f.char({ companyDependent: true }),
    incomeAccount: f.many2one('account.account', { companyDependent: true }),
  },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Account, Product] })],
  security: { enforce: false },
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const at = <T>(company: number, fn: (env: Env<S>) => Promise<T>): Promise<T> =>
  shutro.run({ user: 1, company, companies: [1, 2] }, fn);

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  shutro = createShutro({ driver, registry });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('each company has its own value; others read the default', async () => {
  const { pen, revenue } = await at(1, async (env) => {
    const [revenue] = await env.model('account.account').create([{ code: '400000' }]);
    const [pen] = await env
      .model('product.product')
      .create([
        { name: 'Pen', cost: '1.20', note: 'from supplier A', incomeAccount: revenue?.id ?? null },
      ]);
    return { pen: pen?.id as number, revenue: revenue?.id as number };
  });
  await at(2, async (env) => {
    const p = (
      await env.model('product.product').browse([pen]).load(['cost', 'note', 'incomeAccount'])
    ).first();
    expect([String(p.cost), p.note, p.incomeAccount]).toEqual(['0', null, null]); // company 2: defaults
    await p.write({ cost: '1.50' });
  });
  const read = (company: number) =>
    at(company, async (env) => {
      const p = (
        await env.model('product.product').browse([pen]).load(['cost', 'note', 'incomeAccount'])
      ).first();
      return [String(p.cost), p.note, p.incomeAccount?.id ?? null];
    });
  expect(await read(1)).toEqual(['1.2', 'from supplier A', revenue]);
  expect(await read(2)).toEqual(['1.5', null, null]);
  const [row] = await driver.query<{ cost: unknown }>(
    compile(sql`SELECT cost FROM product_product`),
  );
  expect(row?.cost).toEqual({ '1': '1.2', '2': '1.5' }); // canonical decimal text
});

test('filters and sorts use the current company value', async () => {
  await at(1, async (env) => {
    await env.model('product.product').create([{ name: 'Ink' }]); // no value anywhere: the default 0
    const products = env.model('product.product');
    expect((await products.search({ where: { cost: { gt: '1' } } })).mapped('name')).toEqual([
      'Pen',
    ]);
    expect((await products.search({ where: { cost: '0' } })).mapped('name')).toEqual(['Ink']); // default counts
    expect((await products.search({ order: ['cost desc'] })).mapped('name')).toEqual([
      'Pen',
      'Ink',
    ]);
  });
  await at(2, async (env) => {
    expect(
      (await env.model('product.product').search({ where: { cost: { gt: '1.4' } } })).mapped(
        'name',
      ),
    ).toEqual(['Pen']);
  });
});

test('company-dependent many2one ids are checked without a foreign key; declarations are checked', async () => {
  await expect(
    at(1, (env) =>
      env
        .model('product.product')
        .create([{ name: 'X', incomeAccount: 999_999 as Id<'account.account'> }]),
    ),
  ).rejects.toBeInstanceOf(MissingRecordError);
  expect(() => f.char({ companyDependent: true, required: true } as never)).toThrow(
    InvalidFieldError,
  );
  expect(() => f.json({ companyDependent: true } as never)).toThrow(/cannot be company-dependent/);
});
