/**
 * `useRegistry()` swaps the registry for new scopes without touching running transactions.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildRegistry,
  createShutro,
  createTableStatements,
  defineModel,
  defineModule,
  f,
  toDecimal,
  UnknownModelError,
} from '../../src/index.js';
import { base } from './fixtures.js';

const b = base();
const purchase = defineModule({
  name: 'purchase',
  depends: [b],
  models: [
    defineModel('purchase.order', {
      fields: { name: f.char({ required: true }), partner: f.many2one('res.partner') },
    }),
  ],
});

const withoutPurchase = buildRegistry({ modules: [b], security: { enforce: false } });
const withPurchase = buildRegistry({ modules: [b, purchase], security: { enforce: false } });

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(withPurchase)) await driver.query(statement);
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

const identity = { user: 1, company: 1 } as const;

/** False when `fn` throws {@link UnknownModelError}. */
function knows(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (error) {
    if (error instanceof UnknownModelError) return false;
    throw error;
  }
}

test('useRegistry swaps for new scopes; a running scope keeps its registry', async () => {
  const shutro = createShutro({ driver, registry: withoutPurchase });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const before = shutro.run(identity, async (env) => {
    started();
    await gate;
    // This scope started on the registry without purchase: the model stays unknown here.
    return knows(() => env.model('purchase.order' as never));
  });
  await running;
  shutro.useRegistry(withPurchase);
  expect(shutro.registry).toBe(withPurchase);
  const after = await shutro.run(identity, async (env) => {
    const found = await env.model('purchase.order' as never).search({});
    return { has: knows(() => env.model('purchase.order' as never)), count: found.length };
  });
  release();
  expect(await before).toBe(false);
  expect(after).toEqual({ has: true, count: 0 });
});
