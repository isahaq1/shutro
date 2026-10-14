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

function columnDdl(model: AnyModel, key: string, field: Field, column: string): string {
  const parts = [ident(column)];
  if (key === 'id') {
    parts.push('bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    return parts.join(' ');
  }
  parts.push(typeName(field, model.name, key));
  if (field.required) parts.push('NOT NULL');
  if (field.kind === 'boolean' && typeof field.default === 'boolean')
    parts.push(`DEFAULT ${field.default ? 'TRUE' : 'FALSE'}`);
  if (key === 'createdAt' || key === 'updatedAt') parts.push('DEFAULT now()');
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
    tables.push(`CREATE TABLE ${ident(model.table)} (${columns.join(', ')})`);
  }

  const junctionDdl = [...junctions.values()].map(
    (j) =>
      `CREATE TABLE ${ident(j.table)} (${ident(j.sourceColumn)} bigint NOT NULL REFERENCES ${ident(j.sourceTable)} (${ident('id')}) ON DELETE CASCADE, ${ident(j.targetColumn)} bigint NOT NULL REFERENCES ${ident(j.targetTable)} (${ident('id')}) ON DELETE CASCADE, PRIMARY KEY (${ident(j.sourceColumn)}, ${ident(j.targetColumn)}))`,
  );

  return [...tables, ...foreignKeys, ...junctionDdl].map((text) =>
    Object.freeze({ text, params: Object.freeze([]) }),
  );
}
