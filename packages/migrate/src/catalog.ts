/**
 * Reads the live schema of a PostgreSQL schema (namespace) from `pg_catalog` into the same shape as the desired
 * schema. The migration ledger tables (`shutro_*`) are left out.
 */
import type { Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import type { ColumnSpec, ForeignKeySpec, IndexSpec, LiveSchema, TableSpec } from './schema.js';

const ON_DELETE: Readonly<Record<string, ForeignKeySpec['onDelete']>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
};

/** `'x'::character varying` → `'x'`, `(0)::numeric` → `0`, `now()` unchanged. */
export function normalizeDefault(expression: string | null): string | null {
  if (expression === null) return null;
  let e = expression.trim();
  e = e.replace(/::[a-z_ ]+(\([^)]*\))?(\[\])?$/i, '');
  while (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1);
  return e;
}

/** Reads tables, columns, constraints and indexes of `schema` (default `public`). */
export async function readLiveSchema(driver: Driver, schema = 'public'): Promise<LiveSchema> {
  const tables: Record<
    string,
    {
      columns: Record<string, ColumnSpec>;
      primaryKey: string[];
      foreignKeys: Record<string, ForeignKeySpec>;
      uniques: Record<string, string[]>;
      checks: Record<string, string>;
      indexes: Record<string, IndexSpec>;
    }
  > = {};
  const tableRows = await driver.query<{ name: string }>(
    compile(
      sql`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`,
    ),
  );
  for (const { name } of tableRows) {
    if (name.startsWith('shutro_')) continue;
    tables[name] = {
      columns: {},
      primaryKey: [],
      foreignKeys: {},
      uniques: {},
      checks: {},
      indexes: {},
    };
  }

  const columnRows = await driver.query<{
    table: string;
    name: string;
    type: string;
    notnull: boolean;
    identity: string;
    def: string | null;
  }>(
    compile(sql`SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.attidentity AS identity,
        pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`),
  );
  for (const row of columnRows) {
    const table = tables[row.table];
    if (table === undefined) continue;
    table.columns[row.name] = {
      name: row.name,
      type: row.type,
      nullable: !row.notnull,
      default: normalizeDefault(row.def),
      identity: row.identity === 'a' || row.identity === 'd',
      backfill: null,
    };
  }

  const constraintRows = await driver.query<{
    table: string;
    name: string;
    type: string;
    def: string;
    ondelete: string | null;
    columns: string[] | null;
    ftable: string | null;
  }>(
    compile(sql`SELECT c.relname AS "table", con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS def, con.confdeltype AS ondelete,
        (SELECT array_agg(a.attname ORDER BY k.ordinality) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
        fc.relname AS ftable
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class fc ON fc.oid = con.confrelid
      WHERE n.nspname = ${schema}
      ORDER BY c.relname, con.conname`),
  );
  for (const row of constraintRows) {
    const table = tables[row.table];
    if (table === undefined) continue;
    const columns = row.columns ?? [];
    switch (row.type) {
      case 'p':
        table.primaryKey = columns;
        break;
      case 'f':
        table.foreignKeys[row.name] = {
          column: columns[0] ?? '',
          references: row.ftable ?? '',
          onDelete: ON_DELETE[row.ondelete ?? 'a'] ?? 'NO ACTION',
        };
        break;
      case 'u':
        table.uniques[row.name] = columns;
        break;
      case 'c':
        table.checks[row.name] = row.def.replace(/^CHECK \((.*)\)$/s, '$1');
        break;
      default:
        break;
    }
  }

  const indexRows = await driver.query<{
    table: string;
    name: string;
    unique: boolean;
    method: string;
    columns: string[] | null;
    def: string;
    partial: boolean;
  }>(
    compile(sql`SELECT t.relname AS "table", i.relname AS name, ix.indisunique AS "unique", am.amname AS method,
        (SELECT array_agg(a.attname ORDER BY k.ordinality) FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ordinality)
           JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum) AS columns,
        pg_get_indexdef(ix.indexrelid) AS def, ix.indpred IS NOT NULL AS partial
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = ${schema} AND NOT ix.indisprimary
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid)
      ORDER BY t.relname, i.relname`),
  );
  for (const row of indexRows) {
    const table = tables[row.table];
    if (table === undefined) continue;
    const opclass = /gin_trgm_ops/.test(row.def) ? 'gin_trgm_ops' : undefined;
    const where = row.partial ? (/ WHERE \((.*)\)$/s.exec(row.def)?.[1] ?? '') : undefined;
    table.indexes[row.name] = {
      columns: row.columns ?? [],
      unique: row.unique,
      method: row.method,
      ...(opclass === undefined ? {} : { opclass }),
      ...(where === undefined ? {} : { where }),
    };
  }

  const extensionRows = await driver.query<{ name: string }>(
    compile(sql`SELECT extname AS name FROM pg_extension ORDER BY extname`),
  );
  const result: Record<string, TableSpec> = {};
  for (const [name, t] of Object.entries(tables)) result[name] = { name, ...t };
  return { tables: result, extensions: extensionRows.map((r) => r.name) };
}
