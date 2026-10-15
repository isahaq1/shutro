/**
 * The ERP demo end to end on PostgreSQL: schema through @shutro/migrate, seed data, quotations built with onchange,
 * numbering, the guarded workflow, record rules between salespeople, invoicing from orders, gapless posting,
 * multi-currency totals, the audit trail, translations — and the query inspector watching for N+1 throughout.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccessError,
  createInspector,
  createShutro,
  type Id,
  type InspectorWarning,
  type Shutro,
  TransitionGuardError,
  toDecimal,
  UNNUMBERED,
} from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { applyMigrations, planMigration, writeMigrationFile } from '@shutro/migrate';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { registry } from '../app/registry.ts';
import { GROUPS, type Seeded, seed } from '../app/seed.ts';
import type { Env, S } from '../app/types.ts';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
let data: Seeded;
let dir: string;
const warnings: InspectorWarning[] = [];
const inspector = createInspector({
  n1Threshold: 8,
  slowMs: 2_000,
  onWarning: (w) => warnings.push(w),
});

async function as<T>(
  who: keyof Seeded['users'],
  fn: (env: Env) => Promise<T>,
  lang = 'en_US',
): Promise<T> {
  return shutro.run(
    { user: data.users[who], company: data.company, groups: GROUPS[who], lang },
    fn,
  );
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  dir = mkdtempSync(join(tmpdir(), 'erp-demo-'));
  const plan = await planMigration({ driver, registry });
  await writeMigrationFile({ dir, name: 'install', plan });
  await applyMigrations({ driver, dir, registry });
  shutro = createShutro({ driver, registry, inspector });
  data = await seed(driver, shutro);
}, 240_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('ERP demo', () => {
  test('the schema comes from migrations and matches the models afterwards', async () => {
    expect((await planMigration({ driver, registry })).operations).toEqual([]);
    const [{ n } = { n: 0 }] = await driver.query<{ n: number }>({
      text: 'SELECT count(*)::int AS n FROM product_product',
      params: [],
    });
    expect(n).toBe(503); // 3 products + 500 copied
  });

  test('a salesperson builds a quotation with onchange, saves it, and confirms it', async () => {
    const order = await as('alice', async (env) => {
      const head = await env.model('sale.order').onchange({
        values: { partner: data.partners.acme as Id<'res.partner'> },
        changed: ['partner'],
      });
      expect(head.values.currency).toBe(data.currencies.usd);
      const line = await env.model('sale.order.line').onchange({
        values: { product: data.products.laptop as Id<'product.product'> },
        changed: ['product'],
      });
      expect(line.values).toMatchObject({ name: 'Laptop', priceUnit: '85000', tax: data.vat });

      const so = (
        await env.model('sale.order').create([
          {
            partner: data.partners.acme as Id<'res.partner'>,
            currency: data.currencies.usd as Id<'res.currency'>,
            dateOrder: '2026-10-15',
            lines: {
              create: [
                {
                  product: data.products.laptop as Id<'product.product'>,
                  name: 'Laptop',
                  quantity: '2',
                  priceUnit: '1000',
                  tax: data.vat as Id<'account.tax'>,
                },
                {
                  product: data.products.support as Id<'product.product'>,
                  name: 'Setup',
                  quantity: '3',
                  priceUnit: '50',
                },
              ],
            },
          },
        ])
      ).first();
      await env.flush();
      expect(so.name).toBe('SO/2026/00001');
      expect(so.amountUntaxed?.toString()).toBe('USD 2150.00');
      expect(so.amountTax?.toString()).toBe('USD 300.00');
      expect(so.amountTotal?.toString()).toBe('USD 2450.00');

      const empty = (
        await env.model('sale.order').create([
          {
            partner: data.partners.rahim as Id<'res.partner'>,
            currency: data.currencies.bdt as Id<'res.currency'>,
            dateOrder: '2026-10-15',
          },
        ])
      ).first();
      await expect(empty.confirm()).rejects.toBeInstanceOf(TransitionGuardError);
      await so.confirm();
      expect(so.state).toBe('sale');
      return so.id;
    });
    const trail = await as('mona', async (env) =>
      (await env.model('sale.order').browse([order]).load()).first().trail({ field: 'state' }),
    );
    expect(trail.map((r) => [r.old, r.new])).toEqual([['draft', 'sale']]);
  });

  test('record rules: salespeople see their own orders, managers see all, accountants read them', async () => {
    const bobs = await as('bob', async (env) => {
      await env.model('sale.order').create([
        {
          partner: data.partners.rahim as Id<'res.partner'>,
          currency: data.currencies.bdt as Id<'res.currency'>,
          dateOrder: '2026-10-16',
        },
      ]);
      return (await env.model('sale.order').search()).mapped('name');
    });
    expect(bobs).toEqual(['SO/2026/00003']);
    const alices = await as('alice', async (env) =>
      (await env.model('sale.order').search({ order: ['name'] })).mapped('name'),
    );
    expect(alices).toEqual(['SO/2026/00001', 'SO/2026/00002']);
    await as('alice', async (env) => {
      const [bobOrder] = await env.sql<{
        id: number;
      }>`SELECT id FROM sale_order WHERE name = ${'SO/2026/00003'}`;
      await expect(
        env
          .model('sale.order')
          .browse([Number(bobOrder?.id)])
          .load(),
      ).rejects.toBeInstanceOf(AccessError);
      await expect(env.model('account.move').search()).rejects.toBeInstanceOf(AccessError); // no accounting access
    });
    expect(await as('mona', async (env) => (await env.model('sale.order').search()).length)).toBe(
      3,
    );
    expect(await as('carol', async (env) => (await env.model('sale.order').search()).length)).toBe(
      3,
    );
  });

  test('accounting invoices confirmed orders and posts them with gapless numbers and company-currency totals', async () => {
    const result = await as('carol', async (env) => {
      const confirmed = await env.model('sale.order').search({ where: { state: 'sale' } });
      // Carol (accountant) cannot read order lines herself; createInvoices declares the elevation it needs.
      await expect(env.model('sale.order.line').search()).rejects.toThrow(
        /read access to sale.order.line is denied/,
      );
      const ids = await confirmed.createInvoices({ date: '2026-10-20' });
      expect(env.access.can('sale.order.line', 'read')).toBe(false); // the elevation did not leak
      const [elevation] = await env.sql<{
        reason: string;
        new: unknown;
      }>`SELECT reason, new FROM shutro_audit WHERE action = 'elevate'`;
      expect(elevation).toEqual({
        reason: 'invoice confirmed orders',
        new: ['sale.order.line:read'],
      });
      const invoices = await env
        .model('account.move')
        .browse([...ids])
        .load();
      expect(invoices.mapped('name')).toEqual([UNNUMBERED]);
      await env.flush();
      const inv = invoices.first();
      expect(inv.amountTotal?.toString()).toBe('USD 2450.00');
      await invoices.post();
      expect(inv.name).toBe('INV/2026/10/0001');
      await env.flush();
      const withCount = (await confirmed.load(['invoiceCount'])).first();
      return {
        name: inv.name,
        state: inv.state,
        company: (await invoices.load(['amountTotalCompany']))
          .first()
          .amountTotalCompany?.toString(),
        count: withCount.invoiceCount,
      };
    });
    // 2450 USD at 0.0082 USD per BDT (the rate of 2026-10-01, the latest on or before the invoice date).
    expect(result).toEqual({
      name: 'INV/2026/10/0001',
      state: 'posted',
      company: 'BDT 298780.49',
      count: 1,
    });
  });

  test('translations follow the session language', async () => {
    const names = await as(
      'alice',
      async (env) =>
        (
          await env
            .model('product.product')
            .browse([data.products.laptop, data.products.mouse])
            .load()
        ).mapped('name'),
      'bn_BD',
    );
    expect(names).toEqual(['ল্যাপটপ', 'মাউস']);
  });

  test('the query inspector saw the whole scenario and found no N+1', () => {
    expect(inspector.queries.length).toBeGreaterThan(50);
    expect(warnings.filter((w) => w.kind === 'n+1')).toEqual([]);
  });
});
