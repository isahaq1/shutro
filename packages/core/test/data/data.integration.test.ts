/**
 * Module data and external ids (RFC 0017): typed declarations checked at build, idempotent loading with checksums,
 * noupdate ownership, overrides, obsolete records, and env.ref.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildRegistry,
  createShutro,
  createTableStatements,
  type DataRecord,
  defineModel,
  defineModule,
  f,
  InvalidModuleError,
  loadData,
  override,
  record,
  ref,
  toDecimal,
  UnknownExternalIdError,
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
const Tax = defineModel('account.tax', {
  fields: {
    name: f.char({ required: true }),
    rate: f.decimal({ scale: 4, required: true }),
    currency: f.many2one('res.currency'),
  },
});

function modules(baseData: readonly DataRecord[], saleData: readonly DataRecord[]) {
  const base = defineModule({ name: 'base', models: [Users, Currency, Company], data: baseData });
  const sale = defineModule({ name: 'sale', depends: [base], models: [Tax], data: saleData });
  return buildRegistry({ modules: [sale], security: { enforce: false } });
}

const BASE_V1 = [
  record('res.currency', 'currency_bdt', { name: 'BDT', rounding: '0.01' }),
  record('res.currency', 'currency_usd', { name: 'USD', rounding: '0.01' }),
  record(
    'res.company',
    'main_company',
    { name: 'My Company', currency: ref('res.currency', 'base.currency_bdt') },
    { noupdate: true },
  ),
];
const SALE_V1 = [
  record('account.tax', 'vat_15', {
    name: 'VAT 15%',
    rate: '0.15',
    currency: ref('res.currency', 'base.currency_bdt'),
  }),
  record('account.tax', 'vat_5', { name: 'VAT 5%', rate: '0.05' }),
  override('res.company', 'base.main_company', { name: 'Acme Ltd' }),
];

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(modules(BASE_V1, SALE_V1)))
    await driver.query(statement);
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

const names = async (table: string): Promise<string[]> =>
  (
    await driver.query<{ name: string }>(
      compile(sql`SELECT name FROM ${sql.id(table)} ORDER BY id`),
    )
  ).map((r) => r.name);

describe('loading', () => {
  test('first load creates in order; a second load changes nothing', async () => {
    const shutro = createShutro({ driver, registry: modules(BASE_V1, SALE_V1) });
    const first = await loadData(shutro);
    expect(first.map((r) => [r.module, r.created])).toEqual([
      ['base', ['base.currency_bdt', 'base.currency_usd', 'base.main_company']],
      ['sale', ['sale.vat_15', 'sale.vat_5']],
    ]);
    expect(first[1]?.updated).toEqual(['base.main_company']); // the override
    expect(await names('res_company')).toEqual(['Acme Ltd']);
    const again = await loadData(shutro);
    expect(again.flatMap((r) => [...r.created, ...r.updated, ...r.deleted])).toEqual([]);
    expect(again.map((r) => r.unchanged + r.kept.length)).toEqual([3, 3]);
  });

  test('env.ref and refId', async () => {
    const shutro = createShutro({ driver, registry: modules(BASE_V1, SALE_V1) });
    await shutro.run({ user: 1, company: 1 }, async (env) => {
      const vat = await (await env.ref('account.tax', 'sale.vat_15')).load();
      expect([vat.first().name, String(vat.first().rate)]).toEqual(['VAT 15%', '0.15']);
      expect(vat.first().currency?.id).toBe(await env.refId('res.currency', 'base.currency_bdt'));
      await expect(env.ref('res.currency', 'sale.vat_15')).rejects.toThrow(
        /is a account.tax, not a res.currency/,
      );
      await expect(env.ref('res.currency', 'base.nope')).rejects.toBeInstanceOf(
        UnknownExternalIdError,
      );
    });
  });

  test("upgrades: changed records update, noupdate records stay the users', removed ones go", async () => {
    // Users rename the company (noupdate) and delete a currency the data still declares.
    await driver.query(compile(sql`UPDATE res_company SET name = ${'Renamed by users'}`));
    const usd = await createShutro({ driver, registry: modules(BASE_V1, SALE_V1) }).run(
      { user: 1, company: 1 },
      (env) => env.refId('res.currency', 'base.currency_usd'),
    );
    await driver.query(compile(sql`DELETE FROM res_currency WHERE id = ${usd}`));
    const v2 = modules(
      [
        record('res.currency', 'currency_bdt', { name: 'BDT', rounding: '0.0100' }), // changed
        record('res.currency', 'currency_usd', { name: 'USD', rounding: '0.01' }),
        record(
          'res.company',
          'main_company',
          { name: 'My Company v2', currency: ref('res.currency', 'base.currency_bdt') },
          { noupdate: true },
        ),
      ],
      [
        record('account.tax', 'vat_15', {
          name: 'VAT 15%',
          rate: '0.15',
          currency: ref('res.currency', 'base.currency_bdt'),
        }),
      ], // vat_5 and the override removed
    );
    const result = await loadData(createShutro({ driver, registry: v2 }));
    const base = result.find((r) => r.module === 'base');
    const sale = result.find((r) => r.module === 'sale');
    expect(base?.updated).toEqual(['base.currency_bdt']);
    expect(base?.created).toEqual(['base.currency_usd']); // deleted by users, recreated (not noupdate)
    expect(base?.kept).toEqual(['base.main_company']);
    expect(sale?.deleted).toEqual(['sale.vat_5']);
    expect(await names('res_company')).toEqual(['Renamed by users']);
    expect(await names('account_tax')).toEqual(['VAT 15%']);
  });

  test('a removed record that is still referenced is kept and reported', async () => {
    const v3 = modules(
      [
        record('res.currency', 'currency_usd', { name: 'USD', rounding: '0.01' }),
        record(
          'res.company',
          'main_company',
          { name: 'x', currency: ref('res.currency', 'base.currency_usd') },
          { noupdate: true },
        ),
      ],
      [],
    );
    const [base] = await loadData(createShutro({ driver, registry: v3 }), { modules: ['base'] });
    // BDT is the company's currency (and the tax's): the foreign key keeps it.
    expect(base?.retained.map((r) => r.id)).toEqual(['base.currency_bdt']);
    expect(await names('res_currency')).toContain('BDT');
  });
});

describe('declarations are checked at build', () => {
  test('references, fields, overrides, duplicates and names', () => {
    expect(() =>
      modules([record('res.currency', 'x', { name: 'X', nope: 1 } as never)], []),
    ).toThrow(/sets 'nope', which is not a field/);
    expect(() =>
      modules(
        [],
        [
          record('account.tax', 't', {
            name: 'T',
            rate: '1',
            currency: ref('res.currency', 'base.missing'),
          }),
        ],
      ),
    ).toThrow(/refers to 'base.missing', which is not declared/);
    expect(() =>
      modules(BASE_V1, [
        record('account.tax', 't', {
          name: 'T',
          rate: '1',
          currency: ref('res.company', 'base.currency_bdt') as never,
        }),
      ]),
    ).toThrow(/as res.company, but it is a res.currency/);
    expect(() =>
      modules(BASE_V1, [override('res.company', 'sale.nothing', { name: 'x' })]),
    ).toThrow(/which no dependency declares/);
    expect(() =>
      modules([...BASE_V1, record('res.currency', 'currency_bdt', { name: 'B' })], []),
    ).toThrow(/declared twice/);
    expect(() =>
      modules(
        [
          record('res.company', 'c', { name: 'C', currency: ref('res.currency', 'base.later') }),
          record('res.currency', 'later', { name: 'L' }),
        ],
        [],
      ),
    ).toThrow(/not declared before it/);
    expect(() => record('res.currency', 'Bad Name', {})).toThrow(InvalidModuleError);
  });
});
