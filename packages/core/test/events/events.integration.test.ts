/**
 * Transactional events and jobs (RFC 0018 §7.2–§7.3): only committed work is delivered; a handler's database work and
 * its acknowledgement commit together; retries, dead letters, deduplication, competing workers, NOTIFY wake-up.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildRegistry,
  createShutro,
  createTableStatements,
  defineModel,
  defineModule,
  eventTableStatements,
  f,
  type Shutro,
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
const Note = defineModel('x.note', { fields: { body: f.char({ required: true }) } });
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Note] })],
  security: { enforce: false },
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 8, parseNumeric: toDecimal });
  for (const statement of [...createTableStatements(registry), ...eventTableStatements()])
    await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'alice'}), (${'bob'})`));
  shutro = createShutro({ driver, registry });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

const notes = async (): Promise<string[]> =>
  (await driver.query<{ body: string }>(compile(sql`SELECT body FROM x_note ORDER BY id`))).map(
    (r) => r.body,
  );
const as = <T>(
  user: number,
  fn: Parameters<Shutro<S>['run']>[1] & ((...a: never[]) => Promise<T>),
) => shutro.run({ user, company: 1 }, fn as never) as Promise<T>;

describe('events', () => {
  test('only committed events are delivered; the handler runs as the emitter, its work and the cursor commit together', async () => {
    await as(1, (env) => env.emit('invoice.posted', { number: 'INV/1' }));
    await expect(
      as(1, async (env) => {
        await env.emit('invoice.posted', { number: 'INV/ROLLED-BACK' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await as(2, (env) => env.emit('invoice.posted', { number: 'INV/2' }));
    const seen: string[] = [];
    const sub = shutro.subscribe('mailer', 'invoice.posted', async (event, env) => {
      seen.push(`${(event.payload as { number: string }).number} by ${env.uid}`);
      await env
        .model('x.note')
        .create([{ body: `mail ${(event.payload as { number: string }).number}` }]);
    });
    expect(await sub.drain()).toBe(2);
    expect(seen).toEqual(['INV/1 by 1', 'INV/2 by 2']);
    expect(await notes()).toEqual(['mail INV/1', 'mail INV/2']);
    expect(await sub.drain()).toBe(0); // nothing redelivered
  });

  test('a failing handler is retried, its work rolled back; then the event goes to the dead letters', async () => {
    await as(1, (env) => env.emit('stock.moved', { qty: 1 }));
    let calls = 0;
    const sub = shutro.subscribe(
      'flaky',
      'stock.moved',
      async (_event, env) => {
        calls++;
        await env.model('x.note').create([{ body: `half-done ${calls}` }]);
        throw new Error('downstream down');
      },
      { attempts: 2 },
    );
    expect(await sub.drain()).toBe(0); // failed: retry scheduled, not due yet
    expect(await notes()).not.toContain('half-done 1');
    await driver.query(
      compile(sql`UPDATE shutro_subscription SET retry_at = now() WHERE name = ${'flaky'}`),
    );
    expect(await sub.drain()).toBe(1); // second failure: dead, cursor moves on
    expect(calls).toBe(2);
    const [dead] = await driver.query<{ error: string }>(
      compile(sql`SELECT error FROM shutro_dead_event WHERE subscription = ${'flaky'}`),
    );
    expect(dead?.error).toBe('downstream down');
    expect(await sub.drain()).toBe(0);
  });
});

describe('jobs', () => {
  test('enqueued transactionally, deduplicated by key, run as the enqueuer, retried then dead', async () => {
    const first = await as(2, (env) =>
      env.enqueue('report.build', { month: '2026-09' }, { key: 'report:2026-09' }),
    );
    const again = await as(2, (env) =>
      env.enqueue('report.build', { month: '2026-09' }, { key: 'report:2026-09' }),
    );
    expect(typeof first).toBe('number');
    expect(again).toBeNull();
    await as(1, (env) => env.enqueue('report.fail', {}, { attempts: 2 }));
    const runs: string[] = [];
    const worker = shutro.work({
      'report.build': async (payload, env, job) => {
        runs.push(`${(payload as { month: string }).month} by ${env.uid} attempt ${job.attempt}`);
        await env.model('x.note').create([{ body: 'report done' }]);
      },
      'report.fail': async () => {
        throw new Error('no data');
      },
    });
    expect(await worker.drain()).toBe(2);
    expect(runs).toEqual(['2026-09 by 2 attempt 1']);
    await driver.query(compile(sql`UPDATE shutro_job SET run_at = now() WHERE state = 'pending'`));
    expect(await worker.drain()).toBe(1);
    const states = await driver.query<{
      name: string;
      state: string;
      attempts: number;
      last_error: string | null;
    }>(compile(sql`SELECT name, state, attempts, last_error FROM shutro_job ORDER BY id`));
    expect(states.map((s) => [s.name, s.state, s.attempts, s.last_error])).toEqual([
      ['report.build', 'done', 1, null],
      ['report.fail', 'dead', 2, 'no data'],
    ]);
    // Done: the key is free again.
    expect(
      await as(2, (env) => env.enqueue('report.build', {}, { key: 'report:2026-09' })),
    ).not.toBeNull();
    await driver.query(compile(sql`DELETE FROM shutro_job`));
  });

  test('competing workers never run a job twice', async () => {
    await as(1, async (env) => {
      for (let i = 0; i < 40; i++) await env.enqueue('count.one', { i });
    });
    const handled: number[] = [];
    const handlers = {
      'count.one': async (payload: unknown) => {
        handled.push((payload as { i: number }).i);
      },
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => shutro.work(handlers).drain()));
    expect(results.reduce((a, b) => a + b, 0)).toBe(40);
    expect([...handled].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  test('a started worker wakes on NOTIFY', async () => {
    const done: number[] = [];
    const worker = shutro.work(
      { 'ping.now': async (p) => void done.push((p as { n: number }).n) },
      { pollMs: 60_000 },
    );
    worker.start();
    await new Promise((r) => setTimeout(r, 200)); // listening
    await as(1, (env) => env.enqueue('ping.now', { n: 7 }));
    for (let i = 0; i < 50 && done.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    expect(done).toEqual([7]);
  });
});
