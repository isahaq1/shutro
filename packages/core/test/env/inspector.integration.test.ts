/**
 * The dev-mode query inspector: every statement with timings, N+1 warnings for per-record loads, none for batched
 * loads, and a slow-statement warning.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  buildRegistry,
  createInspector,
  createShutro,
  createTableStatements,
  defineModel,
  defineModule,
  f,
  type InspectorWarning,
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
const Partner = defineModel('res.partner', { fields: { name: f.char({ required: true }) } });
const Order = defineModel('sale.order', {
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
  },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'base', models: [Users, Currency, Company, Partner, Order] })],
  security: { enforce: false },
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
  const partners = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name) SELECT 'P' || g FROM generate_series(1, 12) g RETURNING id`,
    ),
  );
  for (const p of partners)
    await driver.query(
      compile(sql`INSERT INTO sale_order (name, partner_id) VALUES (${`SO${p.id}`}, ${p.id})`),
    );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('query inspector', () => {
  test('records statements; per-record loads raise an N+1 warning, batched loads do not', async () => {
    const warnings: InspectorWarning[] = [];
    const inspector = createInspector({ n1Threshold: 5, onWarning: (w) => warnings.push(w) });
    const shutro = createShutro({ driver, registry, inspector });
    await shutro.run({ user: 1, company: 1 }, async (env) => {
      const orders = await env.model('sale.order').search();
      await orders.load({ partner: true }); // one query for every partner
    });
    expect(warnings).toEqual([]);
    expect(inspector.queries.length).toBeGreaterThanOrEqual(2);
    expect(inspector.queries.every((q) => q.ms >= 0 && q.tx.length > 0 && q.uid === 1)).toBe(true);

    await shutro.run({ user: 1, company: 1 }, async (env) => {
      const orders = await env.model('sale.order').search();
      for (const id of orders.ids)
        await env.model('sale.order').browse([id]).load({ partner: true }); // the anti-pattern
    });
    const n1 = warnings.filter((w) => w.kind === 'n+1');
    expect(n1.length).toBeGreaterThan(0);
    expect(n1[0]?.message).toContain('Possible N+1');
    expect(inspector.summary()[0]?.count).toBeGreaterThanOrEqual(5);
    expect(inspector.report()).toMatch(/statement\(s\), \d+ warning\(s\)/);
  });

  test('slow statements and failed statements are recorded', async () => {
    const warnings: InspectorWarning[] = [];
    const inspector = createInspector({ slowMs: 20, onWarning: (w) => warnings.push(w) });
    const shutro = createShutro({ driver, registry, inspector });
    await shutro.run({ user: 1, company: 1 }, async (env) => {
      await env.sql`SELECT pg_sleep(0.05)`;
    });
    expect(warnings.map((w) => w.kind)).toContain('slow');
    await shutro
      .run(
        { user: 1, company: 1, retry: false } as never,
        async (env) => env.sql`SELECT * FROM no_such_table`,
      )
      .catch(() => undefined);
    expect(inspector.queries.at(-1)?.error).toContain('no_such_table');
    inspector.clear();
    expect(inspector.queries).toEqual([]);
  });
});
