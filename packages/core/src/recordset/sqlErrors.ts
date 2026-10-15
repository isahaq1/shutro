/**
 * Maps PostgreSQL constraint violations to typed core errors carrying the declared message (RFC 0009 §7.2).
 */

import { ConstraintViolationError, type SqlConstraintKind } from '../errors.js';
import type { Registry } from '../registry/registry.js';

const HINTS: Readonly<Record<SqlConstraintKind, string>> = {
  unique: 'Change the value so it is unique, or update the existing record instead.',
  check: 'Correct the value so it satisfies the rule.',
  exclusion: 'Change the value so it does not overlap an existing record.',
  foreign_key: 'Reference an existing record, or remove the records that still reference it first.',
};

/** The core error for a driver constraint violation, or the original error when no model declares the constraint. */
export function mapConstraintError(registry: Registry, error: unknown): unknown {
  // Shape-checked rather than instanceof: the driver's error class may come from another copy of the package.
  if (!(error instanceof Error)) return error;
  const {
    code,
    kind,
    constraint: name,
  } = error as { code?: unknown; kind?: unknown; constraint?: unknown };
  if (code !== 'CONSTRAINT_VIOLATION' || typeof name !== 'string') return error;
  if (kind !== 'unique' && kind !== 'check' && kind !== 'exclusion' && kind !== 'foreign_key')
    return error;
  for (const { model } of registry.models.values()) {
    for (const c of model.sqlConstraints) {
      if (c.name !== name) continue;
      return new ConstraintViolationError(
        model.name,
        c.key,
        kind,
        c.fields,
        c.message,
        HINTS[kind],
        {
          cause: error,
        },
      );
    }
    if (kind === 'foreign_key') {
      for (const [key, field] of Object.entries(model.fields)) {
        if (field.kind !== 'many2one' || `${model.table}_${model.columns[key] ?? ''}_fkey` !== name)
          continue;
        const target = (field as { target?: string }).target ?? '?';
        return new ConstraintViolationError(
          model.name,
          key,
          kind,
          [key],
          `'${key}' references a ${target} record that does not exist, or a ${model.name} record still references the ${target} record being deleted.`,
          HINTS.foreign_key,
          { cause: error },
        );
      }
    }
  }
  return error;
}
