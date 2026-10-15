/**
 * Related fields: mirrors of fields along many2one paths, stored or not, writable or not, with kinds checked at build.
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
  f,
  type Id,
  InvalidFieldError,
  InvalidRelationError,
  related,
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
const Country = defineModel('res.country', { fields: { code: f.char({ required: true }) } });
const Partner = defineModel('res.partner', {
  fields: { name: f.char({ required: true }), email: f.char(), country: f.many2one('res.country') },
});
const Order = defineModel('sale.order', {
  fields: {
    partner: f.many2one('res.partner', { required: true }),
    partnerEmail: f.char({ ...related('partner.email', { writable: true }) }),
    countryCode: f.char({ store: true, ...related('partner.country.code') }),
    country: f.many2one('res.country', { store: true, ...related('partner.country') }),
  },
});
const models = [Users, Currency, Company, Country, Partner, Order];
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models })],
  security: { enforce: false },
});

let pg: StartedPostgres;
let driver: Driver;

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

test('stored related fields follow the path and recompute when any step changes', async () => {
  await createShutro({ driver, registry }).run({ user: 1, company: 1 }, async (env) => {
    const [bd, us] = await env.model('res.country').create([{ code: 'BD' }, { code: 'US' }]);
    const partner = (
      await env
        .model('res.partner')
        .create([{ name: 'Acme', email: 'a@acme.test', country: bd?.id ?? null }])
    ).first();
    const order = (await env.model('sale.order').create([{ partner: partner.id }])).first();
    await env.flush();
    const read = async () =>
      (
        await env
          .model('sale.order')
          .browse([order.id])
          .load(['countryCode', 'country', 'partnerEmail'])
      ).first();
    expect([
      (await read()).countryCode,
      (await read()).country?.id,
      (await read()).partnerEmail,
    ]).toEqual(['BD', bd?.id, 'a@acme.test']);
    // Three steps away: the country's code.
    await bd?.write({ code: 'BGD' });
    await env.flush();
    expect((await read()).countryCode).toBe('BGD');
    // The middle step: the partner's country.
    await partner.write({ country: us?.id ?? null });
    await env.flush();
    expect([(await read()).countryCode, (await read()).country?.id]).toEqual(['US', us?.id]);
    // Stored related fields are columns: searchable.
    expect((await env.model('sale.order').search({ where: { countryCode: 'US' } })).ids).toEqual([
      order.id,
    ]);
    // Writable related: writes the partner.
    await (await read()).write({ partnerEmail: 'new@acme.test' });
    await env.flush();
    expect((await env.model('res.partner').browse([partner.id]).load()).first().email).toBe(
      'new@acme.test',
    );
  });
  const [row] = await driver.query<{ country_code: string }>(
    compile(sql`SELECT country_code FROM sale_order`),
  );
  expect(row?.country_code).toBe('US');
});

test('an empty step gives null', async () => {
  await createShutro({ driver, registry }).run({ user: 1, company: 1 }, async (env) => {
    const partner = (await env.model('res.partner').create([{ name: 'Nowhere' }])).first();
    const order = (
      await env.model('sale.order').create([{ partner: partner.id as Id<'res.partner'> }])
    ).first();
    await env.flush();
    const loaded = (
      await env.model('sale.order').browse([order.id]).load(['countryCode', 'partnerEmail'])
    ).first();
    expect([loaded.countryCode, loaded.partnerEmail]).toEqual([null, null]);
  });
});

test('kinds and paths are checked when the registry is built', () => {
  const build = (fields: Parameters<typeof defineModel>[1]['fields']) =>
    buildRegistry({
      modules: [
        defineModule({
          name: 'y',
          models: [...models.filter((m) => m !== Order), defineModel('sale.order', { fields })],
        }),
      ],
      security: { enforce: false },
    });
  expect(() =>
    build({
      partner: f.many2one('res.partner'),
      wrong: f.integer({ ...related('partner.email') }),
    }),
  ).toThrow(/is a integer, but the path ends at a char/);
  expect(() =>
    build({
      partner: f.many2one('res.partner'),
      c: f.many2one('res.partner', { ...related('partner.country') }),
    }),
  ).toThrow(InvalidRelationError);
  expect(() => related('partner')).toThrow(InvalidFieldError);
});
