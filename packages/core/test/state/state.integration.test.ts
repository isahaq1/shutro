/**
 * State machines on PostgreSQL (RFC 0010 §7.2–7.4): batch transitions, all-or-nothing validation, guards, events,
 * overrides from another module, added transitions, availability, and the state as a trigger.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  ConstraintError,
  createShutro,
  createTableStatements,
  type Env,
  type Id,
  InvalidTransitionError,
  type Shutro,
  TransitionGuardError,
  toDecimal,
  ValidationError,
} from '../../src/index.js';
import { log, registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const identity = { user: 1, company: 1, companies: [1] } as const;
let acme: Id<'res.partner'>;

async function run<T>(fn: (env: Env<S>) => Promise<T>): Promise<T> {
  return shutro.run(identity, fn);
}

async function stateOf(id: number): Promise<string> {
  const [row] = await driver.query<{ state: string }>(
    compile(sql`SELECT state FROM sale_order WHERE id = ${id}`),
  );
  return row?.state ?? '?';
}

function order(name: string, lines = 1) {
  return {
    name,
    partner: acme,
    lines: { create: Array.from({ length: lines }, (_, i) => ({ name: `${name}-${i}` })) },
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const [bdt] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
  const [p] = await driver.query<{ id: number }>(
    compile(sql`INSERT INTO res_partner (name) VALUES (${'Acme'}) RETURNING id`),
  );
  acme = (p?.id ?? 0) as Id<'res.partner'>;
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

beforeEach(() => {
  log.length = 0;
});

describe('transitions', () => {
  test('a batch transition: guard, events once per batch, state persisted, override applied', async () => {
    const ids = await run(async (env) => {
      const orders = await env.model('sale.order').create([order('A'), order('B')]);
      await env.flush();
      log.length = 0;
      await orders.confirm();
      expect(orders.map((o) => o.state)).toEqual(['sale', 'sale']);
      expect(log).toEqual([
        'guard confirm 2',
        'exit draft 2',
        'before confirm 2',
        'after confirm 2',
        'enter sale 2',
      ]);
      expect(orders.first().note).toBe('confirmed by sale_hold'); // the sale_hold override wrapped next()
      return orders.ids;
    });
    for (const id of ids) expect(await stateOf(id)).toBe('sale');
  });

  test('a record in the wrong state fails the whole batch before anything changes', async () => {
    await run(async (env) => {
      const orders = await env.model('sale.order').create([order('C'), order('D')]);
      await env.flush();
      await orders.first().send();
      const [c, d] = [...orders];
      if (c === undefined || d === undefined) throw new Error('two');
      await c.confirm(); // sent → sale
      const error = await orders.confirm().catch((e: unknown) => e); // c is already sale
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const e = error as InvalidTransitionError;
      expect(e.transition).toBe('confirm');
      expect(e.records).toEqual([{ id: c.id, state: 'sale' }]);
      expect(e.from).toEqual(['draft', 'sent']);
      expect(d.state).toBe('draft'); // untouched
      expect(log.filter((l) => l.startsWith('guard'))).toHaveLength(1); // the guard never ran for the failed batch
    });
  });

  test('a failing guard carries the message and changes nothing', async () => {
    await run(async (env) => {
      const orders = await env.model('sale.order').create([order('E', 0), order('F', 2)]);
      await env.flush();
      const error = await orders.confirm().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransitionGuardError);
      const e = error as TransitionGuardError;
      expect(e.records).toEqual([orders.ids[0]]);
      expect(e.message).toContain('Add at least one line before confirming.');
      expect(orders.map((o) => o.state)).toEqual(['draft', 'draft']);
      expect(log.some((l) => l.startsWith('before'))).toBe(false);
    });
  });

  test('transitions added by another module work; availability follows the state', async () => {
    const id = await run(async (env) => {
      const so = (await env.model('sale.order').create([order('G')])).first();
      expect(so.transitions()).toEqual(['send', 'confirm', 'cancel']);
      await so.confirm();
      expect(so.transitions()).toEqual(['cancel', 'hold']);
      // Transitions added by an extension are typed through the generated bindings (RFC 0002 §7.7); cast here.
      const held = so as unknown as { hold(): Promise<void>; resume(): Promise<void> };
      await held.hold();
      expect(so.state).toBe('hold');
      await held.resume();
      expect(so.state).toBe('sale');
      await expect(held.resume()).rejects.toBeInstanceOf(InvalidTransitionError);
      return so.id;
    });
    expect(await stateOf(id)).toBe('sale');
  });

  test('the state is unwritable, but a transition is a write: triggers reach constraints and searches', async () => {
    await run(async (env) => {
      const so = (await env.model('sale.order').create([order('H')])).first();
      await expect(so.write({ state: 'cancel' } as never)).rejects.toBeInstanceOf(ValidationError);
      await so.cancel();
      // The constraint depends on state: a cancelled order without a note fails at the flush point.
      await expect(env.flush()).rejects.toBeInstanceOf(ConstraintError);
    }).catch(() => undefined);
    await run(async (env) => {
      const so = (await env.model('sale.order').create([order('I')])).first();
      await so.write({ note: 'customer changed their mind' });
      await so.cancel();
      const cancelled = await env
        .model('sale.order')
        .search({ where: { state: 'cancel', name: 'I' } });
      expect(cancelled.ids).toEqual([so.id]);
    });
  });

  test('a declared method can call a transition on this', async () => {
    await run(async (env) => {
      const so = (await env.model('sale.order').create([order('J')])).first();
      await so.markSent();
      expect(so.state).toBe('sent');
    });
  });
});
