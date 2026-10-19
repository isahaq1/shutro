/**
 * The official apps end to end on PostgreSQL 18 (RFC 0019 §7.2): a fresh install of the default apps, then the core
 * flows: quotation → order → invoice → payment, RFQ → purchase order → vendor bill, buying what was sold, a project
 * with tasks from an order, settings, and uninstalling / reinstalling Purchase with its data.
 */
import { buildRegistry, createShutro, type Id, type Shutro, toDecimal } from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { type AppManager, AppStateError, createAppManager } from '@shutro/migrate';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  DEFAULT_APPS,
  officialApps,
  purchaseAccount,
  saleAccount,
  saleProject,
  salePurchase,
  settings,
} from '../src/index.js';

/** Typed to every official app (the installed set of this test). */
const typed = buildRegistry({
  modules: [settings, saleAccount, purchaseAccount, saleProject, salePurchase],
});
type S = NonNullable<(typeof typed)['~schema']>;

let pg: StartedPostgres;
let driver: Driver;
let apps: AppManager;
let shutro: Shutro<S>;
let admin: number;
let company: number;
let usd: Id<'res.currency'>;

const asAdmin = <T>(
  fn: Parameters<Shutro<S>['run']>[1] extends (env: infer E) => Promise<unknown>
    ? (env: E) => Promise<T>
    : never,
): Promise<T> => shutro.run({ user: admin, company, groups: ['base.admin'] }, fn);

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  apps = createAppManager({ driver, modules: officialApps });
  await apps.install(DEFAULT_APPS, { actor: 'test' });
  shutro = createShutro({ driver, registry: typed, catalog: officialApps });
  ({ admin, company, usd } = await shutro.bootstrap({ reason: 'install' }, async (env) => {
    const currency = await env.refId('res.currency', 'base.currency_usd');
    const [c] = await env.model('res.company').create([{ name: 'Paragon Ltd', currency }]);
    const [u] = await env.model('res.users').create([{ login: 'admin', name: 'Administrator' }]);
    if (c === undefined || u === undefined) throw new Error('bootstrap failed');
    return { admin: u.id as number, company: c.id as number, usd: currency };
  }));
}, 240_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('a fresh install', () => {
  test('installs the five default apps, their technical modules and every glue module', async () => {
    expect(await apps.installed()).toEqual([
      'base',
      'partner',
      'product',
      'account',
      'project',
      'purchase',
      'purchase_account',
      'sale',
      'sale_account',
      'sale_project',
      'sale_purchase',
      'settings',
    ]);
    const catalog = await apps.list();
    expect(catalog.filter((a) => a.application).map((a) => [a.name, a.glyph, a.state])).toEqual([
      ['account', '📒', 'installed'],
      ['project', '📋', 'installed'],
      ['purchase', '🛒', 'installed'],
      ['sale', '💼', 'installed'],
      ['settings', '⚙️', 'installed'],
    ]);
    expect(catalog.every((a) => a.icon?.startsWith('<svg') === true)).toBe(true);
  });

  test('ships a chart of accounts, journals, payment terms, taxes, units and stages', async () => {
    const count = async (table: string) =>
      (
        await driver.query<{ n: number }>(
          compile(sql`SELECT count(*)::int AS n FROM ${sql.id(table)}`),
        )
      )[0]?.n;
    expect(await count('account_account')).toBe(12);
    expect(await count('account_journal')).toBe(5);
    expect(await count('account_payment_term')).toBe(3);
    expect(await count('account_tax')).toBe(3);
    expect(await count('uom_uom')).toBe(5);
    expect(await count('project_task_stage')).toBe(5);
    expect(await count('res_currency')).toBe(6);
  });

  test('base and settings cannot be uninstalled', async () => {
    await expect(apps.uninstall(['settings'])).rejects.toThrow(AppStateError);
    await expect(apps.uninstall(['base'])).rejects.toThrow(AppStateError);
  });
});

describe('core flows', () => {
  let customer: Id<'res.partner'>;
  let vendor: Id<'res.partner'>;
  let laptop: Id<'product.product'>;
  let setup: Id<'product.product'>;
  let order: Id<'sale.order'>;

  test('master data', async () => {
    ({ customer, vendor, laptop, setup } = await asAdmin(async (env) => {
      const [c, v] = await env.model('res.partner').create([
        { name: 'Acme Corp', isCustomer: true, email: 'buy@acme.test' },
        { name: 'Globex Supplies', isVendor: true },
      ]);
      const unit = await env.refId('uom.uom', 'product.uom_unit');
      const hour = await env.refId('uom.uom', 'product.uom_hour');
      const vat = await env.refId('account.tax', 'product.tax_sale_15');
      const [l, s] = await env.model('product.product').create([
        { name: 'Laptop', listPrice: '1000', standardPrice: '700', uom: unit, tax: vat },
        { name: 'Setup', kind: 'service', listPrice: '50', uom: hour },
      ]);
      if (c === undefined || v === undefined || l === undefined || s === undefined)
        throw new Error('create');
      return { customer: c.id, vendor: v.id, laptop: l.id, setup: s.id };
    }));
  });

  test('quotation → sales order → invoice → payment', async () => {
    order = await asAdmin(async (env) => {
      const vat = await env.refId('account.tax', 'product.tax_sale_15');
      const so = (
        await env.model('sale.order').create([
          {
            partner: customer,
            currency: usd,
            dateOrder: '2026-10-19',
            lines: {
              create: [
                { product: laptop, name: 'Laptop', quantity: '2', priceUnit: '1000', tax: vat },
                { product: setup, name: 'Setup', quantity: '3', priceUnit: '50' },
              ],
            },
          },
        ])
      ).first();
      await env.flush();
      expect(so.name).toBe('SO/2026/00001');
      expect(so.amountTotal?.toString()).toBe('USD 2450.00');
      await so.confirm();
      expect(so.state).toBe('sale');
      return so.id;
    });

    const invoice = await asAdmin(async (env) => {
      const so = env.model('sale.order').browse([order]);
      const [loaded] = await so.load(['invoiceStatus']);
      expect(loaded?.invoiceStatus).toBe('to_invoice');
      const [id] = await so.createInvoices({ date: '2026-10-19' });
      if (id === undefined) throw new Error('no invoice');
      const inv = (await env.model('account.move').browse([id]).load()).first();
      expect(inv.name).toBe('/');
      expect(inv.origin).toBe('SO/2026/00001');
      await env.model('account.move').browse([id]).post();
      return id;
    });

    await asAdmin(async (env) => {
      const inv = (await env.model('account.move').browse([invoice]).load()).first();
      expect(inv.name).toBe('INV/2026/10/0001');
      expect(inv.amountTotal?.toString()).toBe('USD 2450.00');
      expect(inv.paymentState).toBe('not_paid');
      expect(inv.dueDate).toBe('2026-10-19');
      await env.model('account.move').browse([invoice]).registerPayment({ date: '2026-10-20' });
    });

    await asAdmin(async (env) => {
      const inv = (await env.model('account.move').browse([invoice]).load()).first();
      expect(inv.paymentState).toBe('paid');
      expect(inv.amountResidual?.isZero()).toBe(true);
      const [payment] = await env.model('account.payment').search({ where: { move: invoice } });
      expect(payment?.name).toBe('PAY/2026/00001');
      expect(payment?.paymentType).toBe('inbound');
      const [so] = await env
        .model('sale.order')
        .browse([order])
        .load(['invoiceStatus', 'invoiceCount']);
      expect(so).toMatchObject({ invoiceStatus: 'invoiced', invoiceCount: 1 });
    });
  });

  test('buy what was sold: RFQ → purchase order → vendor bill, numbered apart from invoices', async () => {
    const po = await asAdmin(async (env) => {
      const [id] = await env.model('sale.order').browse([order]).createPurchaseOrders({ vendor });
      if (id === undefined) throw new Error('no purchase order');
      const loaded = (
        await env
          .model('purchase.order')
          .browse([id])
          .load({ lines: ['name', 'priceUnit'] })
      ).first();
      expect(loaded.origin).toBe('SO/2026/00001');
      expect([...loaded.lines].map((l) => [l.name, l.priceUnit.toString()])).toEqual([
        ['Laptop', '700'],
      ]); // goods only, at cost
      await env.model('purchase.order').browse([id]).confirm();
      return id;
    });
    await asAdmin(async (env) => {
      const [billId] = await env
        .model('purchase.order')
        .browse([po])
        .createBills({ date: '2026-10-19' });
      if (billId === undefined) throw new Error('no bill');
      const bill = env.model('account.move').browse([billId]);
      await bill.post();
      const [loaded] = await bill.load(['name', 'moveType', 'amountTotal']);
      expect(loaded?.name).toBe('BILL/2026/10/0001'); // its own gapless sequence
      expect(loaded?.moveType).toBe('in_invoice');
      expect(loaded?.amountTotal?.toString()).toBe('USD 1400.00');
      const [payment] = await env.model('account.payment').create([
        {
          paymentType: 'outbound',
          partner: vendor,
          move: billId,
          journal: await env.refId('account.journal', 'account.journal_bank'),
          currency: usd,
          amount: '400',
          date: '2026-10-20',
        },
      ]);
      await env
        .model('account.payment')
        .browse([payment?.id ?? 0])
        .post();
      const [after] = await bill.load(['paymentState', 'amountResidual']);
      expect(after?.paymentState).toBe('partial');
      expect(after?.amountResidual?.toString()).toBe('USD 1000.00');
    });
  });

  test('a project with a task per order line, and stages that close tasks', async () => {
    await asAdmin(async (env) => {
      const [projectId] = await env.model('sale.order').browse([order]).createProjects();
      if (projectId === undefined) throw new Error('no project');
      const project = (
        await env
          .model('project.project')
          .browse([projectId])
          .load({ tasks: ['name', 'isClosed'] })
      ).first();
      expect(project.name).toBe('SO/2026/00001 – Acme Corp');
      expect([...project.tasks].map((t) => t.name)).toEqual(['Laptop', 'Setup']);
      const [first] = [...project.tasks];
      await env
        .model('project.task')
        .browse([first?.id ?? 0])
        .markDone();
      const [counts] = await env
        .model('project.project')
        .browse([projectId])
        .load(['taskCount', 'openTaskCount']);
      expect(counts).toMatchObject({ taskCount: 2, openTaskCount: 1 });
    });
  });

  test('settings per company, falling back to global ones', async () => {
    await asAdmin(async (env) => {
      const params = env.model('res.config.parameter').browse([]);
      await params.setParam('account.lock_date', '2026-01-01', { global: true });
      expect(await params.getParam('account.lock_date')).toBe('2026-01-01');
      await params.setParam('account.lock_date', '2026-06-30');
      expect(await params.getParam('account.lock_date')).toBe('2026-06-30');
      expect(await params.getParam('missing', 'fallback')).toBe('fallback');
    });
  });
});

describe('uninstall and reinstall an app', () => {
  test('Purchase goes to quarantine with its glue, Sales keeps working, reinstall restores the orders', async () => {
    const plan = await apps.planUninstall(['purchase']);
    expect(plan.modules.map((m) => [m.name, m.reason])).toEqual([
      ['sale_purchase', 'auto'],
      ['purchase_account', 'auto'],
      ['purchase', 'requested'],
    ]);
    expect(plan.tables.map((t) => [t.table, t.rows])).toEqual([
      ['purchase_order', 1],
      ['purchase_order_line', 1],
    ]);
    expect(plan.columns.map((c) => `${c.table}.${c.column}:${c.rows}`)).toEqual([
      'account_move.purchase_order_id:1',
    ]);

    const { registry } = await apps.uninstall(['purchase'], { actor: 'test' });
    shutro.useRegistry(registry);
    await asAdmin(async (env) => {
      expect(env.apps.has('purchase')).toBe(false);
      expect(() => env.model('purchase.order')).toThrow(/shutro apps install purchase/);
      expect((await env.model('sale.order').search({})).length).toBe(1);
      expect(
        (await env.model('account.move').search({ where: { moveType: 'in_invoice' } })).length,
      ).toBe(1);
    });

    const reinstalled = await apps.install(['purchase'], { actor: 'test' });
    expect(reinstalled.plan.modules.every((m) => m.restore)).toBe(true);
    shutro.useRegistry(reinstalled.registry);
    await asAdmin(async (env) => {
      const [po] = await env.model('purchase.order').search({});
      expect(po?.origin).toBe('SO/2026/00001');
      const [bill] = await env.model('account.move').search({ where: { moveType: 'in_invoice' } });
      expect(bill?.purchaseOrder?.id).toBe(po?.id);
    });
  });
});
