/**
 * Business constraints at flush points (RFC 0009 §7.1): records marked by triggers are loaded with the constraint's
 * `depends` and checked in one batch per constraint; failing records are a `ConstraintError`.
 */

import { ConstraintError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel, ResolvedConstraint } from '../model/model.js';
import type { ComputeHost, ComputeSpec } from './compute.js';

/** Ids out of what a `check` returned: a recordset, an array of records or ids, or nothing. */
export function failingIds(result: unknown): number[] {
  if (result === undefined || result === null || result === false) return [];
  const ids = (result as { ids?: unknown }).ids;
  if (Array.isArray(ids)) return ids.map(Number);
  if (Array.isArray(result)) {
    return result.flatMap((r) => {
      if (typeof r === 'number') return [r];
      const inner = (r as { ids?: unknown }).ids;
      return Array.isArray(inner) ? inner.map(Number) : [];
    });
  }
  return [];
}

function loadSpec(model: AnyModel, constraint: ResolvedConstraint): ComputeSpec {
  const fields = new Set(['id']);
  for (const key of constraint.depends) {
    const field = model.fields[key] as
      | (Field & { currencyField?: string; uomField?: string })
      | undefined;
    if (field === undefined || field.kind === 'one2many' || field.kind === 'many2many') continue;
    fields.add(key);
    if (field.currencyField !== undefined) fields.add(field.currencyField);
    if (field.uomField !== undefined) fields.add(field.uomField);
  }
  return { fields, relations: new Map<string, ComputeSpec>() };
}

/** Runs every pending constraint check. Skipped inside a recompute round (the outer flush runs it). */
export async function checkConstraints(host: ComputeHost): Promise<void> {
  const { internals } = host;
  if (internals.compute.recomputing || !internals.hasChecks()) return;
  for (const [modelName, byKey] of internals.takeToCheck()) {
    const model = internals.registry.get(modelName).model;
    for (const [key, idSet] of byKey) {
      const constraint = model.constraints.find((c) => c.key === key);
      const ids = [...idSet].filter((id) => id > 0); // drafts are never checked
      if (constraint === undefined || ids.length === 0) continue;
      await host.load(model, ids, loadSpec(model, constraint));
      const records = host.recordset(model, ids);
      const check = constraint.check as (this: unknown, records: unknown) => unknown;
      const failing = failingIds(await check.call(records, records));
      if (failing.length === 0) continue;
      const message =
        typeof constraint.message === 'string'
          ? constraint.message
          : (constraint.message as (failing: unknown) => string)(host.recordset(model, failing));
      throw new ConstraintError(model.name, key, constraint.depends, failing, message);
    }
  }
}
