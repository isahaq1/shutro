/**
 * The compute engine at runtime (RFC 0008): trigger invalidation through the cache, resolution of triggers into the
 * affected records (database + cache), batched recompute in rank order before flushes, computation of non-stored
 * fields on load, and the assignment protocol inside computes.
 */

import { compile, sql } from '@shutro/sql';
import type { ComputedField, PathStep, Trigger } from '../compute/graph.js';
import type { ScopeInternals } from '../env/env.js';
import { ComputeAssignmentError, RecomputeLimitError, ValidationError } from '../errors.js';
import type { Field } from '../model/field.js';
import { type AnyModel, defaultDisplayName } from '../model/model.js';
import { isTracked, trackChange } from './audit.js';
import { junctionTable } from './relations.js';
import { normalize } from './values.js';

const MAX_ROUNDS = 100;

/** A load spec as the loader understands it (same shape as its normalized specs). */
export interface ComputeSpec {
  readonly fields: ReadonlySet<string>;
  readonly relations: ReadonlyMap<string, ComputeSpec>;
}

/** What the engine needs from the recordset runtime (passed in to avoid a module cycle). */
export interface ComputeHost {
  readonly internals: ScopeInternals;
  load(model: AnyModel, ids: readonly number[], spec: ComputeSpec): Promise<void>;
  /** Loads the `Currency` / `Uom` objects the monetary / quantity `fields` of the records refer to. */
  valueObjects(model: AnyModel, ids: readonly number[], fields: ReadonlySet<string>): Promise<void>;
  values(model: string, id: number, create?: boolean): Map<string, unknown> | undefined;
  /** A recordset of `ids` (one prefetch group) to pass to compute functions. */
  recordset(model: AnyModel, ids: readonly number[]): unknown;
}

type IdSets = Map<string, Map<string, Set<number>>>;

function addAll(sets: IdSets, model: string, key: string, ids: Iterable<number>): void {
  let byKey = sets.get(model);
  if (byKey === undefined) {
    byKey = new Map();
    sets.set(model, byKey);
  }
  let set = byKey.get(key);
  if (set === undefined) {
    set = new Set();
    byKey.set(key, set);
  }
  for (const id of ids) set.add(id);
}

function name(field: ComputedField): string {
  return `${field.model}.${field.key}`;
}

function isProtected(internals: ScopeInternals, field: ComputedField, id: number): boolean {
  return internals.compute.protected.get(name(field))?.has(id) ?? false;
}

// --------------------------------------------------------------------------------------- reverse resolution

/** Walks one step backwards: from ids of the step's target model to ids of `step.model`. */
async function stepBack(
  internals: ScopeInternals,
  step: PathStep,
  ids: ReadonlySet<number>,
  viaDb: boolean,
): Promise<Set<number>> {
  const out = new Set<number>();
  if (ids.size === 0) return out;
  const model = internals.registry.get(step.model).model;
  const cached = internals.cache.records.get(step.model);
  if (step.kind === 'many2one') {
    if (cached !== undefined) {
      for (const [id, values] of cached) {
        const v = values.get(step.key);
        if (typeof v === 'number' && ids.has(v)) out.add(id);
      }
    }
    if (viaDb) {
      const column = model.columns[step.key] ?? '';
      const rows = await internals.query<{ id: number }>(
        compile(
          sql`SELECT ${sql.id('id')} FROM ${sql.id(model.table)} WHERE ${sql.id(column)} = ANY(${sql.array([...ids], 'bigint')})`,
        ),
      );
      for (const r of rows) out.add(Number(r.id));
    }
    return out;
  }
  if (step.kind === 'one2many') {
    const target = internals.registry.get(step.target ?? '').model;
    const inverse = step.inverse ?? '';
    const missing: number[] = [];
    for (const id of ids) {
      const values = internals.cache.records.get(target.name)?.get(id);
      if (values?.has(inverse)) {
        const parent = values.get(inverse);
        if (typeof parent === 'number') out.add(parent);
      } else missing.push(id);
    }
    if (viaDb && missing.length > 0) {
      // Rows that no longer exist are simply absent: their parents were triggered by the delete itself.
      const column = target.columns[inverse] ?? '';
      const rows = await internals.query<{ parent: number | null }>(
        compile(
          sql`SELECT ${sql.id(column)} AS ${sql.id('parent')} FROM ${sql.id(target.table)} WHERE ${sql.id('id')} = ANY(${sql.array(missing, 'bigint')})`,
        ),
      );
      for (const r of rows) if (r.parent !== null) out.add(Number(r.parent));
    }
    return out;
  }
  // many2many
  if (cached !== undefined) {
    for (const [id, values] of cached) {
      const list = values.get(step.key);
      if (Array.isArray(list) && list.some((c) => ids.has(Number(c)))) out.add(id);
    }
  }
  if (viaDb) {
    const target = internals.registry.get(step.target ?? '').model;
    const j = junctionTable(model, model.fields[step.key] as Field, target);
    const rows = await internals.query<{ src: number }>(
      compile(
        sql`SELECT ${sql.id(j.sourceColumn)} AS ${sql.id('src')} FROM ${sql.id(j.table)} WHERE ${sql.id(j.targetColumn)} = ANY(${sql.array([...ids], 'bigint')})`,
      ),
    );
    for (const r of rows) out.add(Number(r.src));
  }
  return out;
}

/** The records of the trigger's computed field reached from changed `ids`. */
async function resolve(
  internals: ScopeInternals,
  trigger: Trigger,
  ids: Iterable<number>,
  viaDb: boolean,
): Promise<Set<number>> {
  let current = new Set(ids);
  for (let i = trigger.reverse.length - 1; i >= 0; i--) {
    const step = trigger.reverse[i] as PathStep;
    current = await stepBack(internals, step, current, viaDb);
    if (current.size === 0) break;
  }
  return current;
}

// -------------------------------------------------------------------------------------------- invalidation

/** Drops the cached values of the dependents of `(model, key)` that are in the cache (RFC 0008 §7.2). Cache only. */
export function invalidateCached(
  internals: ScopeInternals,
  model: string,
  key: string,
  ids: readonly number[],
): void {
  const triggers = internals.registry.compute.triggers.get(model)?.get(key);
  if (triggers === undefined || ids.length === 0) return;
  for (const trigger of triggers) {
    // Cache-only resolution is synchronous: no step queries the database.
    let current = new Set(ids);
    for (let i = trigger.reverse.length - 1; i >= 0 && current.size > 0; i--) {
      current = stepBackCached(internals, trigger.reverse[i] as PathStep, current);
    }
    const byId = internals.cache.records.get(trigger.field.model);
    if (byId === undefined) continue;
    const invalidated: number[] = [];
    const tracked = isTracked(internals.registry.get(trigger.field.model).model, trigger.field.key);
    for (const id of current) {
      if (isProtected(internals, trigger.field, id)) continue;
      const values = byId.get(id);
      if (values === undefined || !values.has(trigger.field.key)) continue;
      if (tracked) {
        // Keep the value for the audit row of the recompute (RFC 0013 §7.2).
        const name = `${trigger.field.model}.${trigger.field.key}`;
        const previous = internals.compute.previous.get(name) ?? new Map<number, unknown>();
        if (!previous.has(id)) previous.set(id, values.get(trigger.field.key));
        internals.compute.previous.set(name, previous);
      }
      values.delete(trigger.field.key);
      invalidated.push(id);
    }
    // Transitive: what depended on the invalidated value is stale too (the graph is acyclic).
    if (invalidated.length > 0)
      invalidateCached(internals, trigger.field.model, trigger.field.key, invalidated);
  }
}

function stepBackCached(
  internals: ScopeInternals,
  step: PathStep,
  ids: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>();
  const cached = internals.cache.records.get(step.model);
  if (step.kind === 'one2many') {
    const byId = internals.cache.records.get(step.target ?? '');
    for (const id of ids) {
      const parent = byId?.get(id)?.get(step.inverse ?? '');
      if (typeof parent === 'number') out.add(parent);
    }
    return out;
  }
  if (cached === undefined) return out;
  for (const [id, values] of cached) {
    const v = values.get(step.key);
    if (
      step.kind === 'many2one'
        ? typeof v === 'number' && ids.has(v)
        : Array.isArray(v) && v.some((c) => ids.has(Number(c)))
    )
      out.add(id);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- load specs

interface MutableSpec {
  readonly fields: Set<string>;
  readonly relations: Map<string, MutableSpec>;
}

function addSibling(model: AnyModel, key: string, fields: Set<string>): void {
  const field = model.fields[key] as
    | (Field & { currencyField?: string; uomField?: string })
    | undefined;
  if (field?.currencyField !== undefined) fields.add(field.currencyField);
  if (field?.uomField !== undefined) fields.add(field.uomField);
}

/** The load spec covering the `depends` of `fields` (RFC 0004 §7.5), plus the sibling currency / unit fields. */
export function dependsSpec(
  internals: ScopeInternals,
  model: AnyModel,
  fields: readonly ComputedField[],
): ComputeSpec {
  const root: MutableSpec = { fields: new Set(['id']), relations: new Map() };
  for (const f of fields) {
    addSibling(model, f.key, root.fields);
    for (const steps of f.paths) {
      let node = root;
      let current = model;
      steps.forEach((step, i) => {
        const last = i === steps.length - 1;
        if (step.kind === 'one2many' || step.kind === 'many2many') {
          let sub = node.relations.get(step.key);
          if (sub === undefined) {
            sub = { fields: new Set(['id']), relations: new Map() };
            node.relations.set(step.key, sub);
          }
          node = sub;
        } else if (step.kind === 'many2one') {
          node.fields.add(step.key);
          if (!last) {
            let sub = node.relations.get(step.key);
            if (sub === undefined) {
              sub = { fields: new Set(['id']), relations: new Map() };
              node.relations.set(step.key, sub);
            }
            node = sub;
          }
        } else {
          node.fields.add(step.key);
          addSibling(current, step.key, node.fields);
        }
        if (step.target !== undefined) current = internals.registry.get(step.target).model;
      });
    }
  }
  return root;
}

// --------------------------------------------------------------------------------------------- computation

/** Assigns a computed value from inside its compute (the record accessors' setter). */
export function assignComputed(
  host: ComputeHost,
  model: AnyModel,
  id: number,
  key: string,
  value: unknown,
): void {
  const { internals } = host;
  if (!internals.compute.computing.has(`${model.name}.${key}`))
    throw new ComputeAssignmentError(model.name, key);
  const field = model.fields[key] as Field;
  const values = host.values(model.name, id, true) as Map<string, unknown>;
  const normalized = normalize(model, key, field, value, (k) => values.get(k), {
    lang: internals.env.lang,
    source: internals.sourceLang,
  });
  internals.journal({
    kind: 'value',
    model: model.name,
    id,
    key,
    had: values.has(key),
    prev: values.get(key),
    wasDirty: internals.isDirty(model.name, id, key),
  });
  const previous = internals.compute.previous.get(`${model.name}.${key}`);
  const prev = values.has(key) ? values.get(key) : previous?.get(id);
  previous?.delete(id);
  values.set(key, normalized);
  if (field.store) {
    internals.markDirty(model.name, id, key);
    trackChange(internals, model, id, key, prev, normalized, (k) => values.get(k));
  }
  internals.trigger(model.name, key, [id]);
}

function groupByCompute(fields: readonly ComputedField[]): ComputedField[][] {
  const groups = new Map<unknown, ComputedField[]>();
  for (const f of fields) {
    const list = groups.get(f.compute) ?? [];
    list.push(f);
    groups.set(f.compute, list);
  }
  return [...groups.values()];
}

/** Every field sharing the compute of `field` on its model (one call fills all of them). */
function sharing(internals: ScopeInternals, field: ComputedField): ComputedField[] {
  return internals.registry.compute.fields.filter(
    (f) => f.model === field.model && f.compute === field.compute,
  );
}

/**
 * Computes `fields` of `model` for `ids`: loads their `depends` for the whole batch, runs each compute once, then
 * checks required fields. Fields sharing a compute are computed together.
 */
export async function computeFields(
  host: ComputeHost,
  model: AnyModel,
  ids: readonly number[],
  fields: readonly ComputedField[],
): Promise<void> {
  if (ids.length === 0 || fields.length === 0) return;
  const { internals } = host;
  for (const group of groupByCompute(fields)) {
    const all = sharing(internals, group[0] as ComputedField);
    // The assigned fields' currency / unit siblings and their objects too: a compute can then total into the
    // record's currency (`lines.sum('subtotal', o.currency)`) even when there is nothing to sum.
    const spec = dependsSpec(internals, model, all);
    const siblings = all.flatMap((f) => {
      const field = model.fields[f.key] as
        | { currencyField?: string; uomField?: string }
        | undefined;
      return [field?.currencyField, field?.uomField].filter((k): k is string => k !== undefined);
    });
    await host.load(model, ids, { ...spec, fields: new Set([...spec.fields, ...siblings]) });
    await host.valueObjects(model, ids, new Set(all.map((f) => f.key)));
    const names = all.map(name);
    for (const n of names) {
      internals.compute.computing.add(n);
      const set = internals.compute.protected.get(n) ?? new Set<number>();
      for (const id of ids) set.add(id);
      internals.compute.protected.set(n, set);
    }
    try {
      const compute = (group[0] as ComputedField).compute;
      if (compute === defaultDisplayName) {
        for (const id of ids) {
          const value = host.values(model.name, id)?.get(model.recName);
          assignComputed(
            host,
            model,
            id,
            'displayName',
            value === null || value === undefined ? '' : String(value),
          );
        }
      } else {
        const records = host.recordset(model, ids);
        const fn = typeof compute === 'string' ? model.methods[compute] : compute;
        // The keys this compute fills come second, for generic computes such as related fields.
        await (fn as (this: unknown, records: unknown, keys: readonly string[]) => unknown).call(
          records,
          records,
          all.map((f) => f.key),
        );
      }
    } finally {
      for (const n of names) {
        internals.compute.computing.delete(n);
        // Outside a recompute round there is no re-trigger to guard against: later changes must invalidate.
        if (!internals.compute.recomputing) internals.compute.protected.delete(n);
      }
    }
    for (const f of all) {
      for (const id of ids) {
        const values = host.values(model.name, id, true) as Map<string, unknown>;
        const field = model.fields[f.key] as Field;
        if (!values.has(f.key)) {
          if (field.required) {
            throw new ValidationError(
              model.name,
              [f.key],
              `computed field '${f.key}' is required but its compute did not assign it for record ${id}.`,
              'Assign every record of the batch in the compute function.',
            );
          }
          values.set(f.key, null);
          if (f.stored) internals.markDirty(model.name, id, f.key);
        }
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------- recompute

/** Recomputes every stored computed field with pending triggers, in rank order, until nothing is pending (RFC 0008 §7.3). */
export async function recompute(host: ComputeHost): Promise<void> {
  const { internals } = host;
  const graph = internals.registry.compute;
  if (internals.compute.recomputing || !internals.hasPending()) return;
  internals.compute.recomputing = true;
  const toCompute: IdSets = new Map();
  try {
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) {
        const pending: string[] = [];
        for (const [model, byKey] of toCompute)
          for (const key of byKey.keys()) pending.push(`${model}.${key}`);
        throw new RecomputeLimitError(round, pending);
      }
      // 1. Resolve raw triggers (database + cache) into affected records of stored fields.
      const just = internals.compute.protected;
      for (const [model, byKey] of internals.takeTriggers()) {
        for (const [key, ids] of byKey) {
          for (const trigger of graph.triggers.get(model)?.get(key) ?? []) {
            if (!trigger.field.stored) continue;
            const affected = await resolve(internals, trigger, ids, true);
            const computed = just.get(name(trigger.field));
            if (computed !== undefined) for (const id of computed) affected.delete(id);
            if (affected.size > 0)
              addAll(toCompute, trigger.field.model, trigger.field.key, affected);
          }
        }
      }
      just.clear();
      for (const [model, byKey] of internals.takeToCompute())
        for (const [key, ids] of byKey) addAll(toCompute, model, key, ids);

      // 2. Lowest rank first; fields sharing a compute go together.
      let bestRank = Number.POSITIVE_INFINITY;
      let best: ComputedField[] = [];
      for (const [model, byKey] of toCompute) {
        for (const key of byKey.keys()) {
          const field = graph.field(model, key);
          if (field === undefined) continue;
          // Fields sharing a compute run together, so the group waits for its highest-ranked field's inputs.
          const rank = Math.max(...sharing(internals, field).map((f) => f.rank));
          if (rank < bestRank) {
            bestRank = rank;
            best = [field];
          } else if (rank === bestRank) best.push(field);
        }
      }
      if (best.length === 0) break;
      const byModel = new Map<string, ComputedField[]>();
      for (const f of best) byModel.set(f.model, [...(byModel.get(f.model) ?? []), f]);
      for (const [modelName, fields] of byModel) {
        const model = internals.registry.get(modelName).model;
        for (const group of groupByCompute(fields)) {
          const all = sharing(internals, group[0] as ComputedField);
          const ids = new Set<number>();
          for (const f of all) {
            const set = toCompute.get(modelName)?.get(f.key);
            if (set === undefined) continue;
            for (const id of set) ids.add(id);
            toCompute.get(modelName)?.delete(f.key);
          }
          await computeFields(host, model, [...ids], [group[0] as ComputedField]);
        }
        if (toCompute.get(modelName)?.size === 0) toCompute.delete(modelName);
      }
    }
  } finally {
    internals.compute.recomputing = false;
    internals.compute.protected.clear();
  }
}
