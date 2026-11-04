/**
 * Two fixes asked for by Kosh (its requests #33 and #34):
 * - a one2many loads its records when the target has a field named `parent` (the batch's parent alias no longer
 *   collides with the target's own `parent_id`);
 * - a stored compute reads fields the user may not see and stores its value for them (computes are the engine's),
 *   while the user still cannot read the result.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  createShutro,
  createTableStatements,
  type Decimal,
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
const MANAGERS = { read: ['x.manager'], write: ['x.manager'] };
const Box = defineModel('x.box', {
  access: { 'base.user': ['read', 'write', 'create'] },
  fields: {
    name: f.char({ required: true }),
    items: f.one2many('x.item', 'box'),
    rate: f.decimal({ scale: 2, groups: MANAGERS }),
  },
});
const Item = defineModel('x.item', {
  access: { 'base.user': ['read', 'write', 'create'] },
  fields: {
    name: f.char({ required: true }),
    box: f.many2one('x.box'),
    // A field named `parent`: its column `parent_id` once took the place of the batch's parent alias.
    parent: f.many2one('x.item'),
    hours: f.decimal({ scale: 2, required: true, default: '0' }),
    cost: f.decimal({
      scale: 2,
      store: true,
      groups: { read: ['x.manager'] },
      depends: ['hours', 'box.rate'],
      compute(records: unknown): void {
        for (const i of records as Iterable<{
          hours: Decimal;
          box: { rate: Decimal | null } | null;
          cost: Decimal;
        }>)
          i.cost = i.hours.times(i.box?.rate ?? 0);
      },
    }),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [
        defineGroup({ code: 'base.user' }),
        defineGroup({ code: 'x.manager', implies: ['base.user'] }),
      ],
      models: [Users, Currency, Company, Box, Item],
    }),
  ],
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'maria'}), (${'rahim'})`));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('a one2many to a model with a `parent` field loads its records', async () => {
  const shutro = createShutro({ driver, registry });
  await shutro.run({ user: 1, company: 1, groups: ['x.manager'] }, async (env) => {
    const box = await env.model('x.box').create([{ name: 'Tools' }]);
    const [first] = (
      await env.model('x.item').create([{ name: 'Hammer', box: box.ids[0] ?? null }])
    ).ids;
    await env
      .model('x.item')
      .create([{ name: 'Head', box: box.ids[0] ?? null, parent: first ?? null }]);
  });
  await shutro.run({ user: 1, company: 1, groups: ['x.manager'] }, async (env) => {
    const [box] = await env
      .model('x.box')
      .search({})
      .then((r) => r.load({ items: true }));
    expect([...(box?.items ?? [])].map((i) => i.name).sort()).toEqual(['Hammer', 'Head']);
  });
});

test('a compute reads and stores what the user may not see; the user still cannot read it', async () => {
  const shutro = createShutro({ driver, registry });
  const box = await shutro.run(
    { user: 1, company: 1, groups: ['x.manager'] },
    async (env) =>
      (await env.model('x.box').create([{ name: 'Paid', rate: '500' }])).ids[0] ?? null,
  );
  // A user logs hours: the cost is computed with the manager-only rate.
  const item = await shutro.run({ user: 2, company: 1, groups: ['base.user'] }, async (env) => {
    const made = await env.model('x.item').create([{ name: 'Work', box, hours: '2' }]);
    await expect(env.model('x.item').browse(made.ids).load(['cost'])).rejects.toBeInstanceOf(
      AccessError,
    );
    return made.ids[0];
  });
  await shutro.run({ user: 1, company: 1, groups: ['x.manager'] }, async (env) => {
    const [row] = await env
      .model('x.item')
      .browse([item as never])
      .load(['cost']);
    expect(Number(row?.cost)).toBe(1000);
  });
});
