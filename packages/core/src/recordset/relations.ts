/**
 * Naming of many2many junction tables (RFC 0001 §7.3: derived deterministically).
 */
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';

/** A many2many junction table and its two columns. */
export interface JunctionTable {
  readonly table: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly targetTable: string;
  readonly targetColumn: string;
}

/** `sale_order` ⟷ `sale_tag` → table `sale_order_sale_tag_rel` with `sale_order_id`, `sale_tag_id`. */
export function junctionTable(source: AnyModel, field: Field, target: AnyModel): JunctionTable {
  const relation = (field as unknown as { relation: string | undefined }).relation;
  const sourceColumn = `${source.table}_id`;
  const targetColumn =
    source.table === target.table ? `${target.table}_other_id` : `${target.table}_id`;
  return {
    table: relation ?? `${source.table}_${target.table}_rel`,
    sourceTable: source.table,
    sourceColumn,
    targetTable: target.table,
    targetColumn,
  };
}
