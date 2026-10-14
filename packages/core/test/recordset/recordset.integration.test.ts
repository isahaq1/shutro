/**
 * Recordsets, identity map and batched prefetch (RFC 0004) on real PostgreSQL 18.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  asId,
  buildRegistry,
  createShutro,
  createTableStatements,
  type Env,
  FieldNotLoadedError,
  InvalidDomainError,
  MissingRecordError,
  Money,
  Quantity,
  type Shutro,
  SingletonError,
  toDecimal,
} from '../../src/index.js';
import { sale } from './fixtures.js';

const registry = buildRegistry({ modules: [sale] });
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const identity = { user: 1, company: 1, companies: [1] } as const;
let ids: {
  bdt: number;
  usd: number;
  acme: number;
  globex: number;
  archived: number;
  unit: number;
  dozen: number;
  vip: number;
  rush: number;
} = {} as never;

/** Runs `fn` in a transaction and returns its result together with the number of queries it issued. */
async function counted<T>(
  fn: (env: Env<S>) => Promise<T>,
  options: { readonly companies?: readonly number[] } = {},
): Promise<{ result: T; queries: number }> {
  return shutro.run({ ...identity, companies: options.companies ?? [1] }, async (env) => {
    const before = env.stats().queries;
    const result = await fn(env);
    return { result, queries: env.stats().queries - before };
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry });

  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt, usd] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding, decimal_places) VALUES (${'BDT'}, ${'0.01'}, ${2}), (${'USD'}, ${'0.01'}, ${2}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(
      sql`INSERT INTO res_company (name, currency_id) VALUES (${'Paragon BD'}, ${bdt?.id}), (${'Paragon SG'}, ${usd?.id})`,
    ),
  );
  const [acme, globex, archived] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name, email, active) VALUES (${'Acme'}, ${'acme@example.com'}, ${true}), (${'Globex'}, ${null}, ${true}), (${'Old Co'}, ${null}, ${false}) RETURNING id`,
    ),
  );
  const [unit, dozen] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO uom_uom (name, category, ratio, rounding) VALUES (${'Units'}, ${'Unit'}, ${'1'}, ${'1'}), (${'Dozens'}, ${'Unit'}, ${'12'}, ${'0.01'}) RETURNING id`,
    ),
  );
  const [vip, rush] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO sale_tag (name) VALUES (${'VIP'}), (${'Rush'}) RETURNING id`),
  );
  ids = {
    bdt: bdt?.id ?? 0,
    usd: usd?.id ?? 0,
    acme: acme?.id ?? 0,
    globex: globex?.id ?? 0,
    archived: archived?.id ?? 0,
    unit: unit?.id ?? 0,
    dozen: dozen?.id ?? 0,
    vip: vip?.id ?? 0,
    rush: rush?.id ?? 0,
  };

  // 6 orders: 5 for company 1 (one cancelled), 1 for company 2
  const orders = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO sale_order (name, partner_id, currency_id, company_id, date_order, state, amount_total, note) VALUES
      (${'SO001'}, ${ids.acme}, ${ids.bdt}, ${1}, ${new Date('2026-10-01T10:00:00Z')}, ${'sale'}, ${'1500.00'}, ${'first'}),
      (${'SO002'}, ${ids.acme}, ${ids.bdt}, ${1}, ${new Date('2026-10-02T10:00:00Z')}, ${'sale'}, ${'250.50'}, ${null}),
      (${'SO003'}, ${ids.globex}, ${ids.bdt}, ${1}, ${new Date('2026-10-03T10:00:00Z')}, ${'draft'}, ${'0'}, ${null}),
      (${'SO004'}, ${ids.globex}, ${ids.usd}, ${1}, ${new Date('2026-10-04T10:00:00Z')}, ${'sale'}, ${'99.99'}, ${null}),
      (${'SO005'}, ${ids.acme}, ${ids.bdt}, ${1}, ${new Date('2026-10-05T10:00:00Z')}, ${'cancel'}, ${'10'}, ${null}),
      (${'SO006'}, ${ids.acme}, ${ids.usd}, ${2}, ${new Date('2026-10-06T10:00:00Z')}, ${'sale'}, ${'7'}, ${null})
      RETURNING id`),
  );
  const [o1, o2, o3, o4] = orders.map((o) => o.id);
  await driver.query(
    compile(sql`INSERT INTO sale_order_line (order_id, name, currency_id, uom_id, quantity, price_unit, subtotal) VALUES
      (${o1}, ${'Laptop'}, ${ids.bdt}, ${ids.unit}, ${'2'}, ${'700'}, ${'1400.00'}),
      (${o1}, ${'Mouse'}, ${ids.bdt}, ${ids.dozen}, ${'0.5'}, ${'200'}, ${'100.00'}),
      (${o2}, ${'Cable'}, ${ids.bdt}, ${ids.unit}, ${'1'}, ${'250.5'}, ${'250.50'}),
      (${o3}, ${'Quote item'}, ${ids.bdt}, ${ids.unit}, ${'1'}, ${'0'}, ${'0'}),
      (${o4}, ${'Service'}, ${ids.usd}, ${ids.unit}, ${'3'}, ${'33.33'}, ${'99.99'})`),
  );
  await driver.query(
    compile(
      sql`INSERT INTO sale_order_sale_tag_rel (sale_order_id, sale_tag_id) VALUES (${o1}, ${ids.vip}), (${o1}, ${ids.rush}), (${o2}, ${ids.vip})`,
    ),
  );
}, 240_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('search', () => {
  test('one query loads the default columns; records expose typed values', async () => {
    const { result, queries } = await counted(async (env) => {
      const orders = await env.model('sale.order').search({ where: { state: 'sale' } });
      return orders.map((o) => ({
        name: o.name,
        total: o.amountTotal,
        partnerId: o.partner.id,
        date: o.dateOrder,
        validity: o.validityDate,
        note: o.note,
        state: o.state,
      }));
    });
    expect(queries).toBe(2); // sale_order + the currencies of the loaded orders (cached for the rest of the transaction)
    expect(result.map((r) => r.name)).toEqual(['SO004', 'SO002', 'SO001']); // default order: dateOrder desc; company 2 excluded
    const first = result[0];
    expect(first?.total).toBeInstanceOf(Money);
    expect(first?.total.toString()).toBe('USD 99.99');
    expect(result[2]?.total.toString()).toBe('BDT 1500.00');
    expect(first?.partnerId).toBe(ids.globex);
    expect(first?.date).toBeInstanceOf(Date);
    expect(first?.validity).toBeNull();
    expect(result[2]?.note).toBe('first');
    expect(first?.state).toBe('sale');
  });

  test('where operators, order, limit, offset', async () => {
    const { result } = await counted(async (env) => {
      const m = env.model('sale.order');
      const byTotal = await m.search({
        where: { amountTotal: { gte: '100' } },
        order: ['amountTotal asc'],
      });
      const inStates = await m.search({
        where: { state: { in: ['draft', 'cancel'] } },
        order: ['name'],
      });
      const noNote = await m.search({
        where: { note: { isNull: true }, partner: asId(ids.acme, 'res.partner') },
        order: ['name'],
      });
      const like = await m.search({
        where: { name: { ilike: 'so00%' } },
        order: ['name desc'],
        limit: 2,
        offset: 1,
      });
      const ne = await m.search({ where: { note: { ne: 'first' } }, order: ['name'] }); // includes NULL notes (RFC 0005 §7.3)
      return {
        byTotal: byTotal.mapped('name'),
        inStates: inStates.mapped('name'),
        noNote: noNote.mapped('name'),
        like: like.mapped('name'),
        ne: ne.mapped('name'),
      };
    });
    expect(result.byTotal).toEqual(['SO002', 'SO001']);
    expect(result.inStates).toEqual(['SO003', 'SO005']);
    expect(result.noNote).toEqual(['SO002', 'SO005']);
    expect(result.like).toEqual(['SO004', 'SO003']);
    expect(result.ne).toEqual(['SO002', 'SO003', 'SO004', 'SO005']);
  });

  test('company scoping follows env.companies; activeTest hides archived records', async () => {
    const both = await counted(
      (env) =>
        env
          .model('sale.order')
          .search({ order: ['name'] })
          .then((o) => o.mapped('name')),
      { companies: [1, 2] },
    );
    expect(both.result).toContain('SO006');
    const partners = await counted(async (env) => ({
      active: (await env.model('res.partner').search({ order: ['name'] })).mapped('name'),
      all: (
        await env
          .withFlags({ activeTest: false })
          .model('res.partner')
          .search({ order: ['name'] })
      ).mapped('name'),
    }));
    expect(partners.result.active).toEqual(['Acme', 'Globex']);
    expect(partners.result.all).toEqual(['Acme', 'Globex', 'Old Co']);
  });

  test('invalid domains are typed errors', async () => {
    await expect(
      counted((env) => env.model('sale.order').search({ where: { nope: 1 } as never })),
    ).rejects.toBeInstanceOf(InvalidDomainError);
    await expect(
      counted((env) => env.model('sale.order').search({ where: { lines: 1 } as never })),
    ).rejects.toBeInstanceOf(InvalidDomainError);
    await expect(
      counted((env) =>
        env.model('sale.order').search({ where: { name: { between: 1 } } as never }),
      ),
    ).rejects.toBeInstanceOf(InvalidDomainError);
  });
});

describe('load, prefetch and the identity map', () => {
  test('nested load: one query per relation level, never per record', async () => {
    const { result, queries } = await counted(async (env) => {
      const orders = await env.model('sale.order').search({ where: { state: 'sale' } });
      const loaded = await orders.load({
        partner: ['name', 'email'],
        lines: { uom: true },
        tags: true,
      });
      return loaded.map((o) => ({
        partner: o.partner.name,
        email: o.partner.email,
        lines: o.lines.map(
          (l) =>
            `${l.name}:${l.quantity.toString()}:${l.subtotal.toString()}:${l.uom === null ? '-' : l.uom.name}`,
        ),
        tags: o.tags.mapped('name'),
      }));
    });
    // orders(+currencies) 2, partners 1, lines 1, uoms 1, tags 1
    expect(queries).toBe(6);
    expect(result).toEqual([
      { partner: 'Globex', email: null, lines: ['Service:3 Units:USD 99.99:Units'], tags: [] },
      {
        partner: 'Acme',
        email: 'acme@example.com',
        lines: ['Cable:1 Units:BDT 250.50:Units'],
        tags: ['VIP'],
      },
      {
        partner: 'Acme',
        email: 'acme@example.com',
        lines: ['Laptop:2 Units:BDT 1400.00:Units', 'Mouse:0.5 Dozens:BDT 100.00:Dozens'],
        tags: ['VIP', 'Rush'],
      },
    ]);
  });

  test('a naive loop over a prefetch group costs one query, not N', async () => {
    const { result, queries } = await counted(async (env) => {
      const orders = await env.model('sale.order').search({});
      const before = env.stats().queries;
      const totals: string[] = [];
      for (const o of orders) {
        const lines = await o.lines.load(['subtotal']); // first iteration loads lines for every order in the group
        totals.push(lines.map((l) => l.subtotal.amount.toFixed()).join('+'));
      }
      return { totals, loop: env.stats().queries - before };
    });
    expect(result.loop).toBe(1);
    expect(queries).toBe(3);
    expect(result.totals).toEqual(
      ['10', '99.99', '0', '250.5', '1400+100'].map((t) => (t === '10' ? '' : t)),
    );
  });

  test('loading again what is cached issues no query; the identity map is shared across paths', async () => {
    const { result, queries } = await counted(async (env) => {
      const orders = await env
        .model('sale.order')
        .search({ where: { partner: asId(ids.acme, 'res.partner') }, order: ['name'] });
      const loaded = await orders.load({ partner: ['name'] });
      const before = env.stats().queries;
      await orders.load({ partner: ['name'] }); // cache hit
      const partner = await env.model('res.partner').browse([ids.acme]).load(['name']); // also a cache hit
      const again = loaded.first().partner.name;
      return { partner: partner.first().name, again, extra: env.stats().queries - before };
    });
    expect(result.extra).toBe(0);
    expect(result.partner).toBe('Acme');
    expect(result.again).toBe('Acme');
    expect(queries).toBe(3);
  });

  test('browse() is lazy; load() fetches; missing ids are an error', async () => {
    const { result, queries } = await counted(async (env) => {
      const pending = env.model('sale.order').browse([1, 2]);
      const before = env.stats().queries;
      const loaded = await pending.load();
      return { names: loaded.mapped('name'), loadQueries: env.stats().queries - before };
    });
    expect(result.names).toEqual(['SO001', 'SO002']);
    expect(result.loadQueries).toBe(2);
    expect(queries).toBe(2);
    await expect(
      counted((env) => env.model('sale.order').browse([999_999]).load()),
    ).rejects.toBeInstanceOf(MissingRecordError);
  });

  test('reading a field that is not loaded is a typed error with the fix', async () => {
    await counted(async (env) => {
      const orders = await env.model('sale.order').search({ limit: 1 });
      const o = orders.first();
      expect(() => (o.partner as unknown as { name: string }).name).toThrow(FieldNotLoadedError);
      try {
        void (o.partner as unknown as { name: string }).name;
      } catch (e) {
        expect((e as FieldNotLoadedError).hint).toMatch(/load\(/);
      }
      expect(() => (o as unknown as { attachment: unknown }).attachment).toThrow(
        FieldNotLoadedError,
      ); // binary is never prefetched
    });
  });

  test('singletons: first(), ensureOne(), length, isEmpty', async () => {
    await counted(async (env) => {
      const all = await env.model('sale.order').search({});
      expect(all.length).toBe(5);
      expect(all.isEmpty()).toBe(false);
      expect(() => all.ensureOne()).toThrow(SingletonError);
      const none = await env.model('sale.order').search({ where: { name: 'nope' } });
      expect(none.isEmpty()).toBe(true);
      expect(() => none.first()).toThrow(SingletonError);
      const one = await env.model('sale.order').search({ where: { name: 'SO001' } });
      expect(one.ensureOne().name).toBe('SO001');
      expect(one.first().id).toBe(one.ids[0]);
    });
  });

  test('read() returns plain JSON: ids for relations, Money and Quantity as objects', async () => {
    const { result } = await counted(async (env) => {
      const orders = await env.model('sale.order').search({ where: { name: 'SO001' } });
      const loaded = await orders.load({ lines: ['name', 'quantity', 'subtotal'] });
      const [row] = loaded.read(['name', 'amountTotal', 'partner', 'lines', 'dateOrder']);
      const lineRows = loaded.first().lines.read(['name', 'quantity', 'subtotal']);
      return { row, lineRows };
    });
    expect(result.row).toEqual({
      id: expect.any(Number),
      name: 'SO001',
      amountTotal: { amount: '1500.00', currency: 'BDT' },
      partner: ids.acme,
      lines: [expect.any(Number), expect.any(Number)],
      dateOrder: '2026-10-01T10:00:00.000Z',
    });
    expect(result.lineRows).toEqual([
      {
        id: expect.any(Number),
        name: 'Laptop',
        quantity: { value: '2', uom: 'Units' },
        subtotal: { amount: '1400.00', currency: 'BDT' },
      },
      {
        id: expect.any(Number),
        name: 'Mouse',
        quantity: { value: '0.5', uom: 'Dozens' },
        subtotal: { amount: '100.00', currency: 'BDT' },
      },
    ]);
    expect(JSON.parse(JSON.stringify(result.row))).toEqual(result.row);
  });

  test('Quantity and Money values are real value objects', async () => {
    await counted(async (env) => {
      const lines = await env.model('sale.order.line').search({ where: { name: 'Mouse' } });
      const line = lines.ensureOne();
      expect(line.quantity).toBeInstanceOf(Quantity);
      expect(line.quantity.to(await uomOf(env, 'Units')).value.toFixed()).toBe('6');
      expect(line.subtotal.plus(Money.of('0.004', line.subtotal.currency)).round().toString()).toBe(
        'BDT 100.00',
      );
    });
  });
});

async function uomOf(env: Env<S>, name: string): Promise<Quantity['uom']> {
  const line = (
    await env.model('sale.order.line').search({ where: { name: 'Laptop' } })
  ).ensureOne();
  void name;
  return line.quantity.uom;
}
