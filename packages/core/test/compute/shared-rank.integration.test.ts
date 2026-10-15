/**
 * Regression: fields sharing one compute method run at the highest rank among them. Here `untaxed` (rank 1) and
 * `tax` (rank 2) share `computeTotals`; `tax` reads the lines' `taxAmount` (rank 1). Running the group at rank 1
 * would read `taxAmount` before it exists and then suppress the re-trigger.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildRegistry,
  type ComputeSet,
  createShutro,
  createTableStatements,
  type DefaultLoaded,
  defineModel,
  defineModule,
  f,
  type Merge,
  type ToLoaded,
  toDecimal,
} from '../../src/index.js';

type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

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
const Line = defineModel('x.line', {
  fields: {
    doc: f.many2one('x.doc', { required: true, ondelete: 'cascade' }),
    amount: f.decimal({ scale: 2, required: true }),
    net: f.decimal({
      scale: 2,
      store: true,
      depends: ['amount'],
      compute(records: unknown): void {
        for (const l of records as ComputeSet<S, 'x.line', DefaultLoaded<S, 'x.line'>>)
          l.net = l.amount;
      },
    }),
    taxAmount: f.decimal({
      scale: 2,
      store: true,
      depends: ['net'],
      compute(records: unknown): void {
        for (const l of records as ComputeSet<S, 'x.line', DefaultLoaded<S, 'x.line'>>)
          l.taxAmount = toDecimal(l.net as never).times('0.1');
      },
    }),
  },
});
const Doc = defineModel('x.doc', {
  fields: {
    lines: f.one2many('x.line', 'doc'),
    untaxed: f.decimal({ scale: 2, store: true, depends: ['lines.net'], compute: 'computeTotals' }),
    tax: f.decimal({
      scale: 2,
      store: true,
      depends: ['lines.taxAmount'],
      compute: 'computeTotals',
    }),
  },
  methods: {
    computeTotals(records: unknown): void {
      for (const d of records as ComputeSet<
        S,
        'x.doc',
        Merge<DefaultLoaded<S, 'x.doc'>, ToLoaded<S, 'x.doc', { lines: ['net', 'taxAmount'] }>>
      >) {
        let untaxed = toDecimal(0);
        let tax = toDecimal(0);
        for (const l of d.lines) {
          untaxed = untaxed.plus((l.net as never) ?? 0);
          tax = tax.plus((l.taxAmount as never) ?? 0);
        }
        d.untaxed = untaxed;
        d.tax = tax;
      }
    },
  },
});
const registry = buildRegistry({
  modules: [defineModule({ name: 'x', models: [Users, Currency, Company, Doc, Line] })],
  security: { enforce: false },
});

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

test('a shared compute runs once its highest-ranked field can be computed', async () => {
  expect(registry.compute.field('x.doc', 'untaxed')?.rank).toBe(1);
  expect(registry.compute.field('x.doc', 'tax')?.rank).toBe(2);
  await createShutro({ driver, registry }).run({ user: 1, company: 1 }, async (env) => {
    const doc = (
      await env
        .model('x.doc')
        .create([{ lines: { create: [{ amount: '100' }, { amount: '50' }] } }])
    ).first();
    await env.flush();
    expect(String(doc.untaxed)).toBe('150');
    expect(String(doc.tax)).toBe('15');
  });
});
