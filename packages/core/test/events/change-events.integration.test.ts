/**
 * Change events (RFC 0018 §7.5): a model with `changeEvents: true` emits one `record.changed` outbox event per model
 * and action at each flush, in the writing transaction — creates with the keys given, writes with the keys written
 * (recomputed stored fields included), unlinks with the ids; a rollback emits nothing; large writes are split into
 * events of at most 1 000 ids; models without the option emit nothing; an extension turns it on.
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
  eventTableStatements,
  extendModel,
  f,
  type Shutro,
  toDecimal,
} from '../../src/index.js';

interface OrderSet extends Iterable<{ qty: number; total: number }> {}

const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
const Order = defineModel('x.order', {
  changeEvents: true,
  fields: {
    name: f.char({ required: true }),
    qty: f.integer({ default: 0 }),
    note: f.char(),
    total: f.integer({
      store: true,
      depends: ['qty'],
      compute(records: unknown): void {
        for (const o of records as OrderSet) o.total = o.qty * 2;
      },
    }),
  },
});
const Plain = defineModel('x.plain', { fields: { name: f.char({ required: true }) } });
const Later = defineModel('x.later', { fields: { name: f.char({ required: true }) } });
const base = defineModule({ name: 'x', models: [Users, Order, Plain, Later] });
const watcher = defineModule({
  name: 'x_watch',
  depends: [base],
  models: [],
  extensions: [extendModel('x.later', { changeEvents: true })],
});
const registry = buildRegistry({ modules: [base, watcher], security: { enforce: false } });
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of [...createTableStatements(registry), ...eventTableStatements()])
    await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'alice'})`));
  shutro = createShutro({ driver, registry });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

interface Changed {
  readonly model: string;
  readonly action: string;
  readonly ids: number[];
  readonly keys?: string[];
}
async function changes(): Promise<Changed[]> {
  const rows = await driver.query<{ payload: Changed }>(
    compile(sql`SELECT payload FROM shutro_outbox WHERE topic = ${'record.changed'} ORDER BY id`),
  );
  await driver.query(compile(sql`DELETE FROM shutro_outbox`));
  return rows.map((r) => r.payload);
}
type Ref = {
  create(rows: unknown[]): Promise<{ ids: number[] }>;
  browse(ids: number[]): { write(v: unknown): Promise<void>; unlink(): Promise<void> };
};
const run = <T>(fn: (model: (name: string) => Ref) => Promise<T>) =>
  shutro.run({ user: 1, company: 1 }, (env) =>
    fn((name) => env.model(name as never) as unknown as Ref),
  );

test('create, write (with its recompute) and unlink emit one event each, with the keys', async () => {
  await changes();
  const ids = await run(
    async (model) => (await model('x.order').create([{ name: 'A', qty: 1 }, { name: 'B' }])).ids,
  );
  const created = await changes();
  expect(created[0]).toEqual({ model: 'x.order', action: 'create', ids, keys: ['name', 'qty'] });
  // The new records' stored computes are written at the flush: a write of `total`.
  expect(created.slice(1)).toEqual([{ model: 'x.order', action: 'write', ids, keys: ['total'] }]);

  await run((model) => model('x.order').browse(ids).write({ qty: 5 }));
  expect(await changes()).toEqual([
    { model: 'x.order', action: 'write', ids, keys: ['qty', 'total'] },
  ]);
  await run((model) =>
    model('x.order')
      .browse([ids[0] as number])
      .write({ note: 'n' }),
  );
  expect(await changes()).toEqual([
    { model: 'x.order', action: 'write', ids: [ids[0]], keys: ['note'] },
  ]);
  await run((model) => model('x.order').browse(ids).unlink());
  expect(await changes()).toEqual([{ model: 'x.order', action: 'unlink', ids }]);
});

test('a rolled-back transaction emits nothing; models without the option emit nothing', async () => {
  await changes();
  await expect(
    run(async (model) => {
      await model('x.order').create([{ name: 'gone' }]);
      throw new Error('rolled back');
    }),
  ).rejects.toThrow('rolled back');
  await run((model) => model('x.plain').create([{ name: 'quiet' }]));
  expect(await changes()).toEqual([]);
});

test('an extension turns it on; a large write is split into events of at most 1 000 ids', async () => {
  await changes();
  await run((model) =>
    model('x.later').create(Array.from({ length: 2500 }, (_, i) => ({ name: `L${i}` }))),
  );
  const events = await changes();
  expect(events.map((e) => [e.model, e.action, e.ids.length])).toEqual([
    ['x.later', 'create', 1000],
    ['x.later', 'create', 1000],
    ['x.later', 'create', 500],
  ]);
});

test('the event names the reason of the writing scope (subscribers guard against their own writes)', async () => {
  await changes();
  await shutro.run({ user: 1, company: 1, reason: 'automation:rule 7' }, (env) =>
    (env.model('x.order' as never) as unknown as Ref).create([{ name: 'R' }]),
  );
  const [created] = await changes();
  expect(created).toMatchObject({ action: 'create', reason: 'automation:rule 7' });
});
