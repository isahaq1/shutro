/** Lost-update protection (RFC 0018 §7.1): compare-and-set writes with `expect`, including two racing saves. */
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
  StaleRecordError,
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
const Invoice = defineModel('account.move', {
  fields: {
    ref: f.char({ required: true }),
    amount: f.decimal({ scale: 2, required: true, default: '0' }),
  },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Invoice] })],
  security: { enforce: false },
});

let pg: StartedPostgres;
let driver: Driver;
let id: Id<'account.move'>;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 6, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'a'}), (${'b'})`));
  id = await createShutro({ driver, registry }).run(
    { user: 1, company: 1 },
    async (env) =>
      (await env.model('account.move').create([{ ref: 'INV/1', amount: '100' }])).first().id,
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

const shutro = () => createShutro({ driver, registry });
const read = () =>
  shutro().run(
    { user: 1, company: 1 },
    async (env) => (await env.model('account.move').browse([id]).load()).first().updatedAt,
  );

test('a save based on an old read is refused; a current one goes through', async () => {
  const seen = await read();
  await shutro().run({ user: 2, company: 1 }, (env) =>
    env.model('account.move').browse([id]).write({ amount: '120' }),
  );
  await expect(
    shutro().run({ user: 1, company: 1 }, (env) =>
      env
        .model('account.move')
        .browse([id])
        .write({ amount: '90' }, { expect: { updatedAt: seen } }),
    ),
  ).rejects.toBeInstanceOf(StaleRecordError);
  const fresh = await read();
  await shutro().run({ user: 1, company: 1 }, (env) =>
    env
      .model('account.move')
      .browse([id])
      .write({ amount: '95' }, { expect: { updatedAt: fresh, amount: '120' } }),
  );
  const [row] = await driver.query<{ amount: unknown }>(
    compile(sql`SELECT amount FROM account_move`),
  );
  expect(String(row?.amount)).toBe('95');
});

test('two racing saves from the same read: exactly one wins', async () => {
  const seen = await read();
  let arrived = 0;
  let release: () => void = () => {};
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const save = (user: number, amount: string) =>
    shutro()
      .run({ user, company: 1 }, async (env) => {
        if (++arrived === 2) release();
        await barrier; // both transactions have started before either writes
        await env
          .model('account.move')
          .browse([id])
          .write({ amount }, { expect: { updatedAt: seen } });
      })
      .then(
        () => 'saved',
        (e: unknown) => (e instanceof StaleRecordError ? 'stale' : `error: ${String(e)}`),
      );
  const outcomes = await Promise.all([save(1, '200'), save(2, '300')]);
  expect([...outcomes].sort()).toEqual(['saved', 'stale']);
});
