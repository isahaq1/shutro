/**
 * The intended database schema, derived from a registry (RFC 0001 §7.5 naming, RFC 0002 origins). The same shape
 * describes the live schema read from `pg_catalog`, so the two can be diffed directly.
 */
import { type Field, junctionTable, type Registry, snakeCase, targetOf } from '@shutro/core';
import { compile, type SqlFragment } from '@shutro/sql';
import { MigrationError } from './errors.js';

/** A column as PostgreSQL reports it (`format_type`), e.g. `numeric(32,2)`, `timestamp with time zone`. */
export interface ColumnSpec {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  /** Database-level default expression (`true`, `1`, `now()`), or `null`. */
  readonly default: string | null;
  readonly identity: boolean;
  /** Literal used to backfill existing rows when the column becomes NOT NULL (desired schema only). */
  readonly backfill: string | null;
}

/** A foreign key. */
export interface ForeignKeySpec {
  readonly column: string;
  readonly references: string;
  readonly onDelete: 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION';
}

/** An index. */
export interface IndexSpec {
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly method: string;
  readonly opclass?: string;
  readonly where?: string;
}

/** A table. Constraint and index names are the keys. */
export interface TableSpec {
  readonly name: string;
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  readonly primaryKey: readonly string[];
  readonly foreignKeys: Readonly<Record<string, ForeignKeySpec>>;
  readonly uniques: Readonly<Record<string, readonly string[]>>;
  /** Check constraints by name. Expressions are compared by name only (PostgreSQL normalizes them). */
  readonly checks: Readonly<Record<string, string>>;
  readonly indexes: Readonly<Record<string, IndexSpec>>;
  /** `PARTITION BY` of a partitioned table (RFC 0015 §7.2). Partitions themselves are not diffed. */
  readonly partition?: { readonly by: 'range' | 'list' | 'hash'; readonly column: string };
}

/** A whole schema: tables by name, plus required extensions. */
export interface Schema {
  readonly tables: Readonly<Record<string, TableSpec>>;
  readonly extensions: readonly string[];
}
/** The schema as read from the database (same shape). */
export type LiveSchema = Schema;

/** Maps the builders' type spellings to `format_type` output. */
export function canonicalType(pgType: string): string {
  const m = /^varchar\((\d+)\)$/.exec(pgType);
  if (m) return `character varying(${m[1]})`;
  if (pgType === 'timestamptz') return 'timestamp with time zone';
  return pgType.replace(/\s+/g, ' ').replace(/numeric\((\d+), ?(\d+)\)/, 'numeric($1,$2)');
}

/** A SQL literal for a backfill (`'x'`, `1`, `true`). */
export function literalOf(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toFixed?: unknown }).toFixed === 'function'
  )
    return `'${(value as { toFixed: () => string }).toFixed()}'`;
  return null;
}

function fragmentText(fragment: SqlFragment, what: string): string {
  const compiled = compile(fragment);
  if (compiled.params.length > 0) {
    throw new MigrationError(
      `${what} contains ${compiled.params.length} parameter(s).`,
      'DDL cannot take bind parameters: write the expression with literals only, e.g. sql`amount >= 0`.',
    );
  }
  return compiled.text;
}

function columnOf(key: string, field: Field, column: string): ColumnSpec {
  if (key === 'id')
    return {
      name: column,
      type: 'bigint',
      nullable: false,
      default: null,
      identity: true,
      backfill: null,
    };
  const type = field.kind === 'many2one' ? 'bigint' : canonicalType(field.pgType);
  let dbDefault: string | null = null;
  if (key === 'createdAt' || key === 'updatedAt') dbDefault = 'now()';
  else if (field.kind === 'boolean' && typeof field.default === 'boolean')
    dbDefault = field.default ? 'true' : 'false';
  else if (field.kind === 'integer' && typeof field.default === 'number')
    dbDefault = String(field.default);
  const backfill = typeof field.default === 'function' ? null : literalOf(field.default);
  return {
    name: column,
    type,
    nullable: !field.required || field.computed, // stored computes are filled after insert (RFC 0008 §7.6)
    default: dbDefault,
    identity: false,
    backfill,
  };
}

const ON_DELETE: Readonly<Record<string, ForeignKeySpec['onDelete']>> = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  'set null': 'SET NULL',
};

/** Builds the intended schema for every model in the registry. */
export function desiredSchema(registry: Registry): Schema {
  const tables: Record<string, TableSpec> = {};
  const extensions = new Set<string>();

  for (const { model } of registry.models.values()) {
    const columns: Record<string, ColumnSpec> = {};
    const foreignKeys: Record<string, ForeignKeySpec> = {};
    const indexes: Record<string, IndexSpec> = {};
    for (const [key, field] of Object.entries(model.fields)) {
      const column = model.columns[key];
      if (column === undefined) {
        if (field.kind === 'many2many') {
          const target = registry.get(targetOf(field) ?? '').model;
          const j = junctionTable(model, field, target);
          tables[j.table] = {
            name: j.table,
            columns: {
              [j.sourceColumn]: {
                name: j.sourceColumn,
                type: 'bigint',
                nullable: false,
                default: null,
                identity: false,
                backfill: null,
              },
              [j.targetColumn]: {
                name: j.targetColumn,
                type: 'bigint',
                nullable: false,
                default: null,
                identity: false,
                backfill: null,
              },
            },
            primaryKey: [j.sourceColumn, j.targetColumn],
            foreignKeys: {
              [`${j.table}_${j.sourceColumn}_fkey`]: {
                column: j.sourceColumn,
                references: j.sourceTable,
                onDelete: 'CASCADE',
              },
              [`${j.table}_${j.targetColumn}_fkey`]: {
                column: j.targetColumn,
                references: j.targetTable,
                onDelete: 'CASCADE',
              },
            },
            uniques: {},
            checks: {},
            indexes: {},
          };
        }
        continue;
      }
      columns[column] = columnOf(key, field, column);
      if (field.kind === 'many2one') {
        const target = registry.get(targetOf(field) ?? '').model;
        foreignKeys[`${model.table}_${column}_fkey`] = {
          column,
          references: target.table,
          onDelete: ON_DELETE[(field as unknown as { ondelete: string }).ondelete] ?? 'RESTRICT',
        };
      }
      if (field.index !== undefined && key !== 'id') {
        const name = `${model.table}_${column}_idx`;
        if (field.index === 'trigram') {
          extensions.add('pg_trgm');
          indexes[name] = {
            columns: [column],
            unique: false,
            method: 'gin',
            opclass: 'gin_trgm_ops',
          };
        } else if (field.index === 'brin')
          indexes[name] = { columns: [column], unique: false, method: 'brin' };
        else
          indexes[name] = { columns: [column], unique: field.index === 'unique', method: 'btree' };
      }
    }
    for (const index of model.indexes) {
      indexes[index.name] = {
        columns: [...index.columns],
        unique: index.unique,
        method: index.method,
        ...(index.where === undefined
          ? {}
          : { where: fragmentText(index.where, `index ${index.name}`) }),
      };
    }
    const uniques: Record<string, readonly string[]> = {};
    const checks: Record<string, string> = {};
    for (const c of model.sqlConstraints) {
      if (c.kind === 'unique') {
        if (c.where !== undefined) {
          // A partial unique constraint is a unique partial index in PostgreSQL.
          indexes[c.name] = {
            columns: [...c.columns],
            unique: true,
            method: 'btree',
            where: fragmentText(c.where, `constraint ${c.name}`),
          };
        } else uniques[c.name] = [...c.columns];
      } else if (c.check !== undefined)
        checks[c.name] = fragmentText(c.check, `constraint ${c.name}`);
    }
    tables[model.table] = {
      name: model.table,
      columns,
      primaryKey:
        model.partition === undefined ? ['id'] : ['id', model.columns[model.partition.key] ?? ''],
      foreignKeys,
      uniques,
      checks,
      indexes,
      ...(model.partition === undefined
        ? {}
        : {
            partition: { by: model.partition.by, column: model.columns[model.partition.key] ?? '' },
          }),
    };
  }

  return { tables, extensions: [...extensions].sort() };
}

/** Column name of a field key, as `defineModel` derives it (exported for callers building names). */
export function columnName(key: string, many2one: boolean): string {
  const snake = snakeCase(key);
  return many2one ? `${snake}_id` : snake;
}
