/**
 * Sequences administered at runtime on PostgreSQL (Kosh request #31): an administrator reads each sequence with
 * its next number, changes a company's format — the other company keeps the code's —, changes when it restarts,
 * sets the next number forward and never below one already issued; changes are validated, audited, undone with
 * their transaction, and only an administrator's.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  AccessError,
  createShutro,
  createTableStatements,
  type Env,
  InvalidSequenceError,
  type Shutro,
  toDecimal,
  ValidationError,
} from '../../src/index.js';
import { registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;

const run = <T>(company: number, fn: (env: Env<S>) => Promise<T>): Promise<T> =>
  shutro.run({ user: 1, company, companies: [1, 2] }, fn);
/** As the system: what an administrator's screen does. */
const admin = <T>(company: number, fn: (env: Env<S>) => Promise<T>): Promise<T> =>
  run(company, (env) => env.asSuperuser({ reason: 'numbering' }, (su) => fn(su as Env<S>)));
const order = (company: number): Promise<string> =>
  run(company, async (env) => {
    const made = await env.model('sale.order').create([{ note: 'x' }]);
    return made.mapped('name')[0] as string;
  });

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

test('an administrator reads every sequence with what its next document would carry', async () => {
  // Before anything was numbered: the tables are made on first use, the counters start where the code says.
  const described = await admin(1, (env) => env.sequenceAdmin.describe({ date: '2026-03-15' }));
  expect(described.map((d) => [d.code, d.period, d.next, d.preview, d.format])).toEqual([
    ['account.move', '2026-03', 1, 'INV/2026/03/0001', null],
    ['sale.order', '', 1, 'SO/00001', null],
  ]);
  expect(await order(1)).toBe('SO/00001');
  expect(await order(1)).toBe('SO/00002');
  const [sale] = await admin(1, (env) => env.sequenceAdmin.describe({ codes: ['sale.order'] }));
  expect([sale?.next, sale?.preview]).toEqual([3, 'SO/00003']);
  // Each company counts for itself.
  const [other] = await admin(2, (env) => env.sequenceAdmin.describe({ codes: ['sale.order'] }));
  expect(other?.next).toBe(1);
});

test('a format changed for one company: its numbers change at once, the other company keeps the code’s', async () => {
  const changed = await admin(1, (env) =>
    env.sequenceAdmin.setFormat('sale.order', { prefix: 'ORD-{yy}-', padding: 3, suffix: '/BD' }),
  );
  expect(changed.format).toEqual({
    prefix: 'ORD-{yy}-',
    suffix: '/BD',
    padding: 3,
    reset: undefined,
  });
  const yy = new Date().toISOString().slice(2, 4);
  expect(changed.preview).toBe(`ORD-${yy}-003/BD`);
  // The counter goes on: only what the number looks like changed.
  expect(await order(1)).toBe(`ORD-${yy}-003/BD`);
  expect(await order(2)).toBe('SO/00001');
  // A preview says what a change would give, and changes nothing.
  const previewed = await admin(1, (env) =>
    env.sequenceAdmin.preview('sale.order', { prefix: 'X-', padding: 2 }, { next: 50 }),
  );
  expect([previewed.next, previewed.preview]).toEqual([50, 'X-50']);
  // Below what the counter would issue, the preview shows the counter's own next.
  expect(
    (await admin(1, (env) => env.sequenceAdmin.preview('sale.order', null, { next: 1 }))).preview,
  ).toBe('SO/00004');
  await expect(
    admin(1, (env) => env.sequenceAdmin.preview('sale.order', { prefix: '{week}' })),
  ).rejects.toBeInstanceOf(InvalidSequenceError);
  expect(
    (await admin(1, (env) => env.sequenceAdmin.describe({ codes: ['sale.order'] })))[0]?.format,
  ).toMatchObject({ prefix: 'ORD-{yy}-' });
  // A part left out keeps the code's.
  const partly = await admin(1, (env) => env.sequenceAdmin.setFormat('sale.order', { padding: 6 }));
  expect(partly.effective).toMatchObject({ prefix: 'SO/', suffix: '', padding: 6, reset: 'never' });
  expect(await order(1)).toBe('SO/000004');
  // Back to the code's.
  const back = await admin(1, (env) => env.sequenceAdmin.setFormat('sale.order', null));
  expect([back.format, back.preview]).toEqual([null, 'SO/00005']);
});

test('when it restarts can change: a new period counts from the start', async () => {
  const yearly = await admin(2, (env) =>
    env.sequenceAdmin.setFormat('sale.order', { prefix: 'SO/{year}/', reset: 'yearly' }),
  );
  const year = new Date().toISOString().slice(0, 4);
  expect([yearly.period, yearly.next, yearly.preview]).toEqual([year, 1, `SO/${year}/00001`]);
  expect(await order(2)).toBe(`SO/${year}/00001`);
  expect(await order(2)).toBe(`SO/${year}/00002`);
  await admin(2, (env) => env.sequenceAdmin.setFormat('sale.order', null));
  // The counter that never restarts is where it was.
  expect(await order(2)).toBe('SO/00002');
});

test('the next number moves forward, and never below one already issued', async () => {
  const moved = await admin(1, (env) => env.sequenceAdmin.setNext('sale.order', 100));
  expect([moved.next, moved.preview]).toEqual([100, 'SO/00100']);
  expect(await order(1)).toBe('SO/00100');
  // 100 was issued: the next is 101, and nothing below it can be asked for.
  for (const lower of [100, 5, 0]) {
    const refused = await admin(1, (env) => env.sequenceAdmin.setNext('sale.order', lower)).catch(
      (e: unknown) => e,
    );
    expect(refused, String(lower)).toBeInstanceOf(ValidationError);
    expect(String((refused as Error).message)).toContain('already issued numbers up to 100');
  }
  // The same number is allowed: nothing changes.
  expect((await admin(1, (env) => env.sequenceAdmin.setNext('sale.order', 101))).next).toBe(101);
  expect(await order(1)).toBe('SO/00101');
  // A period that restarts: its own counter, by the date given.
  const march = await admin(1, (env) =>
    env.sequenceAdmin.setNext('account.move', 50, { date: '2026-03-10' }),
  );
  expect([march.period, march.preview]).toEqual(['2026-03', 'INV/2026/03/0050']);
  const posted = await run(1, async (env) => {
    const moves = await env
      .model('account.move')
      .create([{ date: '2026-03-15' }, { date: '2026-04-02' }]);
    await moves.post();
    return moves.mapped('name');
  });
  expect(posted).toEqual(['INV/2026/03/0050', 'INV/2026/04/0001']);
  // Not a number, not a date.
  for (const bad of [-1, 1.5, Number.NaN])
    await expect(
      admin(1, (env) => env.sequenceAdmin.setNext('sale.order', bad)),
    ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    admin(1, (env) => env.sequenceAdmin.setNext('sale.order', 500, { date: 'tomorrow' })),
  ).rejects.toBeInstanceOf(ValidationError);
});

test('a format is validated like a definition; an unknown sequence is said', async () => {
  for (const format of [
    { prefix: 'SO/{week}/' },
    { padding: 40 },
    { reset: 'weekly' as never },
    { prefix: 'x'.repeat(100) },
  ])
    await expect(
      admin(1, (env) => env.sequenceAdmin.setFormat('sale.order', format)),
      JSON.stringify(format),
    ).rejects.toBeInstanceOf(InvalidSequenceError);
  await expect(
    admin(1, (env) => env.sequenceAdmin.setFormat('no.such', { padding: 3 })),
  ).rejects.toThrow(/no\.such/);
  // Nothing of the refused formats was kept.
  expect(
    (await admin(1, (env) => env.sequenceAdmin.describe({ codes: ['sale.order'] })))[0]?.format,
  ).toBeNull();
});

test('only administrators; a change is undone with its transaction, and audited when it commits', async () => {
  for (const act of [
    (env: Env<S>) => env.sequenceAdmin.describe(),
    (env: Env<S>) => env.sequenceAdmin.setFormat('sale.order', { padding: 2 }),
    (env: Env<S>) => env.sequenceAdmin.setNext('sale.order', 9999),
  ])
    await expect(run(1, (env) => act(env) as Promise<unknown>)).rejects.toBeInstanceOf(AccessError);
  // Rolled back with the transaction that made it.
  await admin(1, async (env) => {
    await env.sequenceAdmin.setFormat('sale.order', { prefix: 'GONE/' });
    await env.sequenceAdmin.setNext('sale.order', 7000);
    throw new Error('abort');
  }).catch(() => undefined);
  const [after] = await admin(1, (env) => env.sequenceAdmin.describe({ codes: ['sale.order'] }));
  expect([after?.format, after?.next]).toEqual([null, 102]);
  // Audited: what was changed, for which company.
  await admin(1, (env) => env.sequenceAdmin.setFormat('sale.order', { padding: 7 }));
  await admin(1, (env) => env.sequenceAdmin.setNext('sale.order', 200));
  const rows = await driver.query<{ action: string; new: Record<string, unknown> }>(
    compile(
      sql`SELECT action, new FROM shutro_audit WHERE action = ${'sequence'} ORDER BY id DESC LIMIT 2`,
    ),
  );
  expect(rows.map((r) => r.new)).toEqual([
    { kind: 'next', code: 'sale.order', company: 1, period: '', from: 102, to: 200 },
    { kind: 'format', code: 'sale.order', company: 1, format: { padding: 7 } },
  ]);
  expect(await order(1)).toBe('SO/0000200');
});
