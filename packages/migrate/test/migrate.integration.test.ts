/**
 * Migrations against real PostgreSQL 18: live catalog reading, planning, versioned files, the ledger, and module
 * data-migration hooks.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistry,
  createTableStatements,
  defineModel,
  defineModule,
  type Field,
  f,
  type MigrationContext,
  type Registry,
} from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  applyMigrations,
  DestructiveMigrationError,
  MigrationChecksumError,
  migrationStatus,
  planMigration,
  readLiveSchema,
  writeMigrationFile,
} from '../src/index.js';

function baseModels() {
  return [
    defineModel('res.users', { fields: { login: f.char({ required: true }) } }),
    defineModel('res.currency', { fields: { name: f.char({ required: true }) } }),
    defineModel('res.company', {
      fields: {
        name: f.char({ required: true }),
        currency: f.many2one('res.currency', { required: true }),
      },
    }),
    defineModel('res.partner', {
      archivable: true,
      fields: { name: f.char({ required: true, index: true }) },
    }),
  ];
}

function saleRegistry(
  version: 1 | 2 | 3,
  hooks: readonly { version: string; up: (ctx: MigrationContext) => Promise<void> }[] = [],
): Registry {
  const base = defineModule({ name: 'base', models: baseModels() });
  const fields: Record<string, Field> = {
    name: f.char({ required: true, size: 64 }),
    partner: f.many2one('res.partner', { required: true }),
    amount: f.decimal({ scale: 2, required: true, default: '0' }),
    ...(version === 1 ? { legacy: f.text() } : {}),
    ...(version >= 2
      ? {
          priority: f.integer({ required: true, default: 1 }),
          tags: f.many2many('sale.tag'),
          reference: f.char({ index: 'unique' }),
          // Literal defaults become SQL DEFAULTs (feedback #3); the plan after applying must be empty.
          origin: f.char({ required: true, default: "O'Neil" }),
          kind: f.selection({ goods: 'Goods', service: 'Service' }, { default: 'goods' }),
          rate: f.decimal({ scale: 4, default: '1.50' }),
          ratio: f.float({ default: 0.5 }),
          validFrom: f.date({ default: '2026-01-01' }),
          shift: f.integer({ default: -1 }),
        }
      : {}),
    ...(version >= 3 ? { note: f.text() } : {}),
  };
  const models = [
    defineModel('sale.order', {
      companyScoped: { required: true },
      fields,
      ...(version >= 2 ? { indexes: [{ fields: ['partner', 'name'] }] } : {}),
    }),
  ];
  if (version >= 2)
    models.push(defineModel('sale.tag', { fields: { name: f.char({ required: true }) } }) as never);
  const sale = defineModule({
    name: 'sale',
    version: version === 1 ? '1.0.0' : version === 2 ? '1.1.0' : '1.2.0',
    depends: [base],
    models,
    migrations: hooks,
  });
  return buildRegistry({ modules: [sale] }) as Registry;
}

let pg: StartedPostgres;
let driver: Driver;
let dir: string;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3 });
  dir = mkdtempSync(join(tmpdir(), 'shutro-migrate-'));
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('plan, write, apply', () => {
  test('a fresh database: the plan creates everything; applying it makes the next plan empty', async () => {
    const registry = saleRegistry(1);
    const plan = await planMigration({ driver, registry });
    expect(
      plan.operations.some((o) => o.kind === 'createTable' && o.table.name === 'sale_order'),
    ).toBe(true);
    expect(plan.destructive).toEqual([]);
    const file = await writeMigrationFile({ dir, name: 'init', plan });
    expect(file.version).toBe('0001');
    expect(readdirSync(dir)).toEqual(['0001_init.sql']);
    expect(readFileSync(join(dir, '0001_init.sql'), 'utf8')).toMatch(
      /^-- shutro migration 0001: init/,
    );

    const before = await migrationStatus({ driver, dir });
    expect(before.pending.map((p) => p.version)).toEqual(['0001']);
    const result = await applyMigrations({ driver, dir, registry });
    expect(result.applied.map((a) => a.version)).toEqual(['0001']);
    expect(result.modules).toEqual([
      { module: 'base', from: null, to: '0.0.0' },
      { module: 'sale', from: null, to: '1.0.0' },
    ]);
    const after = await migrationStatus({ driver, dir });
    expect(after.applied.map((a) => a.version)).toEqual(['0001']);
    expect(after.pending).toEqual([]);
    expect((await planMigration({ driver, registry })).operations).toEqual([]);
  });

  test('the live catalog reader sees what was created', async () => {
    const live = await readLiveSchema(driver);
    expect(live.tables['sale_order']?.columns['amount']).toMatchObject({
      type: 'numeric(32,2)',
      nullable: false,
    });
    expect(live.tables['sale_order']?.columns['id']).toMatchObject({ identity: true });
    expect(live.tables['sale_order']?.foreignKeys['sale_order_partner_id_fkey']).toEqual({
      column: 'partner_id',
      references: 'res_partner',
      onDelete: 'RESTRICT',
    });
    expect(live.tables['res_partner']?.indexes['res_partner_name_idx']).toMatchObject({
      columns: ['name'],
      unique: false,
      method: 'btree',
    });
    expect(live.tables['res_partner']?.columns['active']).toMatchObject({ default: 'true' });
  });

  test('schema changes: additive plan applies; the dropped field is reported and refused until allowed', async () => {
    const registry = saleRegistry(2);
    const plan = await planMigration({ driver, registry });
    const kinds = plan.operations.map((o) => o.kind);
    expect(kinds).toContain('addColumn');
    expect(kinds).toContain('createTable'); // sale_tag and the junction table
    expect(kinds).toContain('createIndex');
    expect(plan.destructive).toEqual([
      { kind: 'dropColumn', table: 'sale_order', column: 'legacy', destructive: true },
    ]);
    await writeMigrationFile({ dir, name: 'sale_v2', plan });
    await expect(applyMigrations({ driver, dir, registry })).rejects.toBeInstanceOf(
      DestructiveMigrationError,
    );
    const result = await applyMigrations({ driver, dir, registry, allowDestructive: true });
    expect(result.applied.map((a) => a.name)).toEqual(['sale_v2']);
    expect(result.modules).toEqual([{ module: 'sale', from: '1.0.0', to: '1.1.0' }]);
    expect((await planMigration({ driver, registry })).operations).toEqual([]);
    const live = await readLiveSchema(driver);
    expect(live.tables['sale_order']?.columns['legacy']).toBeUndefined();
    expect(live.tables['sale_order']?.columns['priority']).toMatchObject({
      type: 'integer',
      nullable: false,
      default: '1',
    });
    const columns = live.tables['sale_order']?.columns;
    expect(columns?.['origin']?.default).toBe("'O''Neil'");
    expect(columns?.['kind']?.default).toBe("'goods'");
    expect(columns?.['rate']?.default).toBe('1.50');
    expect(columns?.['ratio']?.default).toBe('0.5');
    expect(columns?.['valid_from']?.default).toBe("'2026-01-01'");
    expect(columns?.['shift']?.default).toBeNull(); // negative: stays in the ORM
    expect(live.tables['sale_order_sale_tag_rel']?.primaryKey).toEqual([
      'sale_order_id',
      'sale_tag_id',
    ]);
    expect(live.tables['sale_order']?.indexes['sale_order_reference_idx']).toMatchObject({
      unique: true,
    });
  });

  test('the DDL stopgap in core produces a schema the migrator agrees with', async () => {
    const registry = saleRegistry(2);
    const scratch = createDriver({ url: pg.url, max: 1 });
    await scratch.query({ text: 'CREATE SCHEMA stopgap', params: [] });
    await scratch.query({ text: 'SET search_path TO stopgap', params: [] });
    for (const statement of createTableStatements(registry)) await scratch.query(statement);
    const plan = await planMigration({ driver: scratch, registry, schema: 'stopgap' });
    // The stopgap creates no indexes / check constraints, so only those remain to be added.
    expect(plan.operations.every((o) => o.kind === 'createIndex')).toBe(true);
    await scratch.end();
  });

  test('history tables: the stopgap and the migrator agree', async () => {
    const Doc = defineModel('x.doc', {
      history: true,
      fields: { name: f.char({ required: true }), total: f.decimal({ scale: 2 }) },
    });
    const registry = buildRegistry({
      modules: [defineModule({ name: 'x', models: [...baseModels(), Doc] })],
    }) as Registry;
    const scratch = createDriver({ url: pg.url, max: 1 });
    await scratch.query({ text: 'CREATE SCHEMA history_check', params: [] });
    await scratch.query({ text: 'SET search_path TO history_check', params: [] });
    for (const statement of createTableStatements(registry)) await scratch.query(statement);
    const plan = await planMigration({ driver: scratch, registry, schema: 'history_check' });
    expect(plan.operations.filter((o) => o.kind !== 'createIndex')).toEqual([]);
    const live = await readLiveSchema(scratch, 'history_check');
    expect(Object.keys(live.tables['x_doc_history']?.columns ?? {})).toEqual(
      expect.arrayContaining(['id', 'name', 'total', 'valid_from', 'valid_to']),
    );
    await scratch.end();
  });

  test('a tampered applied file is refused', async () => {
    const path = join(dir, '0001_init.sql');
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, `${original}\n-- edited after apply\n`);
    await expect(
      applyMigrations({ driver, dir, registry: saleRegistry(2) }),
    ).rejects.toBeInstanceOf(MigrationChecksumError);
    writeFileSync(path, original);
  });

  test('module data-migration hooks run once, in version order, only on upgrade', async () => {
    const ran: string[] = [];
    const hooks = [
      {
        version: '1.2.0',
        up: async (ctx: MigrationContext): Promise<void> => {
          ran.push('1.2.0');
          await ctx.sql`UPDATE sale_order SET note = ${'migrated'} WHERE note IS NULL`;
        },
      },
      {
        version: '1.1.0',
        up: async (): Promise<void> => {
          ran.push('1.1.0');
        },
      }, // already at 1.1.0: must not run
      {
        version: '1.0.5',
        up: async (): Promise<void> => {
          ran.push('1.0.5');
        },
      },
    ];
    const registry = saleRegistry(3, hooks);
    await driver.query(compile(sql`INSERT INTO res_users (login) VALUES (${'admin'})`));
    await driver.query(compile(sql`INSERT INTO res_currency (name) VALUES (${'BDT'})`));
    await driver.query(
      compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${1})`),
    );
    await driver.query(
      compile(sql`INSERT INTO res_partner (name, active) VALUES (${'Acme'}, ${true})`),
    );
    await driver.query(
      compile(
        sql`INSERT INTO sale_order (name, partner_id, company_id, amount, priority) VALUES (${'SO1'}, ${1}, ${1}, ${'5'}, ${1})`,
      ),
    );
    const plan = await planMigration({ driver, registry });
    await writeMigrationFile({ dir, name: 'sale_v3', plan });
    const result = await applyMigrations({ driver, dir, registry });
    expect(ran).toEqual(['1.2.0']);
    expect(result.hooks).toEqual([{ module: 'sale', version: '1.2.0' }]);
    expect(result.modules).toEqual([{ module: 'sale', from: '1.1.0', to: '1.2.0' }]);
    const [row] = await driver.query<{ note: string }>(
      compile(sql`SELECT note FROM sale_order WHERE name = ${'SO1'}`),
    );
    expect(row?.note).toBe('migrated');
    const again = await applyMigrations({ driver, dir, registry });
    expect(again.applied).toEqual([]);
    expect(again.hooks).toEqual([]);
    expect(ran).toEqual(['1.2.0']);
  });
});
