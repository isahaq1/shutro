/**
 * Onchange (RFC 0009 §7.3–7.4): a draft is a virtual record in the cache (negative id). Handlers run for the changed
 * fields, then the real compute engine computes the draft and its virtual child rows. Nothing is written; the virtual
 * records are purged afterwards.
 */

import type { ScopeInternals } from '../env/env.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { type ComputeHost, computeFields } from './compute.js';
import { assertAccess, canField } from './security.js';
import { fail, normalize, type TranslationContext } from './values.js';

/** What the draft runtime needs from the recordset runtime. */
export interface OnchangeHost extends ComputeHost {
  /** Stored, non-x2many keys with sibling currency / unit fields. */
  defaults(model: AnyModel): Set<string>;
  /** Children ids of an x2many of a real record. */
  children(model: AnyModel, id: number, key: string): Promise<number[]>;
  /** Plain JSON rows (as `read()` returns them) of records. */
  read(model: AnyModel, ids: readonly number[], keys: readonly string[]): Record<string, unknown>[];
}

/** The input of `env.model(M).onchange()`. */
export interface OnchangeInputRaw {
  readonly id?: number | undefined;
  readonly values: Readonly<Record<string, unknown>>;
  readonly changed: readonly string[];
}

/** The output of `env.model(M).onchange()`. */
export interface OnchangeResultRaw {
  /** Scalar and many2one fields whose plain value differs from the input. */
  readonly values: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
  /** Plain rows of the virtual children created by x2many `create` commands, per field. */
  readonly children: Readonly<Record<string, readonly Record<string, unknown>[]>>;
}

/** The draft handed to onchange handlers (untyped runtime; typed as `Draft<S, M>`). */
export interface DraftRaw {
  readonly id: number | null;
  readonly env: ScopeInternals['env'];
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  /** The related record of a many2one (loaded), or null. */
  record(key: string): Promise<unknown>;
  warn(message: string): void;
}

function translationOf(host: OnchangeHost): TranslationContext {
  return { lang: host.internals.env.lang, source: host.internals.sourceLang };
}

function defaultOf(field: Field, env: ScopeInternals['env']): unknown {
  return typeof field.default === 'function'
    ? (field.default as (env: unknown) => unknown)(env)
    : field.default;
}

function isX2Many(field: Field): boolean {
  return field.kind === 'one2many' || field.kind === 'many2many';
}

function scalarKeys(model: AnyModel): string[] {
  return Object.keys(model.fields).filter((k) => !isX2Many(model.fields[k] as Field));
}

/**
 * The ids of a draft's many2many after a handler sets it: a list of ids, or commands (`set`, `link`, `unlink`,
 * `clear`) applied to its current ids. The draft keeps ids, as for given values, so computes read it like any set.
 */
function many2manyIds(current: readonly number[], value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((v): v is number => typeof v === 'number');
  const commands = (value ?? {}) as Readonly<Record<string, unknown>>;
  let list = commands['clear'] === true ? [] : [...current];
  if (Array.isArray(commands['set'])) list = [...(commands['set'] as number[])];
  if (Array.isArray(commands['link']))
    for (const id of commands['link'] as number[]) if (!list.includes(id)) list.push(id);
  if (Array.isArray(commands['unlink'])) {
    const gone = new Set(commands['unlink'] as number[]);
    list = list.filter((id) => !gone.has(id));
  }
  return list;
}

/** Writes one draft value into the cache: `null` is always allowed, everything else is normalized like a write. */
function setDraftValue(
  model: AnyModel,
  values: Map<string, unknown>,
  key: string,
  value: unknown,
  translation?: TranslationContext,
): void {
  const field = model.fields[key];
  if (field === undefined || key === 'id')
    fail(
      model,
      [key],
      `'${key}' is not a field.`,
      `Fields: ${Object.keys(model.fields).join(', ')}.`,
    );
  if (field.kind === 'many2many') {
    values.set(
      key,
      value === null || value === undefined
        ? []
        : many2manyIds((values.get(key) as number[] | undefined) ?? [], value),
    );
    return;
  }
  if (value === null || value === undefined) {
    values.set(key, null);
    return;
  }
  // A virtual parent (negative id) is a valid draft reference.
  if (field.kind === 'many2one' && typeof value === 'number' && value < 0) {
    values.set(key, value);
    return;
  }
  values.set(
    key,
    normalize(model, key, field, value, (k) => values.get(k), translation),
  );
}

/** Fills a virtual record with defaults (or a real record's values), then the given values. */
async function materialize(
  host: OnchangeHost,
  model: AnyModel,
  id: number | undefined,
  given: Readonly<Record<string, unknown>>,
  preset: Readonly<Record<string, unknown>>,
  children: Map<string, number[]>,
): Promise<number> {
  const { internals } = host;
  const vid = internals.nextVirtualId();
  const values = host.values(model.name, vid, true) as Map<string, unknown>;
  const stored = [...host.defaults(model)].filter(
    (k) => k !== 'id' && model.columns[k] !== undefined,
  );
  if (id !== undefined) {
    await host.load(model, [id], { fields: new Set(stored), relations: new Map() });
    const current = host.values(model.name, id) as Map<string, unknown>;
    for (const key of stored) values.set(key, current.get(key) ?? null);
    for (const key of Object.keys(model.fields)) {
      if (isX2Many(model.fields[key] as Field))
        values.set(key, await host.children(model, id, key));
    }
  } else {
    for (const key of stored) {
      const field = model.fields[key] as Field;
      // Defaults are normalized like given values ('1' → Decimal), so computes on drafts see real types.
      if (field.computed) values.set(key, null);
      else
        setDraftValue(
          model,
          values,
          key,
          defaultOf(field, internals.env) ?? null,
          translationOf(host),
        );
    }
    for (const key of Object.keys(model.fields)) {
      if (isX2Many(model.fields[key] as Field)) values.set(key, []);
    }
  }
  for (const [key, value] of Object.entries(preset))
    setDraftValue(model, values, key, value, translationOf(host));
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    const field = model.fields[key];
    if (field !== undefined && isX2Many(field)) {
      const commands = (value ?? {}) as Readonly<Record<string, unknown>>;
      const target = internals.registry.get((field as { target?: string }).target ?? '').model;
      const list = [...((values.get(key) as number[] | undefined) ?? [])];
      if (Array.isArray(commands['set']))
        list.splice(0, list.length, ...(commands['set'] as number[]));
      if (Array.isArray(commands['link']))
        for (const linked of commands['link'] as number[])
          if (!list.includes(linked)) list.push(linked);
      const created: number[] = [];
      if (Array.isArray(commands['create'])) {
        const inverse =
          field.kind === 'one2many'
            ? ((field as { inverseField?: string }).inverseField ?? '')
            : '';
        for (const row of commands['create'] as Readonly<Record<string, unknown>>[]) {
          const cid = await materialize(
            host,
            target,
            undefined,
            row,
            inverse === '' ? {} : { [inverse]: vid },
            new Map(),
          );
          created.push(cid);
        }
      }
      list.push(...created);
      values.set(key, list);
      children.set(key, created);
      continue;
    }
    setDraftValue(model, values, key, value, translationOf(host));
  }
  return vid;
}

/** Computes every computed field of `model` for `ids`, in rank order (fields sharing a compute go together). */
async function computeAll(
  host: OnchangeHost,
  model: AnyModel,
  ids: readonly number[],
): Promise<void> {
  const fields = host.internals.registry.compute.fields
    .filter((f) => f.model === model.name)
    .sort((a, b) => a.rank - b.rank);
  const done = new Set<unknown>();
  for (const f of fields) {
    if (done.has(f.compute)) continue;
    done.add(f.compute);
    // A draft may not have a required relation yet (a new line without its order): skip the compute for those
    // records, so inside a compute a required many2one in `depends` is always set (feedback #4). The field stays
    // empty in the draft until the relation is given.
    const ready = ids.filter((id) => {
      const values = host.values(model.name, id);
      return f.paths.every((path) => {
        const first = path[0];
        if (first === undefined || path.length < 2 || first.kind !== 'many2one') return true;
        if (model.fields[first.key]?.required !== true) return true;
        const value = values?.get(first.key);
        return value !== null && value !== undefined;
      });
    });
    await computeFields(host, model, ready, [f]);
  }
}

/** Runs `model`'s onchange handlers on the virtual record `vid` for `changed`, cascading once per key. */
async function runHandlers(
  host: OnchangeHost,
  model: AnyModel,
  vid: number,
  id: number | null,
  changed: readonly string[],
  warnings: string[],
): Promise<void> {
  const { internals } = host;
  const values = host.values(model.name, vid) as Map<string, unknown>;
  const queue = [...changed];
  const done = new Set<string>();
  const draft: DraftRaw = {
    id,
    env: internals.env,
    get: (key) => values.get(key),
    set(key, value) {
      setDraftValue(model, values, key, value, translationOf(host));
      if (!done.has(key) && !queue.includes(key)) queue.push(key);
    },
    async record(key) {
      const field = model.fields[key];
      const target = (field as { target?: string } | undefined)?.target;
      const related = values.get(key);
      if (field?.kind !== 'many2one' || target === undefined || typeof related !== 'number')
        return null;
      const set = await (
        host.recordset(internals.registry.get(target).model, [related]) as {
          load(): Promise<{ first(): unknown }>;
        }
      ).load();
      return set.first();
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (done.has(key)) continue;
    done.add(key);
    const fn = model.onchange[key] as ((draft: DraftRaw, env: unknown) => unknown) | undefined;
    if (fn !== undefined) await fn(draft, internals.env);
  }
}

/** `env.model(M).onchange(input)`. */
export async function runOnchange(
  host: OnchangeHost,
  model: AnyModel,
  input: OnchangeInputRaw,
): Promise<OnchangeResultRaw> {
  const { internals } = host;
  // Form assistance for a record being created (no id) or edited: the same access as saving it would need, so a
  // reader cannot run a model's onchange logic (and see its results) on records they could never save.
  assertAccess(internals, model, 'read');
  assertAccess(internals, model, input.id === undefined || input.id === null ? 'create' : 'write');
  const warnings: string[] = [];
  const childIds = new Map<string, number[]>();
  const wasRecomputing = internals.compute.recomputing;
  internals.compute.recomputing = true; // suspends recompute and constraint checks for nested flushes (RFC 0009 §7.4)
  const created: { model: AnyModel; id: number }[] = [];
  try {
    const vid = await materialize(host, model, input.id, input.values, {}, childIds);
    created.push({ model: model, id: vid });
    for (const [key, ids] of childIds) {
      const target = internals.registry.get(
        (model.fields[key] as { target?: string }).target ?? '',
      ).model;
      for (const id of ids) created.push({ model: target, id });
    }
    const values = host.values(model.name, vid) as Map<string, unknown>;
    // Only fields the user may read come back (and are compared): restricted ones stay out of the draft's result.
    const keys = scalarKeys(model).filter(
      (k) => k !== 'id' && canField(internals, model, k, 'read'),
    );
    // Loads nothing (every column is in the cache) but brings the currency / unit objects the reads need.
    await host.load(model, [vid], {
      fields: new Set(keys.filter((k) => model.columns[k] !== undefined)),
      relations: new Map(),
    });
    // The input to compare against: a record's values and the given ones; for a new draft the given ones only, so
    // its defaults come back (a new form shows them).
    const [beforeRow] = host.read(
      model,
      [vid],
      keys.filter((k) =>
        input.id === undefined || input.id === null ? k in input.values : values.has(k),
      ),
    );

    // Many2many fields come back as their ids when a handler changed them (a line's taxes from its product).
    const sets = Object.keys(model.fields).filter(
      (k) =>
        (model.fields[k] as Field).kind === 'many2many' && canField(internals, model, k, 'read'),
    );
    const setsBefore = new Map(sets.map((k) => [k, JSON.stringify(values.get(k) ?? [])]));

    // Handlers, cascading once per key: the draft's, then each new child row's for the fields it was given
    // (feedback #10), so a line's product handler runs inside the order being edited and sees its values.
    await runHandlers(host, model, vid, input.id ?? null, input.changed, warnings);
    for (const [key, ids] of childIds) {
      const field = model.fields[key] as Field;
      const target = internals.registry.get((field as { target?: string }).target ?? '').model;
      const rows = ((
        input.values[key] as { create?: readonly Readonly<Record<string, unknown>>[] } | undefined
      )?.create ?? []) as readonly Readonly<Record<string, unknown>>[];
      for (const [i, cid] of ids.entries())
        await runHandlers(host, target, cid, null, Object.keys(rows[i] ?? {}), warnings);
    }

    // Computes: children first, then the draft.
    for (const [key, ids] of childIds) {
      if (ids.length === 0) continue;
      const target = internals.registry.get(
        (model.fields[key] as { target?: string }).target ?? '',
      ).model;
      await computeAll(host, target, ids);
    }
    await computeAll(host, model, [vid]);

    // Everything whose plain value differs from the draft as given (handler-set and computed fields).
    const columnsOf = (m: AnyModel, ks: readonly string[]): Set<string> =>
      new Set(ks.filter((k) => m.columns[k] !== undefined));
    await host.load(model, [vid], { fields: columnsOf(model, keys), relations: new Map() }); // currency objects set by handlers
    const [row] = host.read(model, [vid], keys);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (JSON.stringify(row?.[key] ?? null) !== JSON.stringify(beforeRow?.[key] ?? null))
        out[key] = row?.[key];
    }
    for (const key of sets) {
      const now = (values.get(key) as number[] | undefined) ?? [];
      if (JSON.stringify(now) !== setsBefore.get(key)) out[key] = [...now];
    }
    const children: Record<string, Record<string, unknown>[]> = {};
    for (const [key, ids] of childIds) {
      const target = internals.registry.get(
        (model.fields[key] as { target?: string }).target ?? '',
      ).model;
      const childKeys = scalarKeys(target).filter(
        (k) => k !== 'id' && canField(internals, target, k, 'read'),
      );
      await host.load(target, ids, { fields: columnsOf(target, childKeys), relations: new Map() });
      children[key] = host.read(target, ids, childKeys).map(({ id: _id, ...rest }) => rest);
    }
    return { values: out, warnings, children };
  } finally {
    internals.compute.recomputing = wasRecomputing;
    for (const { model: m, id } of created) internals.forget(m.name, id);
  }
}
