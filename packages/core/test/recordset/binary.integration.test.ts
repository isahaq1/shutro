/**
 * Binary fields through the write paths (feedback from Kosh: `create()` with bytes failed with "cannot cast type
 * bytea to bytea[]": batch inserts bind arrays of byte values). Create, update, load, and null.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
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
const File = defineModel('x.file', {
  access: { 'base.user': ['read', 'write', 'create', 'unlink'] },
  fields: { name: f.char({ required: true }), content: f.binary() },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [defineGroup({ code: 'base.user' })],
      models: [Users, Currency, Company, File],
    }),
  ],
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 2, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query({ text: "INSERT INTO res_users (login) VALUES ('alice')", params: [] });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('bytes are created, updated and read back intact, in batches, next to nulls', async () => {
  const shutro = createShutro({ driver, registry });
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x0a]); // "%PDF-" plus awkward bytes
  const big = new Uint8Array(70_000).map((_, i) => i % 251);
  await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, async (env) => {
    const files = await env.model('x.file').create([
      { name: 'a.pdf', content: pdf },
      { name: 'empty', content: null },
      { name: 'big.bin', content: big },
    ]);
    const loaded = await files.load(['name', 'content']);
    const byName = new Map(loaded.read(['name', 'content']).map((r) => [r['name'], r['content']]));
    expect(Buffer.from(byName.get('a.pdf') as Uint8Array)).toEqual(Buffer.from(pdf));
    expect(byName.get('empty')).toBeNull();
    expect(Buffer.from(byName.get('big.bin') as Uint8Array).equals(Buffer.from(big))).toBe(true);

    await files.write({ content: new Uint8Array([1, 2, 3]) }); // the batch update path
    const again = await env.model('x.file').browse(files.ids).load(['content']);
    for (const r of again.read(['content']))
      expect(Buffer.from(r['content'] as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
  });
});
