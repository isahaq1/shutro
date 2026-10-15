/**
 * Diffs the desired schema against the live one into an ordered list of operations. Destructive operations
 * (drops, type changes) are marked so that applying them needs explicit consent.
 */
import type {
  ColumnSpec,
  ForeignKeySpec,
  IndexSpec,
  LiveSchema,
  Schema,
  TableSpec,
} from './schema.js';

/** One schema change. */
export type Operation =
  | { readonly kind: 'createExtension'; readonly name: string; readonly destructive: false }
  | { readonly kind: 'createTable'; readonly table: TableSpec; readonly destructive: false }
  | { readonly kind: 'dropTable'; readonly table: string; readonly destructive: true }
  | {
      readonly kind: 'addColumn';
      readonly table: string;
      readonly column: ColumnSpec;
      readonly destructive: false;
    }
  | {
      readonly kind: 'dropColumn';
      readonly table: string;
      readonly column: string;
      readonly destructive: true;
    }
  | {
      readonly kind: 'alterType';
      readonly table: string;
      readonly column: string;
      readonly from: string;
      readonly to: string;
      readonly destructive: true;
    }
  | {
      readonly kind: 'setDefault';
      readonly table: string;
      readonly column: string;
      readonly default: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'dropDefault';
      readonly table: string;
      readonly column: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'backfill';
      readonly table: string;
      readonly column: string;
      readonly default: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'setNotNull';
      readonly table: string;
      readonly column: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'dropNotNull';
      readonly table: string;
      readonly column: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'addForeignKey';
      readonly table: string;
      readonly name: string;
      readonly foreignKey: ForeignKeySpec;
      readonly destructive: false;
    }
  | {
      readonly kind: 'addUnique';
      readonly table: string;
      readonly name: string;
      readonly columns: readonly string[];
      readonly destructive: false;
    }
  | {
      readonly kind: 'addCheck';
      readonly table: string;
      readonly name: string;
      readonly expression: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'dropConstraint';
      readonly table: string;
      readonly name: string;
      readonly destructive: false;
    }
  | {
      readonly kind: 'createIndex';
      readonly table: string;
      readonly name: string;
      readonly index: IndexSpec;
      readonly destructive: false;
    }
  | { readonly kind: 'dropIndex'; readonly name: string; readonly destructive: false };

function sameIndex(a: IndexSpec, b: IndexSpec): boolean {
  return (
    a.unique === b.unique &&
    a.method === b.method &&
    a.columns.join(',') === b.columns.join(',') &&
    (a.opclass ?? '') === (b.opclass ?? '') &&
    (a.where ?? '') === (b.where ?? '')
  );
}

function sameForeignKey(a: ForeignKeySpec, b: ForeignKeySpec): boolean {
  return a.column === b.column && a.references === b.references && a.onDelete === b.onDelete;
}

/** Computes the operations that turn `live` into `desired`, in a safe order. */
export function diffSchema(desired: Schema, live: LiveSchema): Operation[] {
  const early: Operation[] = []; // extensions, tables, columns
  const constraints: Operation[] = []; // drops of changed constraints/indexes, then adds (FKs after all tables exist)
  const indexes: Operation[] = [];
  const late: Operation[] = []; // destructive drops last

  for (const ext of desired.extensions)
    if (!live.extensions.includes(ext))
      early.push({ kind: 'createExtension', name: ext, destructive: false });

  for (const [name, table] of Object.entries(desired.tables)) {
    const current = live.tables[name];
    if (current === undefined) {
      early.push({ kind: 'createTable', table, destructive: false });
      for (const [fkName, fk] of Object.entries(table.foreignKeys))
        constraints.push({
          kind: 'addForeignKey',
          table: name,
          name: fkName,
          foreignKey: fk,
          destructive: false,
        });
      for (const [uName, columns] of Object.entries(table.uniques))
        constraints.push({
          kind: 'addUnique',
          table: name,
          name: uName,
          columns,
          destructive: false,
        });
      for (const [cName, expression] of Object.entries(table.checks))
        constraints.push({
          kind: 'addCheck',
          table: name,
          name: cName,
          expression,
          destructive: false,
        });
      for (const [iName, index] of Object.entries(table.indexes))
        indexes.push({ kind: 'createIndex', table: name, name: iName, index, destructive: false });
      continue;
    }

    for (const [colName, column] of Object.entries(table.columns)) {
      const existing = current.columns[colName];
      if (existing === undefined) {
        early.push({ kind: 'addColumn', table: name, column, destructive: false });
        continue;
      }
      if (existing.type !== column.type)
        early.push({
          kind: 'alterType',
          table: name,
          column: colName,
          from: existing.type,
          to: column.type,
          destructive: true,
        });
      if ((existing.default ?? null) !== (column.default ?? null)) {
        if (column.default === null)
          early.push({ kind: 'dropDefault', table: name, column: colName, destructive: false });
        else
          early.push({
            kind: 'setDefault',
            table: name,
            column: colName,
            default: column.default,
            destructive: false,
          });
      }
      if (existing.nullable && !column.nullable) {
        if (column.backfill !== null)
          early.push({
            kind: 'backfill',
            table: name,
            column: colName,
            default: column.backfill,
            destructive: false,
          });
        early.push({ kind: 'setNotNull', table: name, column: colName, destructive: false });
      } else if (!existing.nullable && column.nullable) {
        early.push({ kind: 'dropNotNull', table: name, column: colName, destructive: false });
      }
    }
    for (const colName of Object.keys(current.columns)) {
      if (table.columns[colName] === undefined)
        late.push({ kind: 'dropColumn', table: name, column: colName, destructive: true });
    }

    for (const [fkName, fk] of Object.entries(current.foreignKeys)) {
      const wanted = table.foreignKeys[fkName];
      if (wanted === undefined || !sameForeignKey(wanted, fk))
        constraints.push({ kind: 'dropConstraint', table: name, name: fkName, destructive: false });
    }
    for (const [fkName, fk] of Object.entries(table.foreignKeys)) {
      const existing = current.foreignKeys[fkName];
      if (existing === undefined || !sameForeignKey(existing, fk))
        constraints.push({
          kind: 'addForeignKey',
          table: name,
          name: fkName,
          foreignKey: fk,
          destructive: false,
        });
    }
    for (const [uName, columns] of Object.entries(current.uniques)) {
      const wanted = table.uniques[uName];
      if (wanted === undefined || wanted.join(',') !== columns.join(','))
        constraints.push({ kind: 'dropConstraint', table: name, name: uName, destructive: false });
    }
    for (const [uName, columns] of Object.entries(table.uniques)) {
      const existing = current.uniques[uName];
      if (existing === undefined || existing.join(',') !== columns.join(','))
        constraints.push({
          kind: 'addUnique',
          table: name,
          name: uName,
          columns,
          destructive: false,
        });
    }
    for (const cName of Object.keys(current.checks)) {
      if (table.checks[cName] === undefined)
        constraints.push({ kind: 'dropConstraint', table: name, name: cName, destructive: false });
    }
    for (const [cName, expression] of Object.entries(table.checks)) {
      if (current.checks[cName] === undefined)
        constraints.push({
          kind: 'addCheck',
          table: name,
          name: cName,
          expression,
          destructive: false,
        });
    }
    for (const [iName, index] of Object.entries(current.indexes)) {
      const wanted = table.indexes[iName];
      if (wanted === undefined || !sameIndex(wanted, index))
        constraints.push({ kind: 'dropIndex', name: iName, destructive: false });
    }
    for (const [iName, index] of Object.entries(table.indexes)) {
      const existing = current.indexes[iName];
      if (existing === undefined || !sameIndex(existing, index))
        indexes.push({ kind: 'createIndex', table: name, name: iName, index, destructive: false });
    }
  }

  for (const name of Object.keys(live.tables)) {
    if (desired.tables[name] === undefined)
      late.push({ kind: 'dropTable', table: name, destructive: true });
  }

  return [...early, ...constraints, ...indexes, ...late];
}
