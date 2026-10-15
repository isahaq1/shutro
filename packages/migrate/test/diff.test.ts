/**
 * The pure parts: desired schema from a registry, diff against a live schema, DDL rendering.
 */
import { buildRegistry, defineModel, defineModule, f } from '@shutro/core';
import { sql } from '@shutro/sql';
import { describe, expect, test } from 'vitest';
import {
  desiredSchema,
  diffSchema,
  type LiveSchema,
  renderOperations,
  type Schema,
} from '../src/index.js';

function registryOf(
  extra: Parameters<typeof defineModel>[1]['fields'] = {},
  options: Record<string, unknown> = {},
) {
  const base = defineModule({
    name: 'base',
    models: [
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
        fields: {
          name: f.char({ required: true, index: true }),
          email: f.char({ index: 'unique' }),
        },
      }),
    ],
  });
  const sale = defineModule({
    name: 'sale',
    depends: [base],
    models: [
      defineModel('sale.tag', { fields: { name: f.char({ required: true }) } }),
      defineModel('sale.order', {
        companyScoped: { required: true },
        fields: {
          name: f.char({ required: true, size: 64 }),
          partner: f.many2one('res.partner', { required: true }),
          amount: f.decimal({ scale: 2, required: true, default: '0' }),
          note: f.text(),
          dateOrder: f.datetime(),
          tags: f.many2many('sale.tag'),
          ...extra,
        },
        sqlConstraints: {
          positiveAmount: { check: sql`amount >= 0`, message: 'Amount must be positive.' },
        },
        indexes: [{ fields: ['partner', 'dateOrder'] }],
        ...options,
      }),
    ],
  });
  return buildRegistry({ modules: [sale] });
}

describe('desiredSchema', () => {
  test('tables, columns, keys, constraints, indexes and junction tables from the registry', () => {
    const schema = desiredSchema(registryOf());
    const order = schema.tables['sale_order'];
    expect(order).toBeDefined();
    expect(order?.columns['id']).toMatchObject({ type: 'bigint', nullable: false, identity: true });
    expect(order?.columns['name']).toMatchObject({
      type: 'character varying(64)',
      nullable: false,
    });
    expect(order?.columns['amount']).toMatchObject({
      type: 'numeric(32,2)',
      nullable: false,
      default: null,
    });
    expect(order?.columns['created_at']).toMatchObject({
      type: 'timestamp with time zone',
      nullable: false,
      default: 'now()',
    });
    expect(order?.columns['partner_id']).toMatchObject({ type: 'bigint', nullable: false });
    expect(order?.columns['company_id']).toMatchObject({ type: 'bigint', nullable: false });
    expect(order?.foreignKeys['sale_order_partner_id_fkey']).toEqual({
      column: 'partner_id',
      references: 'res_partner',
      onDelete: 'RESTRICT',
    });
    expect(order?.foreignKeys['sale_order_created_by_id_fkey']).toMatchObject({
      references: 'res_users',
      onDelete: 'SET NULL',
    });
    expect(order?.checks['sale_order_positive_amount']).toBe('amount >= 0');
    expect(order?.indexes['sale_order_partner_id_date_order_idx']).toMatchObject({
      columns: ['partner_id', 'date_order'],
      unique: false,
      method: 'btree',
    });
    expect(schema.tables['res_partner']?.columns['active']).toMatchObject({
      type: 'boolean',
      nullable: false,
      default: 'true',
    });
    expect(schema.tables['res_partner']?.indexes['res_partner_name_idx']).toMatchObject({
      columns: ['name'],
      unique: false,
    });
    expect(schema.tables['res_partner']?.indexes['res_partner_email_idx']).toMatchObject({
      columns: ['email'],
      unique: true,
    });
    const junction = schema.tables['sale_order_sale_tag_rel'];
    expect(junction?.primaryKey).toEqual(['sale_order_id', 'sale_tag_id']);
    expect(junction?.foreignKeys['sale_order_sale_tag_rel_sale_order_id_fkey']).toMatchObject({
      references: 'sale_order',
      onDelete: 'CASCADE',
    });
    expect(schema.extensions).toEqual([]);
  });

  test('a check constraint with parameters is rejected', () => {
    const registry = registryOf(
      {},
      { sqlConstraints: { bad: { check: sql`amount >= ${0}`, message: 'x' } } },
    );
    expect(() => desiredSchema(registry)).toThrow(/parameter/);
  });

  test('trigram indexes need the pg_trgm extension', () => {
    const schema = desiredSchema(registryOf({ ref: f.char({ index: 'trigram' }) }));
    expect(schema.extensions).toEqual(['pg_trgm']);
    expect(schema.tables['sale_order']?.indexes['sale_order_ref_idx']).toMatchObject({
      method: 'gin',
      opclass: 'gin_trgm_ops',
    });
  });
});

describe('diffSchema', () => {
  const empty: LiveSchema = { tables: {}, extensions: [] };

  test('an empty database gets every table, then foreign keys, then indexes', () => {
    const ops = diffSchema(desiredSchema(registryOf()), empty);
    const kinds = ops.map((o) => o.kind);
    expect(kinds.filter((k) => k === 'createTable').length).toBe(7); // 6 models + 1 junction
    expect(kinds.indexOf('addForeignKey')).toBeGreaterThan(kinds.lastIndexOf('createTable'));
    expect(kinds.indexOf('createIndex')).toBeGreaterThan(kinds.lastIndexOf('addForeignKey'));
    expect(ops.some((o) => o.destructive)).toBe(false);
  });

  test('identical schemas produce no operations', () => {
    const desired = desiredSchema(registryOf());
    expect(diffSchema(desired, desired as unknown as Schema)).toEqual([]);
  });

  test('column changes: add, drop (destructive), type (destructive), nullability with backfill, default', () => {
    const before = desiredSchema(registryOf({ old: f.char(), note2: f.text() }));
    const after = desiredSchema(
      registryOf(
        { extra: f.integer({ required: true, default: 0 }), note2: f.char({ size: 10 }) },
        {},
      ),
    );
    const ops = diffSchema(after, before as unknown as LiveSchema);
    expect(ops).toContainEqual({
      kind: 'addColumn',
      table: 'sale_order',
      column: expect.objectContaining({ name: 'extra', type: 'integer', nullable: false }),
      destructive: false,
    });
    expect(ops).toContainEqual({
      kind: 'dropColumn',
      table: 'sale_order',
      column: 'old',
      destructive: true,
    });
    expect(ops).toContainEqual({
      kind: 'alterType',
      table: 'sale_order',
      column: 'note2',
      from: 'text',
      to: 'character varying(10)',
      destructive: true,
    });
    const nullable = desiredSchema(registryOf({ code: f.char() }));
    const required = desiredSchema(registryOf({ code: f.char({ required: true, default: 'x' }) }));
    const tighten = diffSchema(required, nullable as unknown as LiveSchema);
    expect(tighten.map((o) => o.kind)).toEqual(['backfill', 'setNotNull']);
    const relax = diffSchema(nullable, required as unknown as LiveSchema);
    expect(relax.map((o) => o.kind)).toEqual(['dropNotNull']);
  });

  test('constraint and index changes', () => {
    const before = desiredSchema(registryOf());
    const after = desiredSchema(registryOf({ ref: f.char({ index: true }) }, { indexes: [] }));
    const ops = diffSchema(after, before as unknown as LiveSchema);
    expect(ops.map((o) => o.kind).sort()).toEqual(['addColumn', 'createIndex', 'dropIndex']);
    const noCheck = desiredSchema(registryOf({}, { sqlConstraints: {} }));
    expect(diffSchema(noCheck, before as unknown as LiveSchema).map((o) => o.kind)).toEqual([
      'dropConstraint',
    ]);
  });

  test('tables the registry does not know are reported as destructive drops', () => {
    const live: LiveSchema = {
      ...(desiredSchema(registryOf()) as unknown as LiveSchema),
      tables: {
        ...(desiredSchema(registryOf()) as unknown as LiveSchema).tables,
        legacy: {
          name: 'legacy',
          columns: {},
          primaryKey: [],
          foreignKeys: {},
          uniques: {},
          checks: {},
          indexes: {},
        },
      },
    };
    const ops = diffSchema(desiredSchema(registryOf()), live);
    expect(ops).toEqual([{ kind: 'dropTable', table: 'legacy', destructive: true }]);
  });
});

describe('renderOperations', () => {
  test('DDL text with quoted identifiers; destructive statements are marked', () => {
    const ops = diffSchema(desiredSchema(registryOf()), { tables: {}, extensions: [] });
    const statements = renderOperations(ops);
    expect(statements[0]).toMatch(
      /^CREATE TABLE "res_users" \("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "created_at" timestamp with time zone NOT NULL DEFAULT now\(\), /,
    );
    expect(statements).toContainEqual(
      'ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "res_partner" ("id") ON DELETE RESTRICT',
    );
    expect(statements).toContainEqual(
      'ALTER TABLE "sale_order" ADD CONSTRAINT "sale_order_positive_amount" CHECK (amount >= 0)',
    );
    expect(statements).toContainEqual(
      'CREATE INDEX "sale_order_partner_id_date_order_idx" ON "sale_order" USING btree ("partner_id", "date_order")',
    );
    expect(statements).toContainEqual(
      'CREATE UNIQUE INDEX "res_partner_email_idx" ON "res_partner" USING btree ("email")',
    );
    const drop = renderOperations([
      { kind: 'dropColumn', table: 'sale_order', column: 'old', destructive: true },
    ]);
    expect(drop).toEqual(['ALTER TABLE "sale_order" DROP COLUMN "old"']);
    const backfill = renderOperations([
      { kind: 'backfill', table: 'sale_order', column: 'code', default: "'x'", destructive: false },
      { kind: 'setNotNull', table: 'sale_order', column: 'code', destructive: false },
    ]);
    expect(backfill).toEqual([
      'UPDATE "sale_order" SET "code" = \'x\' WHERE "code" IS NULL',
      'ALTER TABLE "sale_order" ALTER COLUMN "code" SET NOT NULL',
    ]);
  });
});
