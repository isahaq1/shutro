/**
 * Partitioned models (RFC 0015 §7.2): a model whose table is `PARTITION BY RANGE | LIST | HASH (key)`, for the
 * high-volume append tables of an ERP (journal items, stock moves, audit-like logs). The partitions themselves are
 * plain DDL created ahead of time with {@link partitionStatements} / {@link rangePartitions}.
 */
import { InvalidModelError } from '../errors.js';
import type { AnyModel } from './model.js';

/** How a model's table is partitioned. */
export interface PartitionSpec {
  readonly by: 'range' | 'list' | 'hash';
  /** The field key the table is partitioned on; it becomes part of the primary key. */
  readonly key: string;
}

/** One partition to create. */
export type PartitionBound =
  | { readonly name: string; readonly from: string | number; readonly to: string | number }
  | { readonly name: string; readonly values: readonly (string | number)[] }
  | { readonly name: string; readonly modulus: number; readonly remainder: number }
  | { readonly name: string; readonly default: true };

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENTIFIER.test(name) || name.length > 63) {
    throw new InvalidModelError(
      name,
      'is not a valid partition name.',
      'Use lower-case snake_case, at most 63 characters.',
    );
  }
  return `"${name}"`;
}

function literal(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new InvalidModelError(
        'partition',
        `bound ${value} is not finite.`,
        'Use finite numbers or strings.',
      );
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** `CREATE TABLE IF NOT EXISTS <name> PARTITION OF <table> FOR VALUES ...` for each bound. */
export function partitionStatements(model: AnyModel, bounds: readonly PartitionBound[]): string[] {
  const spec = model.partition;
  if (spec === undefined) {
    throw new InvalidModelError(
      model.name,
      'is not partitioned.',
      "Declare partition: { by: 'range', key: 'date' } on the model.",
    );
  }
  return bounds.map((b) => {
    let clause: string;
    if ('default' in b) clause = 'DEFAULT';
    else if ('from' in b) {
      if (spec.by !== 'range')
        throw new InvalidModelError(
          model.name,
          `partition '${b.name}' has range bounds, but the table is partitioned by ${spec.by}.`,
          'Use bounds matching the strategy.',
        );
      clause = `FOR VALUES FROM (${literal(b.from)}) TO (${literal(b.to)})`;
    } else if ('values' in b) {
      if (spec.by !== 'list')
        throw new InvalidModelError(
          model.name,
          `partition '${b.name}' has list values, but the table is partitioned by ${spec.by}.`,
          'Use bounds matching the strategy.',
        );
      clause = `FOR VALUES IN (${b.values.map(literal).join(', ')})`;
    } else {
      if (spec.by !== 'hash')
        throw new InvalidModelError(
          model.name,
          `partition '${b.name}' has hash bounds, but the table is partitioned by ${spec.by}.`,
          'Use bounds matching the strategy.',
        );
      clause = `FOR VALUES WITH (MODULUS ${Math.trunc(b.modulus)}, REMAINDER ${Math.trunc(b.remainder)})`;
    }
    return `CREATE TABLE IF NOT EXISTS ${ident(b.name)} PARTITION OF ${ident(model.table)} ${clause}`;
  });
}

/** Monthly (or yearly) range partitions covering `[from, to)`, named `<table>_YYYY_MM` / `<table>_YYYY`. */
export function rangePartitions(
  model: AnyModel,
  options: { readonly from: string; readonly to: string; readonly interval?: 'month' | 'year' },
): PartitionBound[] {
  const interval = options.interval ?? 'month';
  const [fy = 0, fm = 1] = options.from.split('-').map(Number);
  const [ty = 0, tm = 1] = options.to.split('-').map(Number);
  const out: PartitionBound[] = [];
  let y = fy;
  let m = interval === 'year' ? 1 : fm;
  const pad = (n: number): string => String(n).padStart(2, '0');
  while (y < ty || (y === ty && (interval === 'year' ? false : m < tm))) {
    const ny = interval === 'year' ? y + 1 : m === 12 ? y + 1 : y;
    const nm = interval === 'year' ? 1 : m === 12 ? 1 : m + 1;
    out.push({
      name: interval === 'year' ? `${model.table}_${y}` : `${model.table}_${y}_${pad(m)}`,
      from: `${y}-${pad(m)}-01`,
      to: `${ny}-${pad(nm)}-01`,
    });
    y = ny;
    m = nm;
  }
  return out;
}
