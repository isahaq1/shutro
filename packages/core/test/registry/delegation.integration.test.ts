/**
 * Delegation (Odoo `_inherits`): product variants expose their template's fields as their own: created with the
 * variant, read, written through, filtered; several variants share one template.
 *
 * The inferred schema of `buildRegistry` does not see fields the registry adds, so this test reaches them through
 * an untyped view; generated views (`shutro generate`) type them.
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
  InvalidModelError,
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
const Template = defineModel('product.template', {
  fields: {
    name: f.char({ required: true }),
    listPrice: f.decimal({ scale: 2, required: true, default: '0' }),
    variants: f.one2many('product.product', 'template'),
  },
});
const Product = defineModel('product.product', {
  delegates: ['template'],
  fields: {
    template: f.many2one('product.template', { required: true, ondelete: 'cascade' }),
    barcode: f.char(),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({ name: 'product', models: [Users, Currency, Company, Template, Product] }),
  ],
  security: { enforce: false },
});

let pg: StartedPostgres;
let driver: Driver;
type Loose = Env<Record<string, unknown>>;

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

const run = <T>(fn: (env: Loose) => Promise<T>): Promise<T> =>
  createShutro({ driver, registry }).run({ user: 1, company: 1 }, (env) =>
    fn(env as unknown as Loose),
  );

test('the child exposes the parent fields; creating it creates the parent', async () => {
  expect(Object.keys(registry.get('product.product').model.fields)).toEqual(
    expect.arrayContaining(['name', 'listPrice', 'barcode']),
  );
  const ids = await run(async (env) => {
    const products = env.model('product.product');
    const idOf = (r: unknown): number => (r as { id: number }).id;
    const shirt = idOf(
      (
        await products.create([{ name: 'Shirt', listPrice: '25.00', barcode: 'S-RED' }] as never)
      ).first(),
    );
    const template = idOf(
      (await products.browse([shirt]).load(['template'] as never)).first()['template'],
    );
    // A second variant of the same template; its name value updates the shared template.
    const blue = idOf(
      (
        await products.create([{ template, barcode: 'S-BLUE', name: 'Shirt (cotton)' }] as never)
      ).first(),
    );
    return { shirt, blue, template };
  });
  const templates = await driver.query<{ id: number; name: string; list_price: unknown }>(
    compile(sql`SELECT id, name, list_price FROM product_template`),
  );
  expect(templates.map((t) => [Number(t.id), t.name, String(t.list_price)])).toEqual([
    [ids.template, 'Shirt (cotton)', '25'],
  ]);

  await run(async (env) => {
    const products = env.model('product.product');
    const both = await products
      .browse([ids.shirt, ids.blue])
      .load(['name', 'listPrice', 'barcode'] as never);
    expect(both.map((p) => [p['name'], String(p['listPrice']), p['barcode']])).toEqual([
      ['Shirt (cotton)', '25', 'S-RED'],
      ['Shirt (cotton)', '25', 'S-BLUE'],
    ]);
    // Writing a delegated field writes the template: the other variant sees it.
    await products.browse([ids.blue]).write({ listPrice: '30.00' } as never);
    await env.flush();
    expect(
      String(
        (await products.browse([ids.shirt]).load(['listPrice'] as never)).first()['listPrice'],
      ),
    ).toBe('30');
    // Filters on delegated fields go through the template.
    expect(
      (await products.search({ where: { name: 'Shirt (cotton)', barcode: 'S-RED' } as never })).ids,
    ).toEqual([ids.shirt]);
    expect((await products.search({ where: { listPrice: { gt: '29' } } as never })).length).toBe(2);
  });
});

test('the delegate must be a required cascading many2one', () => {
  expect(() =>
    defineModel('x.child', {
      delegates: ['parent'],
      fields: { parent: f.many2one('product.template') },
    }),
  ).toThrow(InvalidModelError);
});
