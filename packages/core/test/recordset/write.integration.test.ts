/**
 * Recordset writes (RFC 0004 §7.6): create / write / unlink, the unit of work, flush points, savepoint journaling.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  asId,
  buildRegistry,
  CurrencyMismatchError,
  createShutro,
  createTableStatements,
  type Env,
  type Id,
  MissingRecordError,
  Money,
  Quantity,
  type Shutro,
  toDecimal,
  UomMismatchError,
  ValidationError,
} from '../../src/index.js';
import { sale } from './fixtures.js';

const registry = buildRegistry({ modules: [sale] });
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const identity = { user: 1, company: 1, companies: [1, 2] } as const;
let ids: {
  bdt: Id<'res.currency'>;
  usd: Id<'res.currency'>;
  acme: Id<'res.partner'>;
  unit: Id<'uom.uom'>;
  dozen: Id<'uom.uom'>;
  vip: Id<'sale.tag'>;
  rush: Id<'sale.tag'>;
};

async function run<T>(fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return shutro.run(identity, fn);
}

/** Runs `fn` and returns the number of queries it issued. */
async function queriesOf(env: Env<S>, fn: () => Promise<unknown>): Promise<number> {
  const before = env.stats().queries;
  await fn();
  return env.stats().queries - before;
}

function orderValues(name: string): {
  name: string;
  partner: Id<'res.partner'>;
  currency: Id<'res.currency'>;
  dateOrder: Date;
} {
  return {
    name,
    partner: ids.acme,
    currency: ids.bdt,
    dateOrder: new Date('2026-10-15T08:00:00Z'),
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt, usd] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}), (${'USD'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(
      sql`INSERT INTO res_company (name, currency_id) VALUES (${'Paragon BD'}, ${bdt?.id}), (${'Paragon SG'}, ${usd?.id})`,
    ),
  );
  const [acme] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO res_partner (name, active) VALUES (${'Acme'}, ${true}) RETURNING id`),
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
    bdt: asId(bdt?.id ?? 0, 'res.currency'),
    usd: asId(usd?.id ?? 0, 'res.currency'),
    acme: asId(acme?.id ?? 0, 'res.partner'),
    unit: asId(unit?.id ?? 0, 'uom.uom'),
    dozen: asId(dozen?.id ?? 0, 'uom.uom'),
    vip: asId(vip?.id ?? 0, 'sale.tag'),
    rush: asId(rush?.id ?? 0, 'sale.tag'),
  };
}, 240_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('create', () => {
  test('one INSERT per model, nested lines and tag links, defaults applied, no reload needed', async () => {
    const result = await run(async (env) => {
      const before = env.stats().queries;
      const orders = await env.model('sale.order').create([
        {
          ...orderValues('SO100'),
          lines: {
            create: [
              {
                name: 'Laptop',
                currency: ids.bdt,
                uom: ids.unit,
                quantity: '2',
                priceUnit: '700',
                subtotal: '1400',
              },
              {
                name: 'Mouse',
                currency: ids.bdt,
                uom: ids.dozen,
                quantity: '0.5',
                priceUnit: '200',
                subtotal: '100',
              },
            ],
          },
          tags: { link: [ids.vip, ids.rush] },
        },
      ]);
      const inserts = env.stats().queries - before;
      const o = orders.ensureOne();
      const values = {
        name: o.name,
        state: o.state,
        company: o.company.id,
        total: o.amountTotal.toString(),
        note: o.note,
        createdAt: o.createdAt.getTime() === env.now().getTime(),
        createdBy: o.createdBy?.id,
        partnerId: o.partner.id,
      };
      const after = env.stats().queries;
      const lines = await o.lines.load();
      const tags = await o.tags.load();
      return {
        inserts,
        values,
        lines: lines.map((l) => `${l.name}:${l.quantity.toString()}:${l.subtotal.toString()}`),
        tags: tags.mapped('name'),
        reads: env.stats().queries - after,
      };
    });
    // order insert, currencies (first use), lines insert, uoms (first use), junction insert
    expect(result.inserts).toBe(5);
    expect(result.values).toEqual({
      name: 'SO100',
      state: 'draft',
      company: 1,
      total: 'BDT 0.00',
      note: null,
      createdAt: true,
      createdBy: 1,
      partnerId: ids.acme,
    });
    expect(result.lines).toEqual(['Laptop:2 Units:BDT 1400.00', 'Mouse:0.5 Dozens:BDT 100.00']);
    expect(result.tags).toEqual(['VIP', 'Rush']);
    expect(result.reads).toBe(1); // created lines are cached in full; the linked tags' names were never loaded
  });

  test('several records in one statement; the result is in input order', async () => {
    const { names, queries } = await run(async (env) => {
      const queries = await queriesOf(env, () =>
        env
          .model('sale.order')
          .create([orderValues('SO101'), orderValues('SO102'), orderValues('SO103')]),
      );
      const created = await env
        .model('sale.order')
        .search({ where: { name: { in: ['SO101', 'SO102', 'SO103'] } }, order: ['name'] });
      return { names: created.mapped('name'), queries };
    });
    expect(queries).toBe(2); // one INSERT + the currency cache
    expect(names).toEqual(['SO101', 'SO102', 'SO103']);
  });

  test('validation: required, unknown, readonly, selection, currency', async () => {
    await run(async (env) => {
      const m = env.model('sale.order');
      const missing = await m
        .create([{ name: 'X', currency: ids.bdt, dateOrder: new Date() } as never])
        .catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(ValidationError);
      expect((missing as ValidationError).fields).toEqual(['partner']);
      await expect(m.create([{ ...orderValues('X'), nope: 1 } as never])).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(
        m.create([{ ...orderValues('X'), state: 'sale' } as never]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        m.create([{ ...orderValues('X'), createdAt: new Date() } as never]),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        m.create([
          {
            ...orderValues('X'),
            amountTotal: Money.of('1', (await currency(env, ids.usd)).currency),
          },
        ]),
      ).rejects.toBeInstanceOf(CurrencyMismatchError);
      await expect(
        env.model('sale.order.line').create([
          {
            order: asId(1, 'sale.order'),
            name: 'L',
            currency: ids.bdt,
            uom: ids.unit,
            quantity: Quantity.of('1', (await uom(env, ids.dozen)).uom),
            priceUnit: '1',
          },
        ]),
      ).rejects.toBeInstanceOf(UomMismatchError);
    });
  });
});

describe('write and flush', () => {
  test('values are visible at once; one UPDATE per (model, field set) at the next search', async () => {
    const result = await run(async (env) => {
      const orders = await env
        .model('sale.order')
        .search({ where: { name: { in: ['SO101', 'SO102'] } }, order: ['name'] });
      const writeQueries = await queriesOf(env, async () => {
        await orders.write({ note: 'bulk', amountTotal: '10' });
        await orders.first().write({ validityDate: '2026-12-31' });
      });
      const seen = orders.map(
        (o) => `${o.note}:${o.amountTotal.toString()}:${o.validityDate ?? '-'}`,
      );
      const flushQueries = await queriesOf(env, () =>
        env.model('sale.order').search({ where: { note: 'bulk' } }),
      );
      const [row] = await env.sql<{
        note: string;
        updated_at: Date;
        amount_total: unknown;
      }>`SELECT note, updated_at, amount_total FROM sale_order WHERE name = ${'SO101'}`;
      return { writeQueries, seen, flushQueries, row, now: env.now() };
    });
    expect(result.writeQueries).toBe(0);
    expect(result.seen).toEqual(['bulk:BDT 10.00:2026-12-31', 'bulk:BDT 10.00:-']);
    // two UPDATE groups ({note, amountTotal, validityDate} for SO101, {note, amountTotal} for SO102) + the SELECT
    expect(result.flushQueries).toBe(3);
    expect(result.row?.note).toBe('bulk');
    expect(String(result.row?.amount_total)).toBe('10');
    expect(result.row?.updated_at.getTime()).toBe(result.now.getTime());
  });

  test('flushes at commit and before raw SQL; Money and Quantity writes check currency and unit', async () => {
    await run(async (env) => {
      const order = (
        await env.model('sale.order').search({ where: { name: 'SO103' } })
      ).ensureOne();
      await order.write({ amountTotal: Money.of('42.5', order.amountTotal.currency) });
      const [row] = await env.sql<{
        amount_total: unknown;
      }>`SELECT amount_total FROM sale_order WHERE id = ${order.id}`;
      expect(String(row?.amount_total)).toBe('42.5');
      await expect(
        order.write({ amountTotal: Money.of('1', (await currency(env, ids.usd)).currency) }),
      ).rejects.toBeInstanceOf(CurrencyMismatchError);
      const line = (
        await env.model('sale.order.line').search({ where: { name: 'Laptop' } })
      ).ensureOne();
      await expect(
        line.write({ quantity: Quantity.of('3', (await uom(env, ids.dozen)).uom) }),
      ).rejects.toBeInstanceOf(UomMismatchError);
      await line.write({ quantity: Quantity.of('3', (await uom(env, ids.unit)).uom) });
      await order.write({ note: 'committed' });
    });
    const committed = await run(
      async (env) =>
        (await env.model('sale.order').search({ where: { name: 'SO103' } })).ensureOne().note,
    );
    expect(committed).toBe('committed');
  });

  test('validation on write: readonly, required to null, unknown, bad selection', async () => {
    await run(async (env) => {
      const order = (
        await env.model('sale.order').search({ where: { name: 'SO103' } })
      ).ensureOne();
      await expect(order.write({ state: 'sale' } as never)).rejects.toBeInstanceOf(ValidationError);
      await expect(order.write({ createdAt: new Date() } as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(order.write({ partner: null } as never)).rejects.toBeInstanceOf(ValidationError);
      await expect(order.write({ nope: 1 } as never)).rejects.toBeInstanceOf(ValidationError);
      await expect(
        env
          .model('res.currency')
          .browse([ids.bdt])
          .load()
          .then((c) => c.write({ roundingMethod: 'sideways' } as never)),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  test('x2many commands: one2many create/update/delete, many2many link/unlink/set/clear', async () => {
    const result = await run(async (env) => {
      const order = (
        await env.model('sale.order').search({ where: { name: 'SO100' } })
      ).ensureOne();
      const lines = await order.lines.load();
      const mouse = lines.filter((l) => l.name === 'Mouse').ensureOne();
      await order.write({
        lines: {
          create: [
            {
              name: 'Cable',
              currency: ids.bdt,
              uom: ids.unit,
              quantity: '1',
              priceUnit: '5',
              subtotal: '5',
            },
          ],
          update: [{ id: mouse.id, values: { priceUnit: '250' } }],
          delete: [lines.filter((l) => l.name === 'Laptop').ensureOne().id],
        },
        tags: { unlink: [ids.rush] },
      });
      const after = await order.lines.load();
      const names = after.map((l) => `${l.name}:${l.priceUnit.toFixed()}`);
      const tags1 = (await order.tags.load()).mapped('name');
      await order.write({ tags: { set: [ids.rush] } });
      const tags2 = (await order.tags.load()).mapped('name');
      await order.write({ tags: { clear: true } });
      const tags3 = (await order.tags.load()).mapped('name');
      await order.write({ tags: { link: [ids.vip] } });
      await order.write({ tags: { link: [ids.vip] } }); // idempotent
      const tags4 = (await order.tags.load()).mapped('name');
      return { names, tags1, tags2, tags3, tags4 };
    });
    expect(result.names).toEqual(['Mouse:250', 'Cable:5']);
    expect(result.tags1).toEqual(['VIP']);
    expect(result.tags2).toEqual(['Rush']);
    expect(result.tags3).toEqual([]);
    expect(result.tags4).toEqual(['VIP']);
    const fresh = await run(async (env) => {
      const order = (
        await env.model('sale.order').search({ where: { name: 'SO100' } })
      ).ensureOne();
      return {
        lines: (await order.lines.load()).mapped('name'),
        tags: (await order.tags.load()).mapped('name'),
      };
    });
    expect(fresh).toEqual({ lines: ['Mouse', 'Cable'], tags: ['VIP'] });
  });
});

describe('unlink', () => {
  test('deletes records (and cascades lines), cleans the cache', async () => {
    await run(async (env) => {
      const order = (
        await env.model('sale.order').search({ where: { name: 'SO100' } })
      ).ensureOne();
      const lineIds = [...(await order.lines.load()).ids];
      await order.unlink();
      expect(
        await env
          .model('sale.order')
          .search({ where: { name: 'SO100' } })
          .then((r) => r.isEmpty()),
      ).toBe(true);
      expect(
        await env
          .model('sale.order.line')
          .search({ where: { id: { in: lineIds } } })
          .then((r) => r.isEmpty()),
      ).toBe(true);
      await expect(env.model('sale.order').browse([order.id]).load()).rejects.toBeInstanceOf(
        MissingRecordError,
      );
    });
  });
});

describe('savepoints', () => {
  test('a rolled-back savepoint restores the cache: writes, creates and deletes', async () => {
    const result = await run(async (env) => {
      const order = (
        await env.model('sale.order').search({ where: { name: 'SO101' } })
      ).ensureOne();
      let createdId = 0;
      await env
        .transaction(async (sp) => {
          const inner = (
            await sp.model('sale.order').search({ where: { name: 'SO101' } })
          ).ensureOne();
          await inner.write({ note: 'inside' });
          const created = await sp.model('sale.order').create([orderValues('SO199')]);
          createdId = created.ensureOne().id;
          await (await sp.model('sale.order').search({ where: { name: 'SO102' } })).unlink();
          throw new Error('abort');
        })
        .catch(() => undefined);
      const note = order.note;
      const flushQueries = await queriesOf(env, () =>
        env.model('sale.order').search({ where: { name: 'SO101' } }),
      );
      const so102 = (await env.model('sale.order').search({ where: { name: 'SO102' } })).length;
      const gone = await env
        .model('sale.order')
        .browse([createdId])
        .load()
        .catch((e: unknown) => e);
      return { note, flushQueries, so102, gone };
    });
    expect(result.note).toBe('bulk'); // the savepoint's write was undone in memory
    expect(result.flushQueries).toBe(1); // nothing dirty was left behind: just the SELECT
    expect(result.so102).toBe(1);
    expect(result.gone).toBeInstanceOf(MissingRecordError);
  });

  test('a released savepoint keeps its writes', async () => {
    await run(async (env) => {
      await env.transaction(async (sp) => {
        const o = (await sp.model('sale.order').search({ where: { name: 'SO101' } })).ensureOne();
        await o.write({ note: 'kept' });
      });
      const o = (await env.model('sale.order').search({ where: { name: 'SO101' } })).ensureOne();
      expect(o.note).toBe('kept');
    });
  });
});

async function currency(
  env: Env<S>,
  id: Id<'res.currency'>,
): Promise<{ currency: Money['currency'] }> {
  const order = await env
    .model('sale.order')
    .create([{ ...orderValues(`tmp-${Math.random()}`), currency: id }]);
  const c = order.ensureOne().amountTotal.currency;
  await order.unlink();
  return { currency: c };
}

async function uom(env: Env<S>, id: Id<'uom.uom'>): Promise<{ uom: Quantity['uom'] }> {
  const order = await env.model('sale.order').create([orderValues(`tmp-${Math.random()}`)]);
  const line = await env.model('sale.order.line').create([
    {
      order: order.ensureOne().id,
      name: 'tmp',
      currency: ids.bdt,
      uom: id,
      quantity: '1',
      priceUnit: '0',
    },
  ]);
  const u = line.ensureOne().quantity.uom;
  await order.unlink();
  return { uom: u };
}
