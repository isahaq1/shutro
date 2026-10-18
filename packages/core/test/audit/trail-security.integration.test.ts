/** records.trail() under field security (RFC 0013 §10): unreadable fields leave the trail and the snapshots. */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildRegistry,
  createShutro,
  createTableStatements,
  defineGroup,
  defineModel,
  defineModule,
  f,
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
const Deal = defineModel('x.deal', {
  access: { 'base.user': ['read', 'write', 'create'] },
  tracking: ['name', 'margin'],
  fields: {
    name: f.char({ required: true }),
    margin: f.char({ groups: { read: ['x.finance'], write: ['x.finance'] } }),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [
        defineGroup({ code: 'base.user' }),
        defineGroup({ code: 'x.finance', implies: ['base.user'] }),
      ],
      models: [Users, Currency, Company, Deal],
    }),
  ],
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'alice'})`));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('rows and snapshot keys of unreadable fields are left out', async () => {
  const shutro = createShutro({ driver, registry });
  const finance = { user: 1, company: 1, groups: ['x.finance'] };
  const id = await shutro.run(finance, async (env) => {
    const deal = (await env.model('x.deal').create([{ name: 'D1', margin: '12%' }])).first();
    return deal.id;
  });
  await shutro.run(finance, (env) => env.model('x.deal').browse([id]).write({ margin: '15%' }));
  await shutro.run(finance, (env) => env.model('x.deal').browse([id]).write({ name: 'D2' }));

  const financeTrail = await shutro.run(finance, (env) => env.model('x.deal').browse([id]).trail());
  expect(financeTrail.map((r) => `${r.action}:${r.field ?? ''}`)).toEqual([
    'write:name',
    'write:margin',
    'create:',
  ]);
  expect(financeTrail[2]?.new).toMatchObject({ name: 'D1', margin: '12%' });

  const userTrail = await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, (env) =>
    env.model('x.deal').browse([id]).trail(),
  );
  expect(userTrail.map((r) => `${r.action}:${r.field ?? ''}`)).toEqual(['write:name', 'create:']);
  expect(userTrail[1]?.new).toEqual({ name: 'D1' });

  // `limit` counts visible rows: hidden margin rows do not shorten a page.
  for (const margin of ['16%', '17%', '18%'])
    await shutro.run(finance, (env) => env.model('x.deal').browse([id]).write({ margin }));
  const page = await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, (env) =>
    env.model('x.deal').browse([id]).trail({ limit: 2 }),
  );
  expect(page.map((r) => `${r.action}:${r.field ?? ''}`)).toEqual(['write:name', 'create:']);
});
