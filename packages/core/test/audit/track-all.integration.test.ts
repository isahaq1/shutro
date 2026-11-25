/**
 * Tracking by default (`buildRegistry({ tracking: { default: 'all' } })`, RFC 0013): every model records its
 * creations, changes and deletions — also the ones that name no tracked field, which otherwise record nothing —,
 * every stored field that is set is tracked, computed values and x2many relations are not, and `except` leaves
 * out a model or a field. What a model tracks explicitly stays tracked.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildRegistry,
  createShutro,
  createTableStatements,
  readTrail,
  type Shutro,
  toDecimal,
} from '../../src/index.js';
import { registry as plain, sale } from './fixtures.js';

const all = buildRegistry({
  modules: [sale],
  security: { enforce: false },
  tracking: {
    default: 'all',
    // A queue-like model whole, and one bulky field.
    except: (model, field) =>
      model === 'res.currency' || (model === 'sale.order' && field?.key === 'untracked'),
  },
});
type S = typeof all extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(all)) await driver.query(statement);
  shutro = createShutro({ driver, registry: all });
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  await driver.query(
    compile(
      sql`INSERT INTO res_currency (name, rounding, decimal_places) VALUES (${'BDT'}, ${'0.01'}, ${2})`,
    ),
  );
  await driver.query(compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, 1)`));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

const tracked = (registry: typeof all | typeof plain, model: string): string[] =>
  [...(registry as typeof all).get(model).model.tracking].sort();

test('what is tracked: every stored field that is set; not computed values, x2many, or what is left out', () => {
  // Without the option: only what the models name (a partner names nothing).
  expect(tracked(plain, 'res.partner')).toEqual([]);
  expect(tracked(plain, 'sale.order.line')).toEqual([]);
  expect(tracked(plain, 'sale.order')).toEqual(['note', 'partner']);
  // With it.
  expect(tracked(all, 'res.partner')).toEqual(['name']);
  // `subtotal` follows from `priceUnit`: computed, not tracked by default.
  expect(tracked(all, 'sale.order.line')).toEqual(['currency', 'name', 'order', 'priceUnit']);
  // `lines` is a one2many, `untracked` is left out, `amountTotal` is tracked by the field itself.
  expect(tracked(all, 'sale.order')).toEqual(['currency', 'name', 'note', 'partner', 'state']);
  expect(all.get('sale.order').model.fields['amountTotal']?.tracking).toBe(true);
  // A model left out whole keeps recording nothing.
  expect(tracked(all, 'res.currency')).toEqual([]);
});

test('a model that named nothing now records its creation, each change with old and new, and its deletion', async () => {
  const id = await shutro.run({ user: 1, company: 1 }, async (env) => {
    const partner = (await env.model('res.partner').create([{ name: 'Acme' }])).first();
    await env.flush();
    await partner.write({ name: 'Acme Ltd' });
    await env.flush();
    return partner.id;
  });
  await shutro.run({ user: 1, company: 1 }, async (env) => {
    await env.model('res.partner').browse([id]).unlink();
  });
  const rows = await readTrail(driver, { model: 'res.partner', recordIds: [id] });
  expect(rows.map((r) => [r.action, r.field, r.old, r.new])).toEqual([
    ['unlink', null, { name: 'Acme Ltd' }, null],
    ['write', 'name', 'Acme', 'Acme Ltd'],
    ['create', null, null, { name: 'Acme' }],
  ]);
  expect(rows.every((r) => r.uid === 1)).toBe(true);
});

test('lines record their own changes; what is left out and what is computed leave no row', async () => {
  const { order, line } = await shutro.run({ user: 1, company: 1 }, async (env) => {
    const partner = (await env.model('res.partner').create([{ name: 'Globex' }])).first();
    const so = (
      await env.model('sale.order').create([
        {
          name: 'A1',
          partner: partner.id,
          currency: 1 as never,
          lines: { create: [{ name: 'l', currency: 1 as never, priceUnit: '10' }] },
        },
      ])
    ).first();
    await env.flush();
    return { order: so.id, line: (await so.lines.load()).first().id };
  });
  // Another day, another transaction: the changes are rows of their own.
  await shutro.run({ user: 1, company: 1 }, async (env) => {
    await env.model('sale.order.line').browse([line]).write({ priceUnit: '25' });
    await env.model('sale.order').browse([order]).write({ untracked: 'bulky', name: 'A2' });
  });
  const ofLine = await readTrail(driver, { model: 'sale.order.line', recordIds: [line] });
  const change = ofLine.find((r) => r.action === 'write');
  expect([change?.field, Number(change?.old), Number(change?.new)]).toEqual(['priceUnit', 10, 25]);
  expect(ofLine.filter((r) => r.action === 'write')).toHaveLength(1);
  expect(ofLine.at(-1)?.action).toBe('create');
  // The line's computed subtotal is not a row of its own.
  expect(ofLine.some((r) => r.field === 'subtotal')).toBe(false);
  const ofOrder = await readTrail(driver, { model: 'sale.order', recordIds: [order] });
  expect(
    ofOrder
      .filter((r) => r.action === 'write')
      .map((r) => r.field)
      .sort(),
  ).toEqual([
    'amountTotal', // tracked by the field itself
    'name',
  ]);
  expect(ofOrder.some((r) => r.field === 'untracked')).toBe(false);
});
