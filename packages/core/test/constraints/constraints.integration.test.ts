/**
 * Constraints and onchange on PostgreSQL (RFC 0009): business constraints at flush points for changed records only,
 * SQL constraint and foreign-key errors with declared messages, and drafts that compute without writing.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  ConstraintError,
  ConstraintViolationError,
  type CreateValues,
  createShutro,
  createTableStatements,
  type Env,
  type Id,
  type Shutro,
  toDecimal,
} from '../../src/index.js';
import { calls, registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const identity = { user: 1, company: 1, companies: [1] } as const;
let ids: {
  bdt: Id<'res.currency'>;
  usd: Id<'res.currency'>;
  acme: Id<'res.partner'>;
  globex: Id<'res.partner'>;
};

async function run<T>(fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return shutro.run(identity, fn);
}

async function count(table: string): Promise<number> {
  const [row] = await driver.query<{ n: number }>(
    compile(sql`SELECT count(*)::int AS n FROM ${sql.id(table)}`),
  );
  return row?.n ?? 0;
}

type OrderValues = CreateValues<S, 'sale.order'>;
function order(name: string, extra: Partial<OrderValues> = {}): OrderValues {
  return { name, partner: ids.acme, currency: ids.bdt, ...extra };
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
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
  const [acme, globex] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name, email, currency_id, active) VALUES (${'Acme'}, ${null}, ${usd?.id ?? 0}, ${true}), (${'Globex'}, ${'g@x.com'}, ${null}, ${true}) RETURNING id`,
    ),
  );
  ids = {
    bdt: (bdt?.id ?? 0) as Id<'res.currency'>,
    usd: (usd?.id ?? 0) as Id<'res.currency'>,
    acme: (acme?.id ?? 0) as Id<'res.partner'>,
    globex: (globex?.id ?? 0) as Id<'res.partner'>,
  };
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

beforeEach(() => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
});

describe('business constraints', () => {
  test('a failing record is a ConstraintError at the flush point, with the declared message and the ids', async () => {
    const error = await run(async (env) => {
      await env.model('sale.order').create([order('BAD', { validityDate: '2026-09-01' })]);
      await env.flush();
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConstraintError);
    const e = error as ConstraintError;
    expect(e.model).toBe('sale.order');
    expect(e.constraint).toBe('validity');
    expect(e.fields).toEqual(['validityDate', 'dateOrder']);
    expect(e.records).toHaveLength(1);
    expect(e.message).toContain('before the order date on 1 order(s)');
    expect(await count('sale_order')).toBe(0); // the transaction was rolled back
  });

  test('only records whose depends changed are checked, in one batch', async () => {
    await run(async (env) => {
      const orders = await env
        .model('sale.order')
        .create([order('OK1'), order('OK2', { validityDate: '2026-12-31' })]);
      await env.flush();
      expect(calls.validity).toBe(1);
      const [a, b] = [...orders];
      if (a === undefined || b === undefined) throw new Error('two');
      await a.write({ note: 'no check' });
      await env.flush();
      expect(calls.validity).toBe(1);
      await b.write({ dateOrder: '2026-11-01' });
      await a.write({ dateOrder: '2026-11-02' });
      await env.flush();
      expect(calls.validity).toBe(2); // one call for both records
      await b.write({ validityDate: '2026-01-01' });
      // search() is a flush point: the check runs before the query
      await expect(env.model('sale.order').search({ where: { name: 'OK1' } })).rejects.toThrow(
        ConstraintError,
      );
    });
  });

  test('constraints see computed values and run on child models too', async () => {
    const error = await run(async (env) => {
      await env.model('sale.order').create([
        order('LINES', {
          lines: { create: [{ name: 'zero', quantity: '0', priceUnit: '5', currency: ids.bdt }] },
        }),
      ]);
      await env.flush();
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConstraintError);
    expect((error as ConstraintError).constraint).toBe('positiveQuantity');
    expect((error as ConstraintError).message).toContain('Line quantities must be positive.');
  });
});

describe('SQL constraints', () => {
  test('a unique violation on insert carries the declared message', async () => {
    const error = await run(async (env) => {
      await env.model('sale.order').create([order('DUP'), order('DUP')]);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConstraintViolationError);
    const e = error as ConstraintViolationError;
    expect(e.kind).toBe('unique');
    expect(e.model).toBe('sale.order');
    expect(e.constraint).toBe('nameUnique');
    expect(e.fields).toEqual(['company', 'name']);
    expect(e.message).toContain('Order reference must be unique per company.');
  });

  test('a check violation at flush time', async () => {
    const error = await run(async (env) => {
      const so = (await env.model('sale.order').create([order('TAX')])).first();
      await env.flush();
      await so.write({ taxRate: '-1' });
      await env.flush();
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).kind).toBe('check');
    expect((error as ConstraintViolationError).constraint).toBe('taxRateNonNegative');
    expect((error as ConstraintViolationError).message).toContain(
      'The tax rate cannot be negative.',
    );
  });

  test('a foreign-key violation names the field', async () => {
    const error = await run(async (env) => {
      await env
        .model('sale.order.line')
        .create([{ order: 999_999 as Id<'sale.order'>, name: 'x', currency: ids.bdt }]);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConstraintViolationError);
    expect((error as ConstraintViolationError).kind).toBe('foreign_key');
    expect((error as ConstraintViolationError).constraint).toBe('order');
    expect((error as ConstraintViolationError).fields).toEqual(['order']);
  });
});

describe('onchange', () => {
  test('a new draft: handlers cascade once per field, computes run, nothing is written', async () => {
    const before = await count('sale_order');
    await run(async (env) => {
      const result = await env.model('sale.order').onchange({
        values: { name: 'DRAFT', partner: ids.acme },
        changed: ['partner'],
      });
      expect(result.values.currency).toBe(ids.usd); // from the partner
      expect(result.values.note).toBe('currency set by uid 1'); // the currency handler ran after set()
      expect(result.values.amountTotal).toEqual({ amount: '0.00', currency: 'USD' });
      expect(result.values.name).toBeUndefined(); // unchanged input is not echoed
      expect(result.warnings).toEqual(['This partner has no email address.']);
      expect(calls.partnerOnchange).toBe(1);
      expect(calls.currencyOnchange).toBe(1);
      const queries = env.stats().queries;
      await env.flush();
      expect(env.stats().queries).toBe(queries); // nothing dirty, nothing to compute or check
    });
    expect(await count('sale_order')).toBe(before);
  });

  test('a new draft returns its defaults: they are not part of the input (a new form shows them)', async () => {
    await run(async (env) => {
      const blank = await env.model('sale.order').onchange({ values: {}, changed: [] });
      expect(blank.values.dateOrder).toBe('2026-10-01');
      expect(blank.values.taxRate).toBeDefined();
      // A given value is the input: not echoed, even when it equals the default.
      const given = await env
        .model('sale.order')
        .onchange({ values: { dateOrder: '2026-10-01' }, changed: [] });
      expect(given.values.dateOrder).toBeUndefined();
      expect(given.values.taxRate).toBeDefined();
    });
  });

  test('x2many create rows become virtual children with their computes; totals follow', async () => {
    await run(async (env) => {
      const result = await env.model('sale.order').onchange({
        values: {
          name: 'DRAFT',
          partner: ids.globex,
          currency: ids.bdt,
          lines: {
            create: [
              { name: 'a', quantity: '2', priceUnit: '10', currency: ids.bdt },
              { name: 'b', quantity: '1', priceUnit: '5', currency: ids.bdt },
            ],
          },
        },
        changed: ['lines'],
      });
      expect(result.children.lines?.map((l) => l['subtotal'])).toEqual([
        { amount: '20.00', currency: 'BDT' },
        { amount: '5.00', currency: 'BDT' },
      ]);
      expect(result.values.amountTotal).toEqual({ amount: '27.50', currency: 'BDT' });
      expect(result.warnings).toEqual([]);
      // Child handlers run inside the parent draft: the line takes the order's currency, and warns.
      const withHandlers = await env.model('sale.order').onchange({
        values: {
          name: 'DRAFT',
          partner: ids.globex,
          currency: ids.bdt,
          lines: { create: [{ name: 'c', quantity: '200', priceUnit: '1' }] },
        },
        changed: ['lines'],
      });
      expect(withHandlers.children.lines?.[0]?.['currency']).toBe(ids.bdt);
      expect(withHandlers.children.lines?.[0]?.['subtotal']).toEqual({
        amount: '200.00',
        currency: 'BDT',
      });
      expect(withHandlers.warnings).toEqual(['Large quantity: check the stock.']);
    });
    expect(await count('sale_order_line')).toBe(0);
  });

  test('a draft of an existing record starts from its values and leaves the record untouched', async () => {
    await run(async (env) => {
      const so = (
        await env.model('sale.order').create([
          order('EXISTING', {
            lines: {
              create: [{ name: 'a', quantity: '1', priceUnit: '100', currency: ids.bdt }],
            },
          }),
        ])
      ).first();
      await env.flush();
      expect(so.amountTotal?.toString()).toBe('BDT 110.00');
      const result = await env
        .model('sale.order')
        .onchange({ id: so.id, values: { taxRate: '0.5' }, changed: ['taxRate'] });
      expect(result.values.amountTotal).toEqual({ amount: '150.00', currency: 'BDT' });
      expect(result.values.name).toBeUndefined();
      expect(so.taxRate.toString()).toBe('0.1');
      expect(so.amountTotal?.toString()).toBe('BDT 110.00');
      const queries = env.stats().queries;
      await env.flush();
      expect(env.stats().queries).toBe(queries);
    });
  });
});
