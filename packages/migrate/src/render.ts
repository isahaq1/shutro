/**
 * Renders operations as DDL text. DDL can't take bind parameters, so every piece is validated before it becomes
 * text: identifiers through `sql.id` (quoted), types and defaults through strict patterns, expressions from `sql`
 * fragments that carried no parameters.
 */
import { compile, sql } from '@shutro/sql';
import type { Operation } from './diff.js';
import { MigrationError } from './errors.js';
import type { ColumnSpec, TableSpec } from './schema.js';

const TYPE = /^[a-z]+( [a-z]+)*(\(\d+(,\d+)?\))?(\[\])?$/;
const DEFAULT = /^(true|false|now\(\)|-?\d+(\.\d+)?|'(?:[^']|'')*')$/;
const METHOD = /^[a-z_]+$/;

function id(...parts: readonly string[]): string {
  return compile(sql.id(...parts)).text;
}

function type(t: string): string {
  if (!TYPE.test(t))
    throw new MigrationError(
      `${JSON.stringify(t)} is not a column type the migrator renders.`,
      'Column types come from the field builders; this should not happen.',
    );
  return t;
}

function defaultExpr(d: string): string {
  if (!DEFAULT.test(d))
    throw new MigrationError(
      `${JSON.stringify(d)} is not a default the migrator renders.`,
      'Defaults are booleans, numbers, quoted strings or now().',
    );
  return d;
}

function columnDdl(column: ColumnSpec, primaryKey: readonly string[]): string {
  const parts = [id(column.name)];
  if (column.identity) {
    parts.push('bigint GENERATED ALWAYS AS IDENTITY');
    if (primaryKey.length === 1 && primaryKey[0] === column.name) parts.push('PRIMARY KEY');
    return parts.join(' ');
  }
  parts.push(type(column.type));
  if (!column.nullable) parts.push('NOT NULL');
  if (column.default !== null) parts.push(`DEFAULT ${defaultExpr(column.default)}`);
  return parts.join(' ');
}

function createTable(table: TableSpec): string {
  const columns = Object.values(table.columns).map((c) => columnDdl(c, table.primaryKey));
  const needsPk = !(
    table.primaryKey.length === 1 && table.columns[table.primaryKey[0] ?? '']?.identity
  );
  if (needsPk && table.primaryKey.length > 0)
    columns.push(`PRIMARY KEY (${table.primaryKey.map((c) => id(c)).join(', ')})`);
  const partition =
    table.partition === undefined
      ? ''
      : ` PARTITION BY ${table.partition.by.toUpperCase()} (${id(table.partition.column)})`;
  return `CREATE TABLE ${id(table.name)} (${columns.join(', ')})${partition}`;
}

/** Renders one operation as a statement. */
export function renderOperation(op: Operation): string {
  switch (op.kind) {
    case 'createExtension':
      if (!METHOD.test(op.name))
        throw new MigrationError(
          `${JSON.stringify(op.name)} is not an extension name.`,
          'Extension names are lower-case identifiers.',
        );
      return `CREATE EXTENSION IF NOT EXISTS ${id(op.name)}`;
    case 'createTable':
      return createTable(op.table);
    case 'dropTable':
      return `DROP TABLE ${id(op.table)}`;
    case 'addColumn':
      return `ALTER TABLE ${id(op.table)} ADD COLUMN ${columnDdl(op.column, [])}`;
    case 'dropColumn':
      return `ALTER TABLE ${id(op.table)} DROP COLUMN ${id(op.column)}`;
    case 'alterType':
      return `ALTER TABLE ${id(op.table)} ALTER COLUMN ${id(op.column)} TYPE ${type(op.to)}`;
    case 'setDefault':
      return `ALTER TABLE ${id(op.table)} ALTER COLUMN ${id(op.column)} SET DEFAULT ${defaultExpr(op.default)}`;
    case 'dropDefault':
      return `ALTER TABLE ${id(op.table)} ALTER COLUMN ${id(op.column)} DROP DEFAULT`;
    case 'backfill':
      return `UPDATE ${id(op.table)} SET ${id(op.column)} = ${defaultExpr(op.default)} WHERE ${id(op.column)} IS NULL`;
    case 'setNotNull':
      return `ALTER TABLE ${id(op.table)} ALTER COLUMN ${id(op.column)} SET NOT NULL`;
    case 'dropNotNull':
      return `ALTER TABLE ${id(op.table)} ALTER COLUMN ${id(op.column)} DROP NOT NULL`;
    case 'addForeignKey':
      return `ALTER TABLE ${id(op.table)} ADD CONSTRAINT ${id(op.name)} FOREIGN KEY (${id(op.foreignKey.column)}) REFERENCES ${id(op.foreignKey.references)} (${id('id')}) ON DELETE ${op.foreignKey.onDelete}`;
    case 'addUnique':
      return `ALTER TABLE ${id(op.table)} ADD CONSTRAINT ${id(op.name)} UNIQUE (${op.columns.map((c) => id(c)).join(', ')})`;
    case 'addCheck':
      return `ALTER TABLE ${id(op.table)} ADD CONSTRAINT ${id(op.name)} CHECK (${op.expression})`;
    case 'dropConstraint':
      return `ALTER TABLE ${id(op.table)} DROP CONSTRAINT ${id(op.name)}`;
    case 'createIndex': {
      const { index } = op;
      if (!METHOD.test(index.method))
        throw new MigrationError(
          `${JSON.stringify(index.method)} is not an index method.`,
          'Use btree, gin, gist or brin.',
        );
      const columns = index.columns
        .map((c) => (index.opclass === undefined ? id(c) : `${id(c)} ${id(index.opclass)}`))
        .join(', ');
      const where = index.where === undefined ? '' : ` WHERE ${index.where}`;
      return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${id(op.name)} ON ${id(op.table)} USING ${index.method} (${columns})${where}`;
    }
    case 'dropIndex':
      return `DROP INDEX ${id(op.name)}`;
  }
}

/** Renders every operation, in order. */
export function renderOperations(operations: readonly Operation[]): string[] {
  return operations.map(renderOperation);
}
