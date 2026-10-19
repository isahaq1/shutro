/**
 * Installed set at runtime (RFC 0019 §7.5, §7.8): `env.apps`, `AppNotInstalledError` for available-but-not-installed
 * models, and `useRegistry()` swapping the registry without touching running transactions.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  AppNotInstalledError,
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
  application: true,
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

test('a model of an available but uninstalled app names the app and the fix', async () => {
  const shutro = createShutro({ driver, registry: withoutPurchase, catalog: [b, purchase] });
  await shutro.run(identity, async (env) => {
    expect(env.apps.has('purchase')).toBe(false);
    expect(env.apps.installed).toEqual(['base']);
    const error = (() => {
      try {
        env.model('purchase.order' as never);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(AppNotInstalledError);
    expect((error as AppNotInstalledError).module).toBe('purchase');
    expect((error as Error).message).toContain('shutro apps install purchase');
  });
});

test('a model no module ships is still an unknown model', async () => {
  const shutro = createShutro({ driver, registry: withoutPurchase, catalog: [b, purchase] });
  await shutro.run(identity, async (env) => {
    expect(() => env.model('stock.picking' as never)).toThrow(UnknownModelError);
  });
});

test('useRegistry swaps for new scopes; a running scope keeps its registry', async () => {
  const shutro = createShutro({ driver, registry: withoutPurchase, catalog: [b, purchase] });
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
    return env.apps.has('purchase');
  });
  await running;
  shutro.useRegistry(withPurchase);
  expect(shutro.registry).toBe(withPurchase);
  const after = await shutro.run(identity, async (env) => {
    const found = await env.model('purchase.order' as never).search({});
    return { has: env.apps.has('purchase'), count: found.length };
  });
  release();
  expect(await before).toBe(false);
  expect(after).toEqual({ has: true, count: 0 });
});
