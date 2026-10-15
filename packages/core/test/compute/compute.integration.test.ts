/**
 * The compute engine on PostgreSQL (RFC 0008): stored computes at create and after writes, chains in rank order,
 * paths through many2one / one2many / many2many, non-stored computes on load, inverse, assignment protocol, and the
 * query budget of a batched recompute.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  ComputeAssignmentError,
  createShutro,
  createTableStatements,
  type Env,
  FieldNotLoadedError,
  type Id,
  type Shutro,
  toDecimal,
  ValidationError,
} from '../../src/index.js';
import { calls, flags, registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const identity = { user: 1, company: 1, companies: [1] } as const;
let ids: {
  bdt: Id<'res.currency'>;
  acme: Id<'res.partner'>;
  globex: Id<'res.partner'>;
  vip: Id<'sale.tag'>;
  rush: Id<'sale.tag'>;
};

async function run<T>(fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return shutro.run(identity, fn);
}

async function queriesOf(env: Env<S>, fn: () => Promise<unknown>): Promise<number> {
  const before = env.stats().queries;
  await fn();
  return env.stats().queries - before;
}

async function column(table: string, col: string, id: number): Promise<unknown> {
  const [row] = await driver.query<{ v: unknown }>(
    compile(sql`SELECT ${sql.id(col)} AS v FROM ${sql.id(table)} WHERE id = ${id}`),
  );
  return row?.v;
}

function order(
  name: string,
  lines: readonly { name: string; quantity: string; priceUnit: string }[],
) {
  return {
    name,
    partner: ids.acme,
    currency: ids.bdt,
    lines: { create: lines.map((l) => ({ ...l, currency: ids.bdt })) },
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding, decimal_places) VALUES (${'BDT'}, ${'0.01'}, ${2}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
  const [acme, globex] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO res_partner (name) VALUES (${'Acme'}), (${'Globex'}) RETURNING id`),
  );
  const [vip, rush] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO sale_tag (name) VALUES (${'vip'}), (${'rush'}) RETURNING id`),
  );
  ids = {
    bdt: (bdt?.id ?? 0) as Id<'res.currency'>,
    acme: (acme?.id ?? 0) as Id<'res.partner'>,
    globex: (globex?.id ?? 0) as Id<'res.partner'>,
    vip: (vip?.id ?? 0) as Id<'sale.tag'>,
    rush: (rush?.id ?? 0) as Id<'sale.tag'>,
  };
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

beforeEach(() => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  flags.skipCode = false;
});

describe('stored computes', () => {
  test('create: stored computes are pending until the flush point, then computed once per batch, chain in rank order', async () => {
    const id = await run(async (env) => {
      const orders = await env.model('sale.order').create([
        order('SO1', [
          { name: 'a', quantity: '2', priceUnit: '10' },
          { name: 'b', quantity: '1', priceUnit: '5.5' },
        ]),
        order('SO2', [{ name: 'c', quantity: '3', priceUnit: '1' }]),
      ]);
      const so1 = orders.first();
      expect(() => so1.amountTotal).toThrow(FieldNotLoadedError);
      expect(() => so1.amountTotal).toThrow(/pending recompute/);
      await env.flush();
      expect(so1.amountUntaxed?.toString()).toBe('BDT 25.50');
      expect(so1.amountTotal?.toString()).toBe('BDT 28.05');
      expect(so1.partnerName).toBe('Acme');
      expect(so1.code).toBe('SO1');
      expect(so1.tagNames).toBe('');
      expect(calls).toMatchObject({
        subtotal: 1,
        amounts: 1,
        partnerName: 1,
        tagNames: 1,
        code: 1,
      });
      return so1.id;
    });
    expect(String(await column('sale_order', 'amount_total', id))).toBe('28.05');
    expect(await column('sale_order', 'partner_name', id)).toBe('Acme');
    expect(await column('sale_order', 'code', id)).toBe('SO1');
  });

  test('load() of a pending stored compute recomputes without an explicit flush; the chain computes each field once', async () => {
    await run(async (env) => {
      const orders = await env
        .model('sale.order')
        .create([order('SO3', [{ name: 'a', quantity: '1', priceUnit: '100' }])]);
      const loaded = await orders.load(['amountTotal']);
      expect(loaded.first().amountTotal?.toString()).toBe('BDT 110.00');
      expect(calls.amounts).toBe(1);
      expect(calls.subtotal).toBe(1);
    });
  });

  test('writes through a one2many path: price change, line moved between orders, line deleted', async () => {
    await run(async (env) => {
      const created = await env
        .model('sale.order')
        .create([
          order('SO4', [{ name: 'a', quantity: '1', priceUnit: '10' }]),
          order('SO5', [{ name: 'b', quantity: '1', priceUnit: '20' }]),
        ]);
      await env.flush();
      const [so4, so5] = [...created];
      if (so4 === undefined || so5 === undefined) throw new Error('two orders');
      const line = (await so4.lines.load()).first();
      await line.write({ priceUnit: '15' });
      expect(() => so4.amountUntaxed).toThrow(/pending recompute/); // invalidated in the cache
      await env.flush();
      expect(so4.amountUntaxed?.toString()).toBe('BDT 15.00');

      await line.write({ order: so5.id }); // moved: both orders recompute
      await env.flush();
      expect(so4.amountUntaxed?.toString()).toBe('BDT 0.00');
      expect(so5.amountUntaxed?.toString()).toBe('BDT 35.00');

      await line.unlink();
      await env.flush();
      expect(so5.amountUntaxed?.toString()).toBe('BDT 20.00');
      expect(
        String(
          await env.sql`SELECT amount_untaxed AS v FROM sale_order WHERE id = ${so5.id}`.then(
            (r) => r[0]?.['v'],
          ),
        ),
      ).toBe('20');
    });
  });

  test('a many2one path reaches records that are not in the cache (resolved in the database)', async () => {
    const orderIds = await run(async (env) => {
      const orders = await env.model('sale.order').create([
        { name: 'G1', partner: ids.globex, currency: ids.bdt },
        { name: 'G2', partner: ids.globex, currency: ids.bdt },
      ]);
      return orders.ids;
    });
    calls.partnerName = 0;
    await run(async (env) => {
      const globex = await env.model('res.partner').browse([ids.globex]).load();
      await globex.write({ name: 'Globex Corp' });
      await env.flush();
      expect(calls.partnerName).toBe(1); // one batch for both orders
    });
    for (const id of orderIds)
      expect(await column('sale_order', 'partner_name', id)).toBe('Globex Corp');
  });

  test('a many2many path: linking and unlinking tags, renaming a tag', async () => {
    const id = await run(async (env) => {
      const so = (
        await env
          .model('sale.order')
          .create([{ name: 'T1', partner: ids.acme, currency: ids.bdt, tags: { link: [ids.vip] } }])
      ).first();
      await env.flush();
      expect(so.tagNames).toBe('vip');
      await so.write({ tags: { link: [ids.rush] } });
      await env.flush();
      expect(so.tagNames).toBe('rush,vip');
      await so.write({ tags: { unlink: [ids.vip] } });
      await env.flush();
      expect(so.tagNames).toBe('rush');
      return so.id;
    });
    await run(async (env) => {
      await (await env.model('sale.tag').browse([ids.rush]).load()).write({ name: 'urgent' });
      await env.flush();
    });
    expect(await column('sale_order', 'tag_names', id)).toBe('urgent');
  });

  test('a batched recompute stays within a fixed query budget (no N+1)', async () => {
    await run(async (env) => {
      const rows = Array.from({ length: 30 }, (_, i) =>
        order(`B${i}`, [
          { name: 'x', quantity: '1', priceUnit: '1' },
          { name: 'y', quantity: '2', priceUnit: '2' },
          { name: 'z', quantity: '3', priceUnit: '3' },
        ]),
      );
      await env.model('sale.order').create(rows);
      await env.flush();
      calls.subtotal = 0;
      calls.amounts = 0;
      const orders = await env.model('sale.order').search({ where: { name: { like: 'B%' } } });
      const lineIds: number[] = [];
      for (const o of orders) lineIds.push(...(await o.lines.load()).ids); // one query: the group is prefetched
      const lines = await env.model('sale.order.line').browse(lineIds).load();
      expect(lines.length).toBe(90);
      await lines.write({ priceUnit: '10' });
      const queries = await queriesOf(env, () => env.flush());
      expect(queries).toBeLessThanOrEqual(6);
      expect(calls.subtotal).toBe(1);
      expect(calls.amounts).toBe(1);
      expect(orders.first().amountUntaxed?.toString()).toBe('BDT 60.00');
    });
  });
});

describe('non-stored computes', () => {
  test('computed on load for the group, invalidated by a trigger, never loaded by search', async () => {
    await run(async (env) => {
      await env.model('sale.order').create([
        order('N1', [
          { name: 'a', quantity: '1', priceUnit: '1' },
          { name: 'b', quantity: '1', priceUnit: '1' },
        ]),
        order('N2', []),
      ]);
      await env.flush();
      const orders = await env.model('sale.order').search({ where: { name: { like: 'N%' } } });
      expect(() => orders.first().lineCount).toThrow(/computed on load/);
      const loaded = await orders.load(['lineCount']);
      expect(loaded.map((o) => o.lineCount)).toEqual([2, 0]);
      expect(calls.lineCount).toBe(1);
      await loaded.first().write({ lines: { create: [{ name: 'c', currency: ids.bdt }] } });
      expect(() => loaded.first().lineCount).toThrow(FieldNotLoadedError); // invalidated
      expect((await loaded.load(['lineCount'])).first().lineCount).toBe(3);
      expect(calls.lineCount).toBe(2);
      expect(loaded.read(['name']).map((r) => r['name'])).toEqual(['N1', 'N2']);
    });
  });

  test('displayName defaults to recName', async () => {
    await run(async (env) => {
      const so = (await env.model('sale.order').create([order('D1', [])])).first();
      expect((await so.load(['displayName'])).first().displayName).toBe('D1');
    });
  });
});

describe('assignment and inverse', () => {
  test('assigning a computed field outside its compute is an error', async () => {
    await run(async (env) => {
      const so = (await env.model('sale.order').create([order('A1', [])])).first();
      await env.flush();
      expect(() => {
        (so as { code: unknown }).code = 'X';
      }).toThrow(ComputeAssignmentError);
      await expect(so.write({ amountTotal: '1' } as never)).rejects.toThrow(ValidationError);
    });
  });

  test('writing a computed field with an inverse runs the inverse; the compute agrees afterwards', async () => {
    const id = await run(async (env) => {
      const so = (await env.model('sale.order').create([order('inv1', [])])).first();
      await env.flush();
      expect(so.code).toBe('INV1');
      await so.write({ code: 'RENAMED' });
      expect(so.name).toBe('renamed');
      await env.flush();
      expect(so.code).toBe('RENAMED');
      return so.id;
    });
    expect(await column('sale_order', 'name', id)).toBe('renamed');
    expect(await column('sale_order', 'code', id)).toBe('RENAMED');
  });

  test('a required stored compute that assigns nothing is a validation error', async () => {
    flags.skipCode = true;
    await expect(
      run(async (env) => {
        await env.model('sale.order').create([order('R1', [])]);
        await env.flush();
      }),
    ).rejects.toThrow(/computed field 'code' is required/);
  });
});
