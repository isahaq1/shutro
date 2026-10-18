/**
 * Time travel (RFC 0018 §7.4): models with `history: true` keep every version of their rows; `env.asOf(instant)`
 * reads them as they were, including deleted records and raw SQL changes; the past is read-only.
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
  type Env,
  f,
  type Id,
  type Shutro,
  toDecimal,
  ValidationError,
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
const Partner = defineModel('res.partner', { fields: { name: f.char({ required: true }) } });
const Move = defineModel('account.move', {
  history: true,
  fields: {
    name: f.char({ required: true }),
    state: f.selection({ draft: 'Draft', posted: 'Posted' }, { required: true, default: 'draft' }),
    amount: f.decimal({ scale: 2, required: true }),
    partner: f.many2one('res.partner'),
  },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Partner, Move] })],
  security: { enforce: false },
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const t: Record<string, Date> = {};
const ids: Record<string, Id<'account.move'>> = {};

const run = <T>(fn: (env: Env<S>) => Promise<T>): Promise<T> =>
  shutro.run({ user: 1, company: 1 }, fn);
const clock = async (): Promise<Date> => {
  const [row] = await driver.query<{ at: Date }>({
    text: 'SELECT clock_timestamp() AS at',
    params: [],
  });
  return row?.at as Date;
};
const pastAmounts = (at: Date) =>
  run((env) =>
    env.asOf(at, async (past) =>
      (await past.model('account.move').search({ order: ['name'] })).map((m) => [
        m.name,
        m.state,
        String(m.amount),
      ]),
    ),
  );

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  shutro = createShutro({ driver, registry });
  await run(async (env) => {
    const [a, b] = await env.model('account.move').create([
      { name: 'A', amount: '100' },
      { name: 'B', amount: '50' },
    ]);
    ids['A'] = a?.id as Id<'account.move'>;
    ids['B'] = b?.id as Id<'account.move'>;
  });
  t['created'] = await clock();
  await run((env) =>
    env
      .model('account.move')
      .browse([ids['A'] as number])
      .write({ amount: '120', state: 'posted' }),
  );
  t['posted'] = await clock();
  await run(async (env) => {
    const a = env.model('account.move').browse([ids['A'] as number]);
    await a.write({ amount: '130' });
    await env.flush();
    await a.write({ amount: '140' }); // a second change in the same transaction
  });
  t['corrected'] = await clock();
  await run((env) =>
    env
      .model('account.move')
      .browse([ids['B'] as number])
      .unlink(),
  );
  t['deleted'] = await clock();
  await driver.query(compile(sql`UPDATE account_move SET amount = 999 WHERE name = ${'A'}`)); // raw SQL
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('the past as it was: values, states, deleted records, raw SQL changes', async () => {
  expect(await pastAmounts(t['created'] as Date)).toEqual([
    ['A', 'draft', '100'],
    ['B', 'draft', '50'],
  ]);
  expect(await pastAmounts(t['posted'] as Date)).toEqual([
    ['A', 'posted', '120'],
    ['B', 'draft', '50'],
  ]);
  expect(await pastAmounts(t['corrected'] as Date)).toEqual([
    ['A', 'posted', '140'],
    ['B', 'draft', '50'],
  ]);
  expect(await pastAmounts(t['deleted'] as Date)).toEqual([['A', 'posted', '140']]);
  expect(await pastAmounts(new Date())).toEqual([['A', 'posted', '999']]);
  // Before anything existed.
  expect(await pastAmounts(new Date((t['created'] as Date).getTime() - 3_600_000))).toEqual([]);
});

test('filters, loads by id and aggregates read the past too', async () => {
  await run((env) =>
    env.asOf(t['created'] as Date, async (past) => {
      const moves = past.model('account.move');
      expect((await moves.search({ where: { state: 'draft' } })).mapped('name').sort()).toEqual([
        'A',
        'B',
      ]);
      expect(String((await moves.browse([ids['A'] as number]).load()).first().amount)).toBe('100');
      const [totals] = await moves.aggregate({
        measures: { n: 'count', total: { sum: 'amount' } },
      });
      expect([totals?.n, String(totals?.total)]).toEqual([2, '150']);
    }),
  );
});

test('one archived version per transaction; the past is read-only', async () => {
  const [row] = await driver.query<{ n: number }>(
    compile(
      sql`SELECT count(*)::int AS n FROM account_move_history WHERE id = ${ids['A'] as number}`,
    ),
  );
  expect(row?.n).toBe(3); // 100 (created), 120 (posted), 140 (corrected; 130 was never visible), archived by the raw 999
  await expect(
    run((env) =>
      env.asOf(t['created'] as Date, (past) =>
        past
          .model('account.move')
          .browse([ids['A'] as number])
          .write({ amount: '1' }),
      ),
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});
