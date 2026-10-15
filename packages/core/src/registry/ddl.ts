/**
 * Minimal DDL from models: tables, primary keys, NOT NULL, foreign keys, junction tables. A stopgap until
 * `@shutro/migrate` exists (Phase 2); used by tests and examples to create a schema from a registry.
 *
 * DDL can't take bind parameters, so statements are built as text from pieces that are validated individually:
 * identifiers through `sql.id` (quoted), type names through a strict pattern, keywords from a fixed table.
 */
import { type CompiledSql, compile, sql } from '@shutro/sql';
import { InvalidModelError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { type JunctionTable, junctionTable } from '../recordset/relations.js';
import { type Registry, targetOf } from './registry.js';

const TYPE_NAME = /^[a-z]+( [a-z]+)*(\(\d+(, ?\d+)?\))?$/;

function ident(...parts: readonly string[]): string {
  return compile(sql.id(...parts)).text;
}

function typeName(field: Field, model: string, key: string): string {
  if (!TYPE_NAME.test(field.pgType)) {
    throw new InvalidModelError(
      model,
      `field '${key}' has an unexpected column type ${JSON.stringify(field.pgType)}.`,
      'Column types come from the field builders; this should not happen.',
    );
  }
  return field.pgType;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const LITERAL_KINDS = new Set(['char', 'text', 'html', 'selection', 'state', 'date']);
const NUMERIC_KINDS = new Set(['integer', 'float', 'decimal']);

/**
 * The database-level `DEFAULT` of a column (feedback #3), in the form PostgreSQL's catalog shows it once casts are
 * stripped, so the migrator's diff is stable: `true` / `false`, unquoted non-negative numbers, quoted strings,
 * `now()` for the timestamps. `null` when the default is a function, the field is translated, encrypted, numbered,
 * computed, or a relation: those stay in the ORM.
 */
export function columnDefault(key: string, field: Field): string | null {
  if (key === 'createdAt' || key === 'updatedAt') return 'now()';
  const value: unknown = field.default;
  if (value === undefined || value === null || typeof value === 'function') return null;
  if (field.translate || field.encrypted || field.sequence !== undefined || field.computed)
    return null;
  if (field.kind === 'boolean') return typeof value === 'boolean' ? String(value) : null;
  if (NUMERIC_KINDS.has(field.kind)) {
    const text =
      typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : typeof value === 'string'
          ? value
          : null;
    // Negative constants come back as `'-1'::integer`: keep them in the ORM rather than fight the catalog.
    return text !== null && NUMBER.test(text) && !text.startsWith('-') ? text : null;
  }
  if (LITERAL_KINDS.has(field.kind) && typeof value === 'string')
    return `'${value.replaceAll("'", "''")}'`;
  return null;
}

function columnDdl(model: AnyModel, key: string, field: Field, column: string): string {
  const parts = [ident(column)];
  if (key === 'id') {
    // A partitioned table's primary key includes the partition key (RFC 0015 §7.2): declared at table level.
    parts.push(
      model.partition === undefined
        ? 'bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
        : 'bigint GENERATED ALWAYS AS IDENTITY',
    );
    return parts.join(' ');
  }
  parts.push(typeName(field, model.name, key));
  if (field.required && !field.computed) parts.push('NOT NULL'); // stored computes are filled after insert (RFC 0008 §7.6)
  const dbDefault = columnDefault(key, field);
  if (dbDefault !== null) parts.push(`DEFAULT ${dbDefault}`);
  return parts.join(' ');
}

const ON_DELETE: Readonly<Record<string, string>> = {
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  'set null': 'SET NULL',
};

/**
 * `CREATE TABLE` statements for every model in the registry, then `ALTER TABLE … ADD FOREIGN KEY` for every
 * many2one, then junction tables for many2many fields. Execute them in order.
 */
export function createTableStatements(registry: Registry): readonly CompiledSql[] {
  const tables: string[] = [];
  const foreignKeys: string[] = [];
  const constraints: string[] = [];
  const junctions = new Map<string, JunctionTable>();

  for (const { model } of registry.models.values()) {
    const columns: string[] = [];
    for (const [key, field] of Object.entries(model.fields)) {
      const column = model.columns[key];
      if (column === undefined) {
        if (field.kind === 'many2many') {
          const target = registry.get(targetOf(field) ?? '').model;
          const junction = junctionTable(model, field, target);
          junctions.set(junction.table, junction);
        }
        continue;
      }
      columns.push(columnDdl(model, key, field, column));
      if (field.kind === 'many2one') {
        const target = registry.get(targetOf(field) ?? '').model;
        const onDelete =
          ON_DELETE[(field as unknown as { ondelete: string }).ondelete] ?? 'RESTRICT';
        foreignKeys.push(
          `ALTER TABLE ${ident(model.table)} ADD CONSTRAINT ${ident(`${model.table}_${column}_fkey`)} FOREIGN KEY (${ident(column)}) REFERENCES ${ident(target.table)} (${ident('id')}) ON DELETE ${onDelete}`,
        );
      }
    }
    if (model.partition !== undefined) {
      const keyColumn = model.columns[model.partition.key] ?? '';
      columns.push(`PRIMARY KEY (${ident('id')}, ${ident(keyColumn)})`);
      tables.push(
        `CREATE TABLE ${ident(model.table)} (${columns.join(', ')}) PARTITION BY ${model.partition.by.toUpperCase()} (${ident(keyColumn)})`,
      );
    } else tables.push(`CREATE TABLE ${ident(model.table)} (${columns.join(', ')})`);
    // Declared SQL constraints (partial uniques are indexes and belong to the migrator).
    for (const c of model.sqlConstraints) {
      if (c.kind === 'unique' && c.where === undefined) {
        constraints.push(
          `ALTER TABLE ${ident(model.table)} ADD CONSTRAINT ${ident(c.name)} UNIQUE (${c.columns.map((col) => ident(col)).join(', ')})`,
        );
      } else if (c.check !== undefined) {
        const compiled = compile(c.check);
        if (compiled.params.length > 0) {
          throw new InvalidModelError(
            model.name,
            `check constraint '${c.key}' contains ${compiled.params.length} parameter(s).`,
            'DDL cannot take bind parameters: write the expression with literals only, e.g. sql`amount >= 0`.',
          );
        }
        constraints.push(
          `ALTER TABLE ${ident(model.table)} ADD CONSTRAINT ${ident(c.name)} CHECK (${compiled.text})`,
        );
      }
    }
  }

  const junctionDdl = [...junctions.values()].map(
    (j) =>
      `CREATE TABLE ${ident(j.table)} (${ident(j.sourceColumn)} bigint NOT NULL REFERENCES ${ident(j.sourceTable)} (${ident('id')}) ON DELETE CASCADE, ${ident(j.targetColumn)} bigint NOT NULL REFERENCES ${ident(j.targetTable)} (${ident('id')}) ON DELETE CASCADE, PRIMARY KEY (${ident(j.sourceColumn)}, ${ident(j.targetColumn)}))`,
  );

  return [...tables, ...foreignKeys, ...constraints, ...junctionDdl].map((text) =>
    Object.freeze({ text, params: Object.freeze([]) }),
  );
}
