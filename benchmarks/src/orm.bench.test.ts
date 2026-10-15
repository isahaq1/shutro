/**
 * ORM benchmarks on PostgreSQL (RFC 0015 §7.3). Each scenario reports wall time and asserts a query budget: the
 * budgets are the CI gate (deterministic), the timings are written to results.json for trend tracking.
 *
 *   pnpm bench                       # all scenarios
 *   BENCH_ORDERS=20000 pnpm bench    # a bigger run
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRegistry,
  type ComputeSet,
  createShutro,
  createTableStatements,
  type DefaultLoaded,
  defineGroup,
  defineModel,
  defineModule,
  type Env,
  f,
  type Id,
  type Merge,
  type Shutro,
  type ToLoaded,
  toDecimal,
} from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const ORDERS = Number(process.env['BENCH_ORDERS'] ?? 5_000);
const LINES = 3;

type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
type LineSet = ComputeSet<S, 'sale.order.line', DefaultLoaded<S, 'sale.order.line'>>;
type OrderSet = ComputeSet<
  S,
  'sale.order',
  Merge<DefaultLoaded<S, 'sale.order'>, ToLoaded<S, 'sale.order', { lines: ['subtotal'] }>>
>;

const all = ['read', 'write', 'create', 'unlink', 'import'] as const;
const Users = defineModel('res.users', {
  access: { 'base.user': all },
  fields: { login: f.char({ required: true }) },
});
const Currency = defineModel('res.currency', {
  access: { 'base.user': all },
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
const Company = defineModel('res.company', {
  access: { 'base.user': all },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
const Partner = defineModel('res.partner', {
  access: { 'base.user': all },
  fields: { name: f.char({ required: true }) },
});
const Line = defineModel('sale.order.line', {
  access: { 'base.user': all },
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0' }),
    subtotal: f.decimal({
      scale: 2,
      store: true,
      depends: ['quantity', 'priceUnit'],
      compute(records: unknown): void {
        for (const l of records as LineSet) l.subtotal = l.quantity.times(l.priceUnit);
      },
    }),
  },
});
const Order = defineModel('sale.order', {
  companyScoped: { required: true },
  access: { 'base.user': all },
  rules: {
    company: {
      groups: 'global',
      perms: ['read', 'write', 'unlink'],
      domain: { company: { in: { $env: 'companyIds' } } },
    },
  },
  tracking: ['partner'],
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    lines: f.one2many('sale.order.line', 'order'),
    total: f.decimal({
      scale: 2,
      store: true,
      depends: ['lines.subtotal'],
      compute(records: unknown): void {
        for (const o of records as OrderSet)
          o.total = [...o.lines].reduce(
            (acc, l) => acc.plus(l.subtotal ?? toDecimal(0)),
            toDecimal(0),
          );
      },
    }),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [defineGroup({ code: 'base.user' })],
      models: [Users, Currency, Company, Partner, Line, Order],
    }),
  ],
});

interface Result {
  readonly scenario: string;
  readonly records: number;
  readonly ms: number;
  readonly queries: number;
  readonly budget: number;
  readonly perSecond: number;
}

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
let partners: Id<'res.partner'>[];
const results: Result[] = [];

async function measure(
  scenario: string,
  records: number,
  budget: number,
  fn: (env: Env<S>) => Promise<void>,
): Promise<Result> {
  const result = await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, async (env) => {
    const q0 = env.stats().queries;
    const t0 = performance.now();
    await fn(env);
    await env.flush();
    const ms = performance.now() - t0;
    return {
      scenario,
      records,
      ms,
      queries: env.stats().queries - q0,
      budget,
      perSecond: Math.round((records / ms) * 1000),
    };
  });
  results.push(result);
  return result;
}

function orders(prefix: string): {
  name: string;
  partner: Id<'res.partner'>;
  lines: { create: { name: string; quantity: string; priceUnit: string }[] };
}[] {
  return Array.from({ length: ORDERS }, (_, i) => ({
    name: `${prefix}${i}`,
    partner: partners[i % partners.length] as Id<'res.partner'>,
    lines: {
      create: Array.from({ length: LINES }, (_, j) => ({
        name: `l${j}`,
        quantity: String(j + 1),
        priceUnit: '9.99',
      })),
    },
  }));
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
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
  const rows = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name) SELECT 'P' || g FROM generate_series(1, 100) g RETURNING id`,
    ),
  );
  partners = rows.map((r) => r.id as Id<'res.partner'>);
});

afterAll(async () => {
  const path = join(import.meta.dirname, '..', 'results.json');
  writeFileSync(
    path,
    `${JSON.stringify({ orders: ORDERS, lines: LINES, node: process.version, results }, null, 2)}\n`,
  );
  const table = results.map(
    (r) =>
      `${r.scenario.padEnd(20)} ${String(r.records).padStart(7)} records ${String(r.queries).padStart(5)} queries (budget ${r.budget}) ${String(Math.round(r.ms)).padStart(6)} ms`,
  );
  process.stdout.write(`${table.join('\n')}\n`);
  await driver?.end();
  await pg?.stop();
});

describe(`ORM benchmarks (${ORDERS} orders × ${LINES} lines)`, () => {
  test('create: orders with lines through INSERT … unnest, computes and audit at the flush', async () => {
    // Orders and their lines in one INSERT each per 1,000 rows (nested creates are batched across parents).
    const r = await measure(
      'create (unnest)',
      ORDERS * (LINES + 1),
      Math.ceil((ORDERS * (LINES + 1)) / 1000) + 20,
      async (env) => {
        await env.model('sale.order').create(orders('U'));
      },
    );
    expect(r.queries).toBeLessThanOrEqual(r.budget);
  });

  test('copy: the same lines through COPY', async () => {
    const ids = await shutro.run(
      { user: 1, company: 1, groups: ['base.user'] },
      async (env) =>
        (await env.model('sale.order').copy(orders('C').map(({ lines: _lines, ...o }) => o))).ids,
    );
    const lines = ids.flatMap((order) =>
      Array.from({ length: LINES }, (_, j) => ({
        order,
        name: `l${j}`,
        quantity: String(j + 1),
        priceUnit: '9.99',
      })),
    );
    const r = await measure('copy (lines)', lines.length, 30, async (env) => {
      await env.model('sale.order.line').copy(lines);
    });
    expect(r.queries).toBeLessThanOrEqual(r.budget);
  });

  test('search + nested load with record rules: a fixed number of queries whatever the size', async () => {
    const r = await measure('search + load', ORDERS * (LINES + 1), 12, async (env) => {
      const found = await env.model('sale.order').search({ where: { name: { like: 'U%' } } });
      const loaded = await found.load({ partner: ['name'], lines: ['subtotal'] });
      let sum = toDecimal(0);
      for (const o of loaded) for (const l of o.lines) sum = sum.plus(l.subtotal ?? toDecimal(0));
      expect(sum.gt(0)).toBe(true);
    });
    expect(r.queries).toBeLessThanOrEqual(r.budget);
  });

  test('bulk write + batched recompute of two computed levels', async () => {
    const r = await measure('write + recompute', ORDERS * LINES, 40, async (env) => {
      const found = await env.model('sale.order').search({ where: { name: { like: 'U%' } } });
      const lines = await env
        .model('sale.order.line')
        .browse([...(await found.load({ lines: true }))].flatMap((o) => o.lines.ids))
        .load([]);
      await lines.write({ priceUnit: '10' });
    });
    expect(r.queries).toBeLessThanOrEqual(r.budget);
  });
});
