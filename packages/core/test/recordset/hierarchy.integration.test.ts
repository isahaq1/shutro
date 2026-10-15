/**
 * Hierarchies: materialized paths maintained by the engine (batches with their own parents, subtree moves, cycles
 * refused) and `childOf` / `parentOf` filters on `id` and through many2one fields.
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
  InvalidDomainError,
  InvalidModelError,
  type Shutro,
  toDecimal,
  ValidationError,
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
const Category = defineModel('product.category', {
  hierarchy: { parent: 'parent', path: 'parentPath' },
  fields: {
    name: f.char({ required: true }),
    parent: f.many2one('product.category', { ondelete: 'cascade' }),
    parentPath: f.char({ readonly: true, index: true }),
  },
});
const Product = defineModel('product.product', {
  fields: { name: f.char({ required: true }), category: f.many2one('product.category') },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Category, Product] })],
  security: { enforce: false },
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const ids: Record<string, number> = {};

const run = <T>(fn: (env: Env<S>) => Promise<T>): Promise<T> =>
  shutro.run({ user: 1, company: 1 }, fn);
const names = (env: Env<S>, where: Parameters<ReturnType<Env<S>['model']>['search']>[0]) =>
  env
    .model('product.category')
    .search(where as never)
    .then((r) => r.mapped('name').sort());

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  shutro = createShutro({ driver, registry });
  // All / Goods / Food / Fruit and All / Services, created in two batches.
  await run(async (env) => {
    const cats = env.model('product.category');
    const [all] = await cats.create([{ name: 'All' }]);
    ids['All'] = all?.id as number;
    const [goods, services] = await cats.create([
      { name: 'Goods', parent: all?.id ?? null },
      { name: 'Services', parent: all?.id ?? null },
    ]);
    ids['Goods'] = goods?.id as number;
    ids['Services'] = services?.id as number;
    const [food] = await cats.create([{ name: 'Food', parent: goods?.id ?? null }]);
    ids['Food'] = food?.id as number;
    const [fruit] = await cats.create([{ name: 'Fruit', parent: food?.id ?? null }]);
    ids['Fruit'] = fruit?.id as number;
    await env.model('product.product').create([
      { name: 'Apple', category: fruit?.id ?? null },
      { name: 'Consulting', category: services?.id ?? null },
    ]);
  });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('paths are maintained on create, and readable', async () => {
  const rows = await driver.query<{ name: string; parent_path: string }>(
    compile(sql`SELECT name, parent_path FROM product_category ORDER BY id`),
  );
  const path = (n: string) => rows.find((r) => r.name === n)?.parent_path;
  expect(path('Fruit')).toBe(`${ids['All']}/${ids['Goods']}/${ids['Food']}/${ids['Fruit']}/`);
  await run(async (env) => {
    const fruit = (
      await env
        .model('product.category')
        .browse([ids['Fruit'] as number])
        .load()
    ).first();
    expect(fruit.parentPath).toBe(path('Fruit'));
  });
});

test('childOf / parentOf on id and through many2one fields', async () => {
  await run(async (env) => {
    expect(
      await names(env, { where: { id: { childOf: ids['Goods'] as Id<'product.category'> } } }),
    ).toEqual(['Food', 'Fruit', 'Goods']);
    expect(
      await names(env, { where: { id: { parentOf: ids['Fruit'] as Id<'product.category'> } } }),
    ).toEqual(['All', 'Food', 'Fruit', 'Goods']);
    const products = env.model('product.product');
    expect(
      (
        await products.search({
          where: { category: { childOf: ids['Goods'] as Id<'product.category'> } },
        })
      ).mapped('name'),
    ).toEqual(['Apple']);
    expect(
      (
        await products.search({
          where: { category: { childOf: [ids['All'] as Id<'product.category'>] } },
        })
      )
        .mapped('name')
        .sort(),
    ).toEqual(['Apple', 'Consulting']);
    await expect(
      products.search({ where: { id: { childOf: 1 as Id<'product.product'> } } }),
    ).rejects.toBeInstanceOf(InvalidDomainError);
  });
});

test('moving a subtree rewrites its paths; cycles are refused', async () => {
  await run(async (env) => {
    const food = (
      await env
        .model('product.category')
        .browse([ids['Food'] as number])
        .load()
    ).first();
    await food.write({ parent: ids['Services'] as Id<'product.category'> }); // Food (with Fruit) under Services
    expect(
      await names(env, { where: { id: { childOf: ids['Services'] as Id<'product.category'> } } }),
    ).toEqual(['Food', 'Fruit', 'Services']);
    expect(
      await names(env, { where: { id: { childOf: ids['Goods'] as Id<'product.category'> } } }),
    ).toEqual(['Goods']);
    const all = (
      await env
        .model('product.category')
        .browse([ids['All'] as number])
        .load()
    ).first();
    await expect(
      all.write({ parent: ids['Fruit'] as Id<'product.category'> }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(food.write({ parent: ids['Food'] as Id<'product.category'> })).rejects.toThrow(
      /cannot move under/,
    );
  });
  const [fruit] = await driver.query<{ parent_path: string }>(
    compile(sql`SELECT parent_path FROM product_category WHERE name = ${'Fruit'}`),
  );
  expect(fruit?.parent_path).toBe(
    `${ids['All']}/${ids['Services']}/${ids['Food']}/${ids['Fruit']}/`,
  );
});

test('the declaration is checked', () => {
  expect(() =>
    defineModel('y.tree', {
      hierarchy: { parent: 'parent', path: 'path' },
      fields: { parent: f.many2one('y.other'), path: f.char({ readonly: true }) },
    }),
  ).toThrow(InvalidModelError);
  expect(() =>
    defineModel('y.tree', {
      hierarchy: { parent: 'parent', path: 'path' },
      fields: { parent: f.many2one('y.tree'), path: f.char() },
    }),
  ).toThrow(/must be a readonly char field/);
});
