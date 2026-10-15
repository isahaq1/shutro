/**
 * Sequences on PostgreSQL (RFC 0012 §7.2–7.4): numbers at create in one allocation per batch, per company, manual
 * numbering on a transition with monthly resets, gapless serialization and reuse after rollback, standard gaps.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createShutro,
  createTableStatements,
  type Env,
  type Shutro,
  toDecimal,
  UNNUMBERED,
  ValidationError,
} from '../../src/index.js';
import { registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;

async function run<T>(company: number, fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return shutro.run({ user: 1, company, companies: [1, 2] }, fn);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 6, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(
      sql`INSERT INTO res_company (name, currency_id) VALUES (${'BD'}, ${bdt?.id ?? 0}), (${'SG'}, ${bdt?.id ?? 0})`,
    ),
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('create-time numbering', () => {
  test('a batch gets consecutive numbers from one allocation; companies count separately', async () => {
    await run(1, async (env) => {
      const before = env.stats().queries;
      const orders = await env
        .model('sale.order')
        .create([{ note: 'a' }, { note: 'b' }, { note: 'c' }]);
      expect(env.stats().queries - before).toBeLessThanOrEqual(3); // allocation (autonomous, not counted) + insert + ...
      expect(orders.mapped('name')).toEqual(['SO/00001', 'SO/00002', 'SO/00003']);
      const sg = await env
        .withCompany(2)
        .model('sale.order')
        .create([{ note: 'sg' }]);
      expect(sg.mapped('name')).toEqual(['SO/00001']);
      const more = await env.model('sale.order').create([{ note: 'd' }]);
      expect(more.mapped('name')).toEqual(['SO/00004']);
    });
  });

  test('a standard sequence does not block and leaves a gap when the transaction rolls back', async () => {
    await run(1, async (env) => {
      await env.model('sale.order').create([{ note: 'rolled back' }]);
      throw new Error('abort');
    }).catch(() => undefined);
    await run(1, async (env) => {
      const next = await env.model('sale.order').create([{ note: 'after gap' }]);
      expect(next.mapped('name')).toEqual(['SO/00006']); // 00005 was consumed by the aborted transaction
    });
  });
});

describe('manual, gapless numbering', () => {
  test('a draft keeps the placeholder; posting assigns a number per month; numbering twice is refused', async () => {
    await run(1, async (env) => {
      const moves = await env
        .model('account.move')
        .create([{ date: '2026-03-15' }, { date: '2026-03-20' }, { date: '2026-04-02' }]);
      expect(moves.mapped('name')).toEqual([UNNUMBERED, UNNUMBERED, UNNUMBERED]);
      await moves.post();
      expect(moves.mapped('name')).toEqual([
        'INV/2026/03/0001',
        'INV/2026/03/0002',
        'INV/2026/04/0001',
      ]);
      await expect(moves.assignNumber('name')).rejects.toBeInstanceOf(ValidationError);
      await env.flush();
    });
    const rows = await driver.query<{ name: string }>(
      compile(sql`SELECT name FROM account_move ORDER BY id`),
    );
    expect(rows.map((r) => r.name)).toEqual([
      'INV/2026/03/0001',
      'INV/2026/03/0002',
      'INV/2026/04/0001',
    ]);
  });

  test('gapless: a concurrent transaction waits, and a rollback hands its number to the next one', async () => {
    const allocated = deferred();
    const release = deferred();
    const events: string[] = [];
    const first = run(1, async (env) => {
      const move = (await env.model('account.move').create([{ date: '2026-05-01' }])).first();
      await move.assignNumber('name');
      events.push(`first:${move.name}`);
      allocated.resolve();
      await release.promise;
      throw new Error('abort'); // the number goes back
    }).catch(() => undefined);
    await allocated.promise;
    const second = run(1, async (env) => {
      const move = (await env.model('account.move').create([{ date: '2026-05-03' }])).first();
      events.push('second:waiting');
      await move.assignNumber('name'); // blocks on the counter row until the first transaction ends
      events.push(`second:${move.name}`);
      await env.flush();
    });
    await sleep(300);
    expect(events).toEqual(['first:INV/2026/05/0001', 'second:waiting']); // still blocked
    release.resolve();
    await first;
    await second;
    expect(events).toEqual(['first:INV/2026/05/0001', 'second:waiting', 'second:INV/2026/05/0001']);
  });
});
