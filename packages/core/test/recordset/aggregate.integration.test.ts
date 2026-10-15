/**
 * Reports and amount helpers (feedback #12, #13, #14): `aggregate()` with rules, field groups, date buckets and
 * per-currency monetary totals; `records.sum()`; `browse().write()` without a load; searches through relation paths
 * see pending writes of the related model.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  createShutro,
  createTableStatements,
  type Decimal,
  defineGroup,
  defineModel,
  defineModule,
  type Env,
  f,
  type Id,
  InvalidDomainError,
  InvalidFieldError,
  type Money,
  type Shutro,
  toDecimal,
} from '../../src/index.js';

const Users = defineModel('res.users', {
  access: { 'base.user': ['read'] },
  fields: { login: f.char({ required: true }) },
});
const Currency = defineModel('res.currency', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
const Company = defineModel('res.company', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
const Partner = defineModel('res.partner', {
  access: { 'base.user': ['read', 'create'] },
  fields: { name: f.char({ required: true }) },
});
const Order = defineModel('sale.order', {
  access: { 'base.user': ['read', 'write', 'create'] },
  rules: {
    own: { groups: ['base.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
    all: { groups: ['base.manager'], perms: ['read', 'write'], domain: {} },
  },
  fields: {
    name: f.char({ required: true }),
    user: f.many2one('res.users', { required: true }),
    partner: f.many2one('res.partner', { required: true }),
    state: f.selection({ draft: 'Draft', sale: 'Sale' }, { required: true, default: 'draft' }),
    dateOrder: f.date({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    amount: f.monetary({ currency: 'currency' }),
    margin: f.decimal({ scale: 2, groups: ['base.manager'] }),
    lines: f.one2many('sale.order.line', 'order'),
  },
});
const Line = defineModel('sale.order.line', {
  access: { 'base.user': ['read', 'write', 'create'] },
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    quantity: f.integer({ required: true, default: 1 }),
    price: f.decimal({ scale: 2, required: true, default: '0' }),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [
        defineGroup({ code: 'base.user' }),
        defineGroup({ code: 'base.manager', implies: ['base.user'] }),
      ],
      models: [Users, Currency, Company, Partner, Order, Line],
    }),
  ],
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const ids = { bdt: 0, usd: 0, acme: 0, globex: 0 };

const as = <T>(
  user: number,
  fn: (env: Env<S>) => Promise<T>,
  groups: readonly string[] = ['base.user'],
): Promise<T> => shutro.run({ user, company: 1, groups }, fn);

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'alice'}), (${'bob'})`));
  const [bdt, usd] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO res_currency (name) VALUES (${'BDT'}), (${'USD'}) RETURNING id`),
  );
  await driver.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
  const [acme, globex] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO res_partner (name) VALUES (${'Acme'}), (${'Globex'}) RETURNING id`),
  );
  Object.assign(ids, {
    bdt: Number(bdt?.id),
    usd: Number(usd?.id),
    acme: Number(acme?.id),
    globex: Number(globex?.id),
  });
  shutro = createShutro({ driver, registry });
  const order = (
    user: number,
    partner: number,
    state: 'draft' | 'sale',
    dateOrder: string,
    currency: number,
    amount: string,
    margin: string,
  ) => ({
    name: `${user}-${dateOrder}`,
    user: user as Id<'res.users'>,
    partner: partner as Id<'res.partner'>,
    state,
    dateOrder,
    currency: currency as Id<'res.currency'>,
    amount,
    margin,
  });
  await as(
    1,
    (env) =>
      env
        .model('sale.order')
        .create([
          order(1, ids.acme, 'sale', '2026-09-03', ids.bdt, '100.00', '10'),
          order(1, ids.acme, 'sale', '2026-09-20', ids.bdt, '50.50', '5'),
          order(1, ids.globex, 'draft', '2026-10-01', ids.bdt, '30.00', '3'),
          order(1, ids.globex, 'sale', '2026-10-02', ids.usd, '7.00', '1'),
        ]),
    ['base.manager'],
  );
  await as(
    2,
    (env) =>
      env
        .model('sale.order')
        .create([order(2, ids.acme, 'sale', '2026-09-05', ids.bdt, '1000.00', '100')]),
    ['base.manager'],
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('aggregate', () => {
  test("groups, counts and per-currency Money totals, within the user's rules", async () => {
    const rows = await as(1, (env) =>
      env.model('sale.order').aggregate({
        where: { state: 'sale' },
        groupBy: ['partner'],
        measures: { orders: 'count', total: { sum: 'amount' } },
      }),
    );
    expectTypeOf(rows[0]?.partner).toEqualTypeOf<Id<'res.partner'> | null | undefined>();
    expectTypeOf(rows[0]?.orders).toEqualTypeOf<number | undefined>();
    expectTypeOf(rows[0]?.total).toEqualTypeOf<Money | undefined>();
    // Bob's 1000 BDT order is outside Alice's rule; Globex's USD order is its own row (never summed with BDT).
    expect(rows.map((r) => [r.partner, r.orders, r.total.toString()])).toEqual([
      [ids.acme, 2, 'BDT 150.50'],
      [ids.globex, 1, 'USD 7.00'],
    ]);
    const manager = await as(
      1,
      (env) =>
        env.model('sale.order').aggregate({ where: { state: 'sale' }, measures: { n: 'count' } }),
      ['base.manager'],
    );
    expect(manager).toEqual([{ n: 4 }]);
  });

  test('date buckets, order and limit, avg / min / max', async () => {
    const rows = await as(1, (env) =>
      env.model('sale.order').aggregate({
        groupBy: ['dateOrder:month'],
        measures: { n: 'count', avgQty: { avg: 'amount' }, first: { min: 'amount' } },
        order: ['n desc'],
        limit: 1,
      }),
    );
    expectTypeOf(rows[0]?.['dateOrder:month']).toEqualTypeOf<string | undefined>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['dateOrder:month']).toBe('2026-09-01');
    expect(rows[0]?.n).toBe(2);
    expect(rows[0]?.first?.toString()).toBe('BDT 50.50');
    const none = await as(1, (env) =>
      env.model('sale.order').aggregate({ where: { name: 'nothing' }, measures: { n: 'count' } }),
    );
    expect(none).toEqual([{ n: 0 }]);
  });

  test('field groups and invalid queries are refused', async () => {
    await as(1, async (env) => {
      const orders = env.model('sale.order');
      await expect(orders.aggregate({ measures: { m: { sum: 'margin' } } })).rejects.toBeInstanceOf(
        AccessError,
      );
      await expect(
        orders.aggregate({ groupBy: ['name:month' as never], measures: { n: 'count' } }),
      ).rejects.toBeInstanceOf(InvalidDomainError);
      await expect(
        orders.aggregate({ measures: { n: { sum: 'name' } as never } }),
      ).rejects.toBeInstanceOf(InvalidDomainError);
      await expect(orders.aggregate({ measures: {} })).rejects.toBeInstanceOf(InvalidDomainError);
    });
    const margin = await as(
      1,
      (env) =>
        env
          .model('sale.order')
          .aggregate({ groupBy: ['state'], measures: { m: { sum: 'margin' } } }),
      ['base.manager'],
    );
    expectTypeOf(margin[0]?.m).toEqualTypeOf<Decimal | undefined>();
    expect(margin.map((r) => [r.state, String(r.m)])).toEqual([
      ['draft', '3'],
      ['sale', '116'],
    ]);
  });
});

describe('sum, browse, path flush', () => {
  test('sum() over loaded records, browse().write() without load, paths see pending writes', async () => {
    await as(1, async (env) => {
      const [first] = (
        await env
          .model('sale.order')
          .search({ where: { state: 'sale', currency: ids.bdt as Id<'res.currency'> } })
      ).ids;
      const orders = await env
        .model('sale.order')
        .search({ where: { currency: ids.bdt as Id<'res.currency'> } });
      const total = orders.sum('amount');
      expectTypeOf(total).toEqualTypeOf<Money>();
      expect(total.toString()).toBe('BDT 180.50');
      const order = env.model('sale.order').browse([first as number]);
      await order.write({
        lines: {
          create: [
            { quantity: 2, price: '1.25' },
            { quantity: 3, price: '2.00' },
          ],
        },
      });
      const loaded = await order.load({ lines: true });
      const lines = loaded.first().lines;
      expectTypeOf(lines.sum('quantity')).toEqualTypeOf<number>();
      expectTypeOf(lines.sum('price')).toEqualTypeOf<Decimal>();
      expect(lines.sum('quantity')).toBe(5);
      expect(String(lines.sum('price'))).toBe('3.25');
      expect(() => (orders as unknown as { sum(k: string): unknown }).sum('name')).toThrow(
        InvalidFieldError,
      );
      // A pending write on lines, then a search of orders through the lines: it must see it.
      await lines.write({ quantity: 40 });
      expect(
        (await env.model('sale.order').search({ where: { lines: { any: { quantity: 40 } } } })).ids,
      ).toEqual([first]);
    });
  });
});
