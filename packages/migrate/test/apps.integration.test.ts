/**
 * App lifecycle against real PostgreSQL 18 (RFC 0019): atomic install with dependencies, required and glue modules,
 * plans that change nothing, quarantine and restore (tables, extension columns, foreign keys), purge, blockers,
 * upgrade with hooks, the operation log, and following installs from another process.
 */
import {
  createShutro,
  defineModel,
  defineModule,
  extendModel,
  type Field,
  f,
  type ModuleBase,
  record,
  toDecimal,
} from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  AppDependentsError,
  type AppEvent,
  AppStateError,
  createAppManager,
  DestructiveMigrationError,
  QUARANTINE_SCHEMA,
  UninstallBlockedError,
  UnknownAppError,
} from '../src/index.js';

// ------------------------------------------------------------------------------------------------ the catalog

const base = defineModule({
  name: 'base',
  version: '1.0.0',
  required: true,
  models: [
    defineModel('res.users', { fields: { login: f.char({ required: true }) } }),
    defineModel('res.currency', { fields: { name: f.char({ required: true }) } }),
    defineModel('res.company', {
      fields: {
        name: f.char({ required: true }),
        currency: f.many2one('res.currency', { required: true }),
      },
    }),
    defineModel('res.partner', { fields: { name: f.char({ required: true }) } }),
  ],
  data: [record('res.currency', 'currency_bdt', { name: 'BDT' })],
});

const settings = defineModule({
  name: 'settings',
  version: '1.0.0',
  application: true,
  required: true,
  glyph: '⚙️',
  depends: [base],
  models: [
    defineModel('res.config', { fields: { key: f.char({ required: true }), value: f.char() } }),
  ],
});

const sale = defineModule({
  name: 'sale',
  version: '1.0.0',
  application: true,
  glyph: '💼',
  depends: [base],
  models: [
    defineModel('sale.order', {
      fields: {
        name: f.char({ required: true }),
        partner: f.many2one('res.partner', { required: true }),
      },
    }),
  ],
});

function purchaseModule(version: '1.0.0' | '1.1.0', blocked: { reasons: string[] }) {
  return defineModule({
    name: 'purchase',
    version,
    application: true,
    glyph: '🛒',
    depends: [base],
    models: [
      defineModel('purchase.order', {
        fields: {
          name: f.char({ required: true }),
          partner: f.many2one('res.partner', { required: true }),
          ...(version === '1.1.0' ? { notes: f.text() } : {}),
        } as Record<string, Field>,
      }),
    ],
    data: [record('res.partner', 'vendor_default', { name: 'Default vendor' })],
    migrations:
      version === '1.1.0'
        ? [
            {
              version: '1.1.0',
              up: async (ctx) => {
                await ctx.sql`UPDATE purchase_order SET notes = 'migrated' WHERE notes IS NULL`;
              },
            },
          ]
        : [],
    uninstall: { blockers: async () => blocked.reasons },
  });
}

function catalog(version: '1.0.0' | '1.1.0' = '1.0.0', blocked = { reasons: [] as string[] }) {
  const purchase = purchaseModule(version, blocked);
  const salePurchase = defineModule({
    name: 'sale_purchase',
    version: '1.0.0',
    autoInstall: true,
    depends: [sale, purchase],
    models: [],
    extensions: [
      extendModel('sale.order', {
        fields: { purchase: f.many2one('purchase.order', { ondelete: 'set null' }) },
      }),
    ],
  });
  const purchaseReports = defineModule({
    name: 'purchase_report',
    version: '1.0.0',
    application: true,
    depends: [purchase],
    models: [defineModel('purchase.report', { fields: { title: f.char() } })],
  });
  return {
    purchase,
    salePurchase,
    purchaseReports,
    all: [base, settings, sale, purchase, salePurchase, purchaseReports] as ModuleBase[],
  };
}

// ------------------------------------------------------------------------------------------------ setup

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

/** A clean database for each test. */
beforeEach(async () => {
  await driver.query(compile(sql`DROP SCHEMA IF EXISTS "public" CASCADE`));
  await driver.query(compile(sql`DROP SCHEMA IF EXISTS "shutro_quarantine" CASCADE`));
  await driver.query(compile(sql`CREATE SCHEMA "public"`));
});

const tables = async (schema = 'public'): Promise<string[]> =>
  (
    await driver.query<{ name: string }>(
      compile(
        sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = ${schema} AND tablename NOT LIKE 'shutro%' ORDER BY 1`,
      ),
    )
  ).map((r) => r.name);

const states = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await driver.query<{ name: string; state: string }>(
        compile(sql`SELECT name, state FROM shutro_module ORDER BY name`),
      )
    ).map((r) => [r.name, r.state]),
  );

// ------------------------------------------------------------------------------------------------ tests

describe('install', () => {
  test('a fresh install adds dependencies and required modules, loads data, records state and the log', async () => {
    const { all } = catalog();
    const apps = createAppManager({ driver, modules: all, security: { enforce: false } });
    const events: AppEvent[] = [];
    const result = await apps.install(['sale'], { actor: 'admin', onEvent: (e) => events.push(e) });

    expect(result.plan.modules.map((m) => [m.name, m.reason])).toEqual([
      ['base', 'dependency'],
      ['sale', 'requested'],
      ['settings', 'required'],
    ]);
    expect(await tables()).toEqual([
      'res_company',
      'res_config',
      'res_currency',
      'res_partner',
      'res_users',
      'sale_order',
    ]);
    expect(await states()).toEqual({ base: 'installed', sale: 'installed', settings: 'installed' });
    expect(result.registry.loadOrder).toEqual(['base', 'sale', 'settings']);
    const [bdt] = await driver.query(compile(sql`SELECT name FROM res_currency`));
    expect(bdt).toEqual({ name: 'BDT' });
    const [stored] = await driver.query(
      compile(sql`SELECT plan->>'operation' AS operation FROM shutro_module_log`),
    );
    expect(stored).toEqual({ operation: 'install' }); // the plan is stored as JSON, not as a JSON string

    expect(events[0]?.type).toBe('plan');
    expect(
      events.filter((e) => e.type === 'step' && e.step === 'data' && e.status === 'done'),
    ).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'done', operation: 'install' });
    const [log] = await driver.query<{
      operation: string;
      modules: string[];
      actor: string;
      outcome: string;
    }>(compile(sql`SELECT operation, modules, actor, outcome FROM shutro_module_log`));
    expect(log).toEqual({
      operation: 'install',
      modules: ['base', 'sale', 'settings'],
      actor: 'admin',
      outcome: 'ok',
    });
    expect((await apps.install(['sale'])).plan.modules).toEqual([]); // already installed: nothing to do
  });

  test('glue modules install with the last of their dependencies', async () => {
    const { all } = catalog();
    const apps = createAppManager({ driver, modules: all, security: { enforce: false } });
    await apps.install(['sale']);
    const { plan } = await apps.install(['purchase']);
    expect(plan.modules.map((m) => [m.name, m.reason])).toEqual([
      ['purchase', 'requested'],
      ['sale_purchase', 'auto'],
    ]);
    expect(
      plan.statements.some((s) => s.includes('"sale_order"') && s.includes('"purchase_id"')),
    ).toBe(true);
    expect(plan.statements.every((s) => !s.includes('"res_config"'))).toBe(true); // only what the new modules need
  });

  test('a plan changes nothing and equals the install', async () => {
    const { all } = catalog();
    const apps = createAppManager({ driver, modules: all, security: { enforce: false } });
    const plan = await apps.planInstall(['purchase']);
    expect(await tables()).toEqual([]);
    expect(await apps.installed()).toEqual([]);
    const { plan: real } = await apps.install(['purchase']);
    expect(real).toEqual(plan);
  });

  test('a failing install changes nothing and is logged as failed', async () => {
    const broken = defineModule({
      name: 'broken',
      depends: [base],
      models: [defineModel('broken.thing', { fields: { name: f.char({ required: true }) } })],
      data: [record('broken.thing', 'bad', { name: null })],
    });
    const apps = createAppManager({
      driver,
      modules: [base, settings, broken],
      security: { enforce: false },
    });
    await expect(apps.install(['broken'])).rejects.toThrow();
    expect(await tables()).toEqual([]);
    expect(await apps.installed()).toEqual([]);
    const logs = await driver.query<{ outcome: string }>(
      compile(sql`SELECT outcome FROM shutro_module_log`),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.outcome).toMatch(/^failed: /);
  });

  test('unknown apps are named with the available ones', async () => {
    const apps = createAppManager({ driver, modules: catalog().all, security: { enforce: false } });
    await expect(apps.install(['purchse'])).rejects.toThrow(UnknownAppError);
    await expect(apps.install(['purchse'])).rejects.toThrow(/Available: base, .*purchase/);
  });
});

describe('uninstall', () => {
  async function seeded() {
    const blocked = { reasons: [] as string[] };
    const { all } = catalog('1.0.0', blocked);
    const apps = createAppManager({ driver, modules: all, security: { enforce: false } });
    await apps.install(['sale', 'purchase']);
    await driver.query(compile(sql`INSERT INTO res_partner (name) VALUES ('Acme'), ('Globex')`));
    await driver.query(
      compile(
        sql`INSERT INTO purchase_order (name, partner_id) SELECT 'PO' || id, id FROM res_partner WHERE name IN ('Acme', 'Globex')`,
      ),
    );
    await driver.query(
      compile(
        sql`INSERT INTO sale_order (name, partner_id, purchase_id) SELECT 'SO1', p.partner_id, p.id FROM purchase_order p WHERE p.name LIKE 'PO%' ORDER BY p.id LIMIT 1`,
      ),
    );
    return { apps, blocked };
  }

  test('required modules and their dependencies cannot be uninstalled', async () => {
    const { apps } = await seeded();
    await expect(apps.uninstall(['settings'])).rejects.toThrow(AppStateError);
    await expect(apps.uninstall(['base'])).rejects.toThrow(/required/);
  });

  test('dependents must be confirmed; glue modules follow', async () => {
    const { apps } = await seeded();
    await apps.install(['purchase_report']);
    const error = await apps.uninstall(['purchase']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppDependentsError);
    expect((error as AppDependentsError).dependents).toEqual(['purchase_report']);
    const plan = await apps.planUninstall(['purchase'], { cascade: true });
    expect(plan.modules.map((m) => [m.name, m.reason])).toEqual([
      ['sale_purchase', 'auto'],
      ['purchase_report', 'dependent'],
      ['purchase', 'requested'],
    ]);
  });

  test('the plan counts what goes, and changes nothing', async () => {
    const { apps } = await seeded();
    const plan = await apps.planUninstall(['purchase']);
    expect(plan.purge).toBe(false);
    expect(plan.retentionDays).toBe(30);
    expect(plan.tables).toEqual([{ table: 'purchase_order', module: 'purchase', rows: 2 }]);
    expect(plan.columns).toEqual([
      { table: 'sale_order', column: 'purchase_id', module: 'sale_purchase', rows: 1 },
    ]);
    expect(await tables()).toContain('purchase_order');
  });

  test('blockers refuse the uninstall and nothing changes', async () => {
    const { apps, blocked } = await seeded();
    blocked.reasons.push('2 purchase orders are confirmed');
    const error = await apps.uninstall(['purchase']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UninstallBlockedError);
    expect((error as UninstallBlockedError).reasons).toEqual({
      purchase: ['2 purchase orders are confirmed'],
    });
    expect(await states()).toMatchObject({ purchase: 'installed', sale_purchase: 'installed' });
  });

  test('quarantine moves tables and columns aside; reinstall brings everything back', async () => {
    const { apps } = await seeded();
    const { plan, registry } = await apps.uninstall(['purchase']);
    expect(plan.modules.map((m) => m.name)).toEqual(['sale_purchase', 'purchase']);
    expect(registry.has('purchase.order')).toBe(false);
    expect(await tables()).not.toContain('purchase_order');
    expect(await tables(QUARANTINE_SCHEMA)).toContain('purchase_order');
    expect(await states()).toMatchObject({ purchase: 'quarantined', sale_purchase: 'quarantined' });
    const columns = await driver.query<{ column_name: string }>(
      compile(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'sale_order' AND table_schema = 'public'`,
      ),
    );
    expect(columns.map((c) => c.column_name)).not.toContain('purchase_id');

    // Quarantined rows must not block the apps that stay: Globex can be deleted although a quarantined PO refers to it.
    await driver.query(compile(sql`DELETE FROM res_partner WHERE name = 'Globex'`));
    const list = await apps.list();
    expect(list.find((a) => a.name === 'purchase')).toMatchObject({
      state: 'quarantined',
      glyph: '🛒',
    });
    expect(list.find((a) => a.name === 'purchase')?.purgeAfter).toBeInstanceOf(Date);

    const events: AppEvent[] = [];
    const reinstall = await apps.install(['purchase'], { onEvent: (e) => events.push(e) });
    expect(reinstall.plan.modules.map((m) => [m.name, m.restore])).toEqual([
      ['purchase', true],
      ['sale_purchase', true],
    ]);
    const orders = await driver.query(compile(sql`SELECT name FROM purchase_order ORDER BY id`));
    expect(orders).toHaveLength(2);
    const [so] = await driver.query<{ purchase_id: string | null }>(
      compile(sql`SELECT purchase_id FROM sale_order`),
    );
    expect(so?.purchase_id).not.toBeNull();
    expect(reinstall.warnings.some((w) => w.includes('NOT VALID'))).toBe(true); // Globex is gone
    expect(events.some((e) => e.type === 'warning')).toBe(true);
    expect(await tables(QUARANTINE_SCHEMA)).toEqual(['item']);
  });

  test('purge drops the data and forgets the module data', async () => {
    const { apps } = await seeded();
    await apps.uninstall(['purchase'], { purge: true });
    expect(await tables()).not.toContain('purchase_order');
    expect(await tables(QUARANTINE_SCHEMA)).toEqual(['item']);
    expect(await states()).toMatchObject({ purchase: 'uninstalled', sale_purchase: 'uninstalled' });
    const ids = await driver.query(
      compile(sql`SELECT name FROM shutro_external_id WHERE module = 'purchase'`),
    );
    expect(ids).toEqual([]);
    const vendors = await driver.query(
      compile(sql`SELECT name FROM res_partner WHERE name = 'Default vendor'`),
    );
    expect(vendors).toEqual([]);
    // A purged app installs again from scratch.
    await apps.install(['purchase']);
    expect(await driver.query(compile(sql`SELECT count(*)::int AS n FROM purchase_order`))).toEqual(
      [{ n: 0 }],
    );
  });

  test('quarantine past retention is purged by the next operation', async () => {
    const { apps } = await seeded();
    await apps.uninstall(['purchase']);
    await driver.query(
      compile(
        sql`UPDATE shutro_module SET quarantined_at = now() - interval '31 days' WHERE state = 'quarantined'`,
      ),
    );
    const { plan } = await apps.purge();
    expect(plan.modules.map((m) => m.name).sort()).toEqual(['purchase', 'sale_purchase']);
    expect(plan.tables).toEqual(['purchase_order']);
    expect(await tables(QUARANTINE_SCHEMA)).toEqual(['item']);
    expect(await states()).toMatchObject({ purchase: 'uninstalled' });
  });
});

describe('upgrade and following', () => {
  test('upgrade adds the new schema, runs the hooks once and records the version', async () => {
    const v1 = createAppManager({
      driver,
      modules: catalog('1.0.0').all,
      security: { enforce: false },
    });
    await v1.install(['purchase']);
    await driver.query(compile(sql`INSERT INTO res_partner (name) VALUES ('Acme')`));
    await driver.query(
      compile(
        sql`INSERT INTO purchase_order (name, partner_id) SELECT 'PO1', id FROM res_partner WHERE name = 'Acme'`,
      ),
    );

    const v2 = createAppManager({
      driver,
      modules: catalog('1.1.0').all,
      security: { enforce: false },
    });
    expect((await v2.list()).find((a) => a.name === 'purchase')).toMatchObject({
      upgradable: true,
      installedVersion: '1.0.0',
    });
    const plan = await v2.planUpgrade();
    expect(plan.modules.map((m) => [m.name, m.from, m.version])).toEqual([
      ['purchase', '1.0.0', '1.1.0'],
    ]);
    await v2.upgrade();
    expect(await driver.query(compile(sql`SELECT notes FROM purchase_order`))).toEqual([
      { notes: 'migrated' },
    ]);
    expect((await v2.state()).get('purchase')?.version).toBe('1.1.0');
    expect((await v2.planUpgrade()).modules).toEqual([]);
  });

  test('destructive upgrades need allowDestructive', async () => {
    const v2 = createAppManager({
      driver,
      modules: catalog('1.1.0').all,
      security: { enforce: false },
    });
    await v2.install(['purchase']);
    const v1 = createAppManager({
      driver,
      modules: catalog('1.0.0').all,
      security: { enforce: false },
    });
    await expect(v1.upgrade()).rejects.toThrow(DestructiveMigrationError);
  });

  test('attach keeps a Shutro instance on the installed set across processes', async () => {
    const { all } = catalog();
    const kosh = createAppManager({ driver, modules: all, security: { enforce: false } });
    const cli = createAppManager({ driver, modules: all, security: { enforce: false } });
    await cli.install(['sale']);
    const shutro = createShutro({ driver, registry: await kosh.registry(), catalog: all });
    const stop = await kosh.attach(shutro);
    try {
      expect(shutro.registry?.has('purchase.order')).toBe(false);
      await cli.install(['purchase']);
      await expect
        .poll(() => shutro.registry?.has('purchase.order'), { timeout: 5_000 })
        .toBe(true);
      const found = await shutro.run({ user: 1, company: 1 }, async (env) => {
        expect(env.apps.has('sale_purchase')).toBe(true);
        return (await env.model('purchase.order' as never).search({})).length;
      });
      expect(found).toBe(0);
    } finally {
      await stop();
    }
  });
});
