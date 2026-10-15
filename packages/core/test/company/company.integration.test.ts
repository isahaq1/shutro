/**
 * Multi-company and multi-currency on PostgreSQL (RFC 0003 §7.4, RFC 0006 §7.6): automatic company filtering,
 * cross-company link protection, and dated per-company conversion.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  CompanyNotAllowedError,
  CrossCompanyError,
  createShutro,
  createTableStatements,
  defineCurrency,
  type Env,
  type Id,
  MissingRateError,
  Money,
  type Shutro,
  toDecimal,
} from '../../src/index.js';
import { registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
let ids: {
  bdt: Id<'res.currency'>;
  usd: Id<'res.currency'>;
  shared: Id<'res.partner'>;
  p1: Id<'res.partner'>;
  p2: Id<'res.partner'>;
};

async function runAs(
  companies: readonly number[],
  fn: (env: Env<S>) => Promise<unknown>,
): Promise<unknown> {
  return shutro.run({ user: 1, company: companies[0] ?? 1, companies }, fn);
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
      sql`INSERT INTO res_company (name, currency_id) VALUES (${'BD'}, ${bdt?.id ?? 0}), (${'SG'}, ${bdt?.id ?? 0})`,
    ),
  );
  const [shared, p1, p2] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name, company_id) VALUES (${'Shared'}, ${null}), (${'Only BD'}, ${1}), (${'Only SG'}, ${2}) RETURNING id`,
    ),
  );
  // Rates: units of USD per BDT. Shared rows for everyone, a company-1 row that overrides them.
  await driver.query(
    compile(sql`INSERT INTO res_currency_rate (currency_id, company_id, date, rate) VALUES
      (${usd?.id ?? 0}, ${null}, ${'2026-01-01'}, ${'0.0125'}),
      (${usd?.id ?? 0}, ${null}, ${'2026-06-01'}, ${'0.02'}),
      (${usd?.id ?? 0}, ${1}, ${'2026-01-01'}, ${'0.01'})`),
  );
  ids = {
    bdt: (bdt?.id ?? 0) as Id<'res.currency'>,
    usd: (usd?.id ?? 0) as Id<'res.currency'>,
    shared: (shared?.id ?? 0) as Id<'res.partner'>,
    p1: (p1?.id ?? 0) as Id<'res.partner'>,
    p2: (p2?.id ?? 0) as Id<'res.partner'>,
  };
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('multi-company', () => {
  test('searches are filtered to the allowed companies plus shared records', async () => {
    await runAs([1], async (env) => {
      const names = (await env.model('res.partner').search({ order: ['name'] })).mapped('name');
      expect(names).toEqual(['Only BD', 'Shared']);
    });
    await runAs([1, 2], async (env) => {
      const names = (await env.model('res.partner').search({ order: ['name'] })).mapped('name');
      expect(names).toEqual(['Only BD', 'Only SG', 'Shared']);
    });
  });

  test('withCompany switches the default company of new records; a company outside the allowed set is refused', async () => {
    await runAs([1, 2], async (env) => {
      const sg = env.withCompany(2);
      const p = (await sg.model('res.partner').create([{ name: 'Made in SG' }])).first();
      expect(p.company?.id).toBe(2);
      expect(() => env.withCompany(3)).toThrow(CompanyNotAllowedError);
    });
  });

  test('a checkCompany link to another company fails at the flush point; shared and same-company links pass', async () => {
    await runAs([1], async (env) => {
      await env.model('sale.order').create([
        { name: 'OK shared', partner: ids.shared, currency: ids.bdt },
        { name: 'OK same', partner: ids.p1, currency: ids.bdt },
      ]);
      await env.flush();
    });
    const error = await runAs([1, 2], async (env) => {
      await env.model('sale.order').create([{ name: 'BAD', partner: ids.p2, currency: ids.bdt }]);
      await env.flush();
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrossCompanyError);
    const e = error as CrossCompanyError;
    expect(e.model).toBe('sale.order');
    expect(e.records[0]).toMatchObject({ field: 'partner', company: 1, targetCompany: 2 });

    // A later write is checked too, and a superuser may disable the check.
    const later = await runAs([1, 2], async (env) => {
      const so = (await env.model('sale.order').search({ where: { name: 'OK same' } })).first();
      await so.write({ partner: ids.p2 });
      await env.flush();
    }).catch((e: unknown) => e);
    expect(later).toBeInstanceOf(CrossCompanyError);
    await runAs([1, 2], async (env) => {
      await env.asSuperuser({ reason: 'test' }, async (su) => {
        const relaxed = su.withFlags({ checkCompany: false });
        const so = (
          await relaxed.model('sale.order').search({ where: { name: 'OK same' } })
        ).first();
        await so.write({ partner: ids.p2 });
        await relaxed.flush();
        await so.write({ partner: ids.p1 });
        await relaxed.flush();
      });
    });
  });
});

describe('multi-currency', () => {
  test('convert uses the latest rate on or before the date, company rows first, rounded to the target', async () => {
    await runAs([1], async (env) => {
      const usd = Money.of('100', defineCurrency({ code: 'USD', rounding: '0.01', id: ids.usd }));
      const company1 = await env.fx.convert(usd, ids.bdt, { date: '2026-03-01' });
      expect(company1.money.toString()).toBe('BDT 10000.00'); // company-1 rate 0.01 USD per BDT
      expect(company1.rate.toString()).toBe('100');
      expect(company1.rateDate).toBe('2026-01-01');

      const company2 = await env.fx.convert(usd, ids.bdt, { date: '2026-03-01', company: 2 });
      expect(company2.money.toString()).toBe('BDT 8000.00'); // shared rate 0.0125
      const june = await env.fx.convert(usd, ids.bdt, { date: '2026-07-15', company: 2 });
      expect(june.money.toString()).toBe('BDT 5000.00'); // shared rate 0.02 from June
      expect(june.rateDate).toBe('2026-06-01');

      const back = await env.fx.convert(june.money, ids.usd, { date: '2026-07-15', company: 2 });
      expect(back.money.toString()).toBe('USD 100.00');
      const unrounded = await env.fx.convert(Money.of('1', company1.to), ids.usd, {
        date: '2026-07-15',
        company: 2,
        round: false,
      });
      expect(unrounded.money.amount.toString()).toBe('0.02');
      const same = await env.fx.convert(usd, ids.usd, { date: '2026-07-15' });
      expect(same.rate.toString()).toBe('1');
      expect(same.rateDate).toBeNull();
    });
  });

  test('prepare() loads once and converts synchronously; missing rates are typed errors', async () => {
    await runAs([2], async (env) => {
      const rates = await env.fx.prepare({ date: '2026-02-01', currencies: [ids.usd, ids.bdt] });
      const queries = env.stats().queries;
      const usd = Money.of('50', defineCurrency({ code: 'USD', rounding: '0.01', id: ids.usd }));
      const bdt = defineCurrency({ code: 'BDT', rounding: '0.01', id: ids.bdt });
      expect(rates.convert(usd, bdt).money.toString()).toBe('BDT 4000.00');
      expect(rates.rate(usd.currency)).toEqual({ rate: toDecimal('0.0125'), date: '2026-01-01' });
      // By id, synchronously (feedback #9): the prepared currencies and the company currency.
      expect(rates.convert(usd, ids.bdt).money.toString()).toBe('BDT 4000.00');
      expect(rates.currency(ids.usd).code).toBe('USD');
      expect(rates.rate(ids.usd).rate).toEqual(toDecimal('0.0125'));
      expect(rates.companyCurrency.code).toBe('BDT');
      expect(() => rates.currency(999_999)).toThrow(MissingRateError);
      expect(env.stats().queries).toBe(queries);
      await expect(env.fx.convert(usd, ids.bdt, { date: '2025-12-31' })).rejects.toBeInstanceOf(
        MissingRateError,
      );
      await expect(env.fx.convert(usd, ids.bdt, { date: 'yesterday' })).rejects.toThrow(
        /calendar date/,
      );
    });
  });
});
