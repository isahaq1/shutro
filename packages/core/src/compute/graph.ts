/**
 * The dependency graph of computed fields (RFC 0008 §7.1): every `depends` path becomes triggers that say which
 * computed field a change reaches and how to walk back to its records; computed fields get a rank so chains compute
 * in order.
 */

import { ComputeCycleError } from '../errors.js';
import type { Field } from '../model/field.js';
import { type AnyModel, defaultDisplayName } from '../model/model.js';

/** One step of a depends path: field `key` of `model`, leading to `target` for relations. */
export interface PathStep {
  readonly model: string;
  readonly key: string;
  readonly kind: Field['kind'];
  readonly target: string | undefined;
  /** For one2many: the many2one on the target pointing back. */
  readonly inverse: string | undefined;
}

/** A computed field and its parsed dependencies. */
export interface ComputedField {
  readonly model: string;
  readonly key: string;
  readonly stored: boolean;
  /** Identity of the compute: the function, or the method name. One compute may fill several fields. */
  readonly compute: string | ((records: never) => unknown);
  readonly paths: readonly (readonly PathStep[])[];
  /** Dependency depth: 0 when no path touches a computed field. */
  readonly rank: number;
}

/** How a change of `(model, key)` reaches a computed field: walk `reverse` from the changed records, last step first. */
export interface Trigger {
  readonly field: ComputedField;
  /** The steps from the computed field's model down to the changed model (empty when they are the same). */
  readonly reverse: readonly PathStep[];
}

/** The built graph (RFC 0008 §9). */
export interface ComputeGraph {
  readonly fields: readonly ComputedField[];
  /** model → key → the computed fields a change of that key reaches. */
  readonly triggers: ReadonlyMap<string, ReadonlyMap<string, readonly Trigger[]>>;
  field(model: string, key: string): ComputedField | undefined;
  /** Stored computed fields of a model. */
  stored(model: string): readonly ComputedField[];
  /** many2one keys of `model` that are inverses of one2many steps in some path: changing or deleting them moves records between parents. */
  inverseKeys(model: string): ReadonlySet<string>;
}

type Models = ReadonlyMap<string, { readonly model: AnyModel }>;

function targetOf(field: Field): string | undefined {
  return (field as { target?: string }).target;
}

function parsePath(models: Models, model: AnyModel, path: string): PathStep[] {
  const steps: PathStep[] = [];
  let current = model;
  for (const key of path.split('.')) {
    const f = current.fields[key];
    if (f === undefined) throw new Error(`Unchecked depends path '${path}' on ${model.name}.`); // the registry validated paths
    const target = targetOf(f);
    steps.push({
      model: current.name,
      key,
      kind: f.kind,
      target,
      inverse: f.kind === 'one2many' ? (f as { inverseField?: string }).inverseField : undefined,
    });
    if (target !== undefined) {
      const next = models.get(target);
      if (next === undefined) throw new Error(`Unchecked target '${target}' in '${path}'.`);
      current = next.model;
    }
  }
  return steps;
}

/** Builds the graph for the registry's models. @throws {ComputeCycleError} */
export function buildComputeGraph(models: Models): ComputeGraph {
  const fields: ComputedField[] = [];
  const byName = new Map<string, ComputedField>();
  const pending: { field: Omit<ComputedField, 'rank'>; deps: Set<string> }[] = [];

  for (const { model } of models.values()) {
    for (const [key, field] of Object.entries(model.fields)) {
      if (!field.computed || field.compute === undefined) continue;
      const paths =
        field.compute === defaultDisplayName
          ? [model.recName]
          : (field.depends as readonly string[]);
      const parsed = paths.map((p) => parsePath(models, model, p));
      const deps = new Set<string>();
      for (const steps of parsed) {
        for (const step of steps) {
          const stepField = models.get(step.model)?.model.fields[step.key];
          if (stepField?.computed) deps.add(`${step.model}.${step.key}`);
        }
      }
      pending.push({
        field: {
          model: model.name,
          key,
          stored: field.store,
          compute: field.compute as ComputedField['compute'],
          paths: parsed,
        },
        deps,
      });
    }
  }

  // Ranks by depth-first search with cycle detection.
  const ranks = new Map<string, number>();
  const visiting: string[] = [];
  const byKey = new Map(pending.map((p) => [`${p.field.model}.${p.field.key}`, p]));
  const rankOf = (name: string): number => {
    const known = ranks.get(name);
    if (known !== undefined) return known;
    const entry = byKey.get(name);
    if (entry === undefined) return 0;
    const at = visiting.indexOf(name);
    if (at >= 0) throw new ComputeCycleError([...visiting.slice(at), name]);
    visiting.push(name);
    let rank = 0;
    for (const dep of entry.deps) rank = Math.max(rank, rankOf(dep) + 1);
    visiting.pop();
    ranks.set(name, rank);
    return rank;
  };
  for (const p of pending) {
    const name = `${p.field.model}.${p.field.key}`;
    const built: ComputedField = { ...p.field, rank: rankOf(name) };
    fields.push(built);
    byName.set(name, built);
  }

  const triggers = new Map<string, Map<string, Trigger[]>>();
  const inverses = new Map<string, Set<string>>();
  const add = (model: string, key: string, trigger: Trigger): void => {
    let byField = triggers.get(model);
    if (byField === undefined) {
      byField = new Map();
      triggers.set(model, byField);
    }
    let list = byField.get(key);
    if (list === undefined) {
      list = [];
      byField.set(key, list);
    }
    list.push(trigger);
  };
  for (const field of fields) {
    for (const steps of field.paths) {
      steps.forEach((step, i) => {
        add(step.model, step.key, { field, reverse: steps.slice(0, i) });
        if (step.kind === 'one2many' && step.target !== undefined && step.inverse !== undefined) {
          let set = inverses.get(step.target);
          if (set === undefined) {
            set = new Set();
            inverses.set(step.target, set);
          }
          set.add(step.inverse);
        }
      });
    }
  }

  const none: readonly ComputedField[] = Object.freeze([]);
  const empty: ReadonlySet<string> = new Set();
  const storedByModel = new Map<string, ComputedField[]>();
  for (const f of fields) {
    if (!f.stored) continue;
    const list = storedByModel.get(f.model) ?? [];
    list.push(f);
    storedByModel.set(f.model, list);
  }
  return {
    fields: Object.freeze(fields),
    triggers,
    field: (model, key) => byName.get(`${model}.${key}`),
    stored: (model) => storedByModel.get(model) ?? none,
    inverseKeys: (model) => inverses.get(model) ?? empty,
  };
}
