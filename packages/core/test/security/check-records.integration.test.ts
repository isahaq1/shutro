/** env.access.checkRecords (RFC 0014 §7.3): may this user write these records? Nothing is changed. */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  createShutro,
  createTableStatements,
  defineGroup,
  defineModel,
  defineModule,
  f,
  MissingRecordError,
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
const Doc = defineModel('x.doc', {
  access: { 'base.user': ['read', 'write', 'create'] },
  rules: {
    own: { groups: ['base.user'], perms: ['write'], domain: { owner: { $env: 'uid' } } },
  },
  fields: { name: f.char({ required: true }), owner: f.many2one('res.users', { required: true }) },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [defineGroup({ code: 'base.user' })],
      models: [Users, Currency, Company, Doc],
    }),
  ],
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'alice'}), (${'bob'})`));
  await driver.query(
    compile(sql`INSERT INTO x_doc (name, owner_id) VALUES (${'A'}, 1), (${'B'}, 2)`),
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('rules of the permission decide; unknown ids are missing; no ACL is an AccessError', async () => {
  const shutro = createShutro({ driver, registry });
  const alice = { user: 1, company: 1, groups: ['base.user'] };
  await shutro.run(alice, async (env) => {
    await expect(env.access.checkRecords('x.doc', [1], 'write')).resolves.toBeUndefined();
    await expect(env.access.checkRecords('x.doc', [1, 2], 'write')).rejects.toBeInstanceOf(
      AccessError,
    );
    await expect(env.access.checkRecords('x.doc', [99], 'write')).rejects.toBeInstanceOf(
      MissingRecordError,
    );
    await expect(env.access.checkRecords('x.doc', [2], 'unlink')).rejects.toBeInstanceOf(
      AccessError,
    );
  });
  // Nothing was written.
  const rows = await driver.query<{ name: string }>(
    compile(sql`SELECT name FROM x_doc ORDER BY id`),
  );
  expect(rows.map((r) => r.name)).toEqual(['A', 'B']);
});
