/**
 * Writes (RFC 0004 §7.6): `create()` inserts immediately, `write()` goes through the unit of work and is flushed in
 * set-based statements, `unlink()` deletes immediately. Every change is journaled for savepoint rollback and
 * recorded as a compute trigger (RFC 0008 §7.2).
 */

import { compile, type SqlFragment, sql } from '@shutro/sql';
import type { ScopeInternals } from '../env/env.js';
import { MissingRecordError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { targetOf } from '../registry/registry.js';
import { junctionTable } from './relations.js';
import { arrayType, bindValue, fail, normalize } from './values.js';

const CHUNK = 1000;

/** What the write runtime needs from the recordset runtime (passed in to avoid a module cycle). */
export interface WriteHost {
  readonly internals: ScopeInternals;
  /** Loads the given fields for ids (through the identity map). */
  fetch(model: AnyModel, ids: readonly number[], fields: ReadonlySet<string>): Promise<void>;
  /** Loads currencies / units referenced by the given fields of the records. */
  ensureValueObjects(
    model: AnyModel,
    ids: readonly number[],
    fields: ReadonlySet<string>,
  ): Promise<void>;
  /** Default (stored, non-x2many) keys of a model, with sibling currency / uom fields. */
  defaults(model: AnyModel): Set<string>;
  /** Cached values of a record, created when `create` is true. */
  values(model: string, id: number, create?: boolean): Map<string, unknown> | undefined;
  /** Children of an x2many relation, loading them if needed. */
  children(model: AnyModel, id: number, key: string): Promise<number[]>;
  /** A recordset of `ids` (for inverse functions). */
  recordset(model: AnyModel, ids: readonly number[]): unknown;
}

type Row = Readonly<Record<string, unknown>>;

function isX2Many(field: Field): boolean {
  return field.kind === 'one2many' || field.kind === 'many2many';
}

/** Resolves a field default (a value or `(env) => value`). */
function defaultOf(field: Field, env: ScopeInternals['env']): unknown {
  return typeof field.default === 'function'
    ? (field.default as (env: unknown) => unknown)(env)
    : field.default;
}

/** A many2one of `model` changed: the one2many lists of the old / new parents changed too (RFC 0008 §7.1). */
function triggerParents(
  internals: ScopeInternals,
  model: AnyModel,
  key: string,
  parents: readonly unknown[],
): void {
  const ids = parents.filter((p): p is number => typeof p === 'number');
  if (ids.length === 0) return;
  const target = targetOf(model.fields[key] as Field);
  if (target === undefined) return;
  const parentModel = internals.registry.get(target).model;
  for (const [pKey, pField] of Object.entries(parentModel.fields)) {
    if (
      pField.kind === 'one2many' &&
      (pField as unknown as { inverseField: string }).inverseField === key &&
      targetOf(pField) === model.name
    )
      internals.trigger(parentModel.name, pKey, ids);
  }
}

/** Splits a row into normalized stored values and x2many commands, validating keys. */
function splitRow(
  model: AnyModel,
  row: Row,
  mode: 'create' | 'write',
  host: WriteHost,
  id: number | undefined,
): { stored: Map<string, unknown>; commands: Map<string, Row> } {
  const stored = new Map<string, unknown>();
  const commands = new Map<string, Row>();
  const siblings = (key: string): unknown =>
    stored.has(key)
      ? stored.get(key)
      : id === undefined
        ? undefined
        : host.values(model.name, id)?.get(key);
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    const field = model.fields[key];
    if (field === undefined || key === 'id')
      fail(
        model,
        [key],
        `'${key}' is not a writable field.`,
        `Fields: ${Object.keys(model.fields)
          .filter((k) => k !== 'id')
          .join(', ')}.`,
      );
    if (field.readonly && !(mode === 'create' && field.sequence !== undefined)) {
      fail(
        model,
        [key],
        `field '${key}' is readonly.`,
        field.kind === 'state'
          ? 'State changes through transitions.'
          : field.computed
            ? 'It is computed; write the fields it depends on instead.'
            : 'It is maintained by the ORM.',
      );
    }
    if (isX2Many(field)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail(
          model,
          [key],
          `field '${key}' expects x2many commands.`,
          'Use { create: [...], link: [...], set: [...], unlink: [...], delete: [...], update: [...], clear: true }.',
        );
      commands.set(key, value as Row);
      continue;
    }
    if (model.columns[key] === undefined)
      fail(
        model,
        [key],
        `field '${key}' is not stored.`,
        'Non-stored computed fields cannot be written.',
      );
    stored.set(key, normalize(model, key, field, value, siblings));
  }
  return { stored, commands };
}

// ------------------------------------------------------------------------------------------------- create

/** Inserts `rows` and returns their ids in input order. Children and links are created too. */
export async function createRecords(
  host: WriteHost,
  model: AnyModel,
  rows: readonly Row[],
): Promise<number[]> {
  const { internals } = host;
  if (rows.length === 0) return [];
  const columns = [...host.defaults(model)].filter(
    (k) => k !== 'id' && model.columns[k] !== undefined,
  );
  const prepared = rows.map((row) => {
    const { stored, commands } = splitRow(model, row, 'create', host, undefined);
    const missing: string[] = [];
    for (const key of columns) {
      if (stored.has(key)) continue;
      const field = model.fields[key];
      if (field === undefined) continue;
      let value: unknown;
      if (key === 'createdAt' || key === 'updatedAt') value = internals.now;
      else if (key === 'createdBy' || key === 'updatedBy') value = internals.uid;
      else value = defaultOf(field, internals.env) ?? null;
      // Stored computes are filled after the insert (RFC 0008 §7.6).
      if (value === null && field.required && !field.computed) missing.push(key);
      stored.set(
        key,
        value === null ? null : normalize(model, key, field, value, (k) => stored.get(k)),
      );
    }
    if (missing.length > 0)
      fail(
        model,
        missing,
        `required field(s) ${missing.map((m) => `'${m}'`).join(', ')} are missing.`,
        'Provide a value, or give the field a default in its definition.',
      );
    return { stored, commands };
  });

  const ids: number[] = [];
  for (let i = 0; i < prepared.length; i += CHUNK) {
    const chunk = prepared.slice(i, i + CHUNK);
    const arrays = columns.map((key) =>
      sql.array(
        chunk.map((p) => bindValue(model.fields[key] as Field, p.stored.get(key))),
        arrayType(model.fields[key] as Field),
      ),
    );
    const rowsOut = await internals.query<{ id: number }>(
      compile(
        sql`INSERT INTO ${sql.id(model.table)} (${sql.join(columns.map((k) => sql.id(model.columns[k] ?? '')))}) SELECT * FROM unnest(${sql.join(arrays)}) RETURNING ${sql.id('id')}`,
      ),
    );
    if (rowsOut.length !== chunk.length) throw new MissingRecordError(model.name, []);
    for (const r of rowsOut) ids.push(Number(r.id));
  }

  const parentsByKey = new Map<string, unknown[]>();
  prepared.forEach((p, i) => {
    const id = ids[i] as number;
    const values = host.values(model.name, id, true) as Map<string, unknown>;
    for (const [key, value] of p.stored) {
      // Stored computes are not cached yet: reading one before the flush point says so (RFC 0008 §7.2).
      if (!(model.fields[key] as Field).computed) values.set(key, value);
      if ((model.fields[key] as Field).kind === 'many2one' && value !== null)
        parentsByKey.set(key, [...(parentsByKey.get(key) ?? []), value]);
    }
    internals.journal({ kind: 'created', model: model.name, id });
  });
  await host.ensureValueObjects(model, ids, new Set(columns));

  // Triggers: every stored value of a new record "changed"; its own stored computes are computed at the next flush point.
  for (const key of columns) {
    const field = model.fields[key] as Field;
    if (field.computed) continue;
    internals.trigger(model.name, key, ids);
  }
  for (const [key, parents] of parentsByKey) triggerParents(internals, model, key, parents);
  for (const f of internals.registry.compute.stored(model.name))
    internals.markToCompute(model.name, f.key, ids);

  for (const [i, p] of prepared.entries()) {
    for (const [key, commands] of p.commands)
      await applyCommands(host, model, ids[i] as number, key, commands, 'create');
  }
  return ids;
}

// -------------------------------------------------------------------------------------------------- write

/** Applies `values` to `ids` in the cache and marks them dirty; x2many commands run immediately. */
export async function writeRecords(
  host: WriteHost,
  model: AnyModel,
  ids: readonly number[],
  values: Row,
): Promise<void> {
  const { internals } = host;
  if (ids.length === 0) return;
  // Money / Quantity checks need the sibling currency / uom values; a moved record needs its old parent.
  const needed = new Set<string>();
  for (const key of Object.keys(values)) {
    const field = model.fields[key] as
      | (Field & { currencyField?: string; uomField?: string })
      | undefined;
    if (field?.currencyField !== undefined) needed.add(field.currencyField);
    if (field?.uomField !== undefined) needed.add(field.uomField);
    if (field?.kind === 'many2one' && internals.registry.compute.inverseKeys(model.name).has(key))
      needed.add(key);
  }
  if (needed.size > 0) await host.fetch(model, ids, needed);

  const changedByKey = new Map<string, number[]>();
  const parentsByKey = new Map<string, unknown[]>();
  const inverses = new Set<string>();
  for (const id of ids) {
    const { stored, commands } = splitRow(model, values, 'write', host, id);
    const cached = host.values(model.name, id, true) as Map<string, unknown>;
    for (const [key, value] of stored) {
      const field = model.fields[key] as Field;
      if (field.kind === 'many2one') {
        invalidateInverseLists(host, model, key, cached.get(key), value);
        parentsByKey.set(key, [...(parentsByKey.get(key) ?? []), cached.get(key), value]);
      }
      internals.journal({
        kind: 'value',
        model: model.name,
        id,
        key,
        had: cached.has(key),
        prev: cached.get(key),
        wasDirty: internals.isDirty(model.name, id, key),
      });
      cached.set(key, value);
      internals.markDirty(model.name, id, key);
      changedByKey.set(key, [...(changedByKey.get(key) ?? []), id]);
      if (field.computed && field.inverse !== undefined) inverses.add(key);
    }
    for (const [key, cmds] of commands) await applyCommands(host, model, id, key, cmds, 'write');
  }
  for (const [key, changed] of changedByKey) internals.trigger(model.name, key, changed);
  for (const [key, parents] of parentsByKey) triggerParents(internals, model, key, parents);
  for (const key of inverses) {
    const inverse = (model.fields[key] as Field).inverse as (records: unknown) => unknown;
    await inverse(host.recordset(model, ids));
  }
}

/** A many2one changed: the cached child lists of the old and new parents are stale. */
function invalidateInverseLists(
  host: WriteHost,
  model: AnyModel,
  key: string,
  oldParent: unknown,
  newParent: unknown,
): void {
  const target = targetOf(model.fields[key] as Field);
  if (target === undefined) return;
  const parentModel = host.internals.registry.get(target).model;
  for (const [pKey, pField] of Object.entries(parentModel.fields)) {
    if (
      pField.kind !== 'one2many' ||
      (pField as unknown as { inverseField: string }).inverseField !== key ||
      targetOf(pField) !== model.name
    )
      continue;
    for (const parent of [oldParent, newParent]) {
      if (typeof parent === 'number') host.values(parentModel.name, parent)?.delete(pKey);
    }
  }
}

// ------------------------------------------------------------------------------------------------- unlink

/** Deletes `ids` now and removes them from the cache (and from any cached x2many lists). */
export async function unlinkRecords(
  host: WriteHost,
  model: AnyModel,
  ids: readonly number[],
): Promise<void> {
  const { internals } = host;
  if (ids.length === 0) return;
  await internals.flush(model.name);
  // The parents of deleted children recompute (RFC 0008 §7.1): remember them before the rows go.
  const inverseKeys = [...internals.registry.compute.inverseKeys(model.name)];
  if (inverseKeys.length > 0) await host.fetch(model, ids, new Set(inverseKeys));
  const parentsByKey = new Map<string, unknown[]>();
  for (const key of inverseKeys) {
    parentsByKey.set(
      key,
      ids.map((id) => host.values(model.name, id)?.get(key)),
    );
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await internals.query<{ id: number }>(
      compile(
        sql`DELETE FROM ${sql.id(model.table)} WHERE ${sql.id('id')} = ANY(${sql.array(chunk, 'bigint')}) RETURNING ${sql.id('id')}`,
      ),
    );
    const deleted = new Set(rows.map((r) => Number(r.id)));
    const absent = chunk.filter((id) => !deleted.has(id));
    if (absent.length > 0) throw new MissingRecordError(model.name, absent);
  }
  for (const id of ids) {
    const values = host.values(model.name, id);
    internals.journal({
      kind: 'deleted',
      model: model.name,
      id,
      values: new Map(values ?? []),
      dirty: internals.dirtyFields(model.name, id),
    });
    internals.forget(model.name, id);
  }
  // Cached x2many lists pointing at this model are stale for the deleted ids.
  for (const { model: other } of internals.registry.models.values()) {
    for (const [key, field] of Object.entries(other.fields)) {
      if (!isX2Many(field) || targetOf(field) !== model.name) continue;
      for (const values of internals.cachedValues(other.name)) {
        const list = values.get(key);
        if (Array.isArray(list))
          values.set(
            key,
            list.filter((c) => !ids.includes(Number(c))),
          );
      }
    }
  }
  for (const [key, parents] of parentsByKey) triggerParents(internals, model, key, parents);
}

// --------------------------------------------------------------------------------------------- x2many ops

async function applyCommands(
  host: WriteHost,
  model: AnyModel,
  parentId: number,
  key: string,
  commands: Row,
  mode: 'create' | 'write',
): Promise<void> {
  const { internals } = host;
  const field = model.fields[key] as Field & { target: string; inverseField?: string };
  const target = internals.registry.get(field.target).model;
  const parentValues = host.values(model.name, parentId, true) as Map<string, unknown>;
  const asIds = (v: unknown, what: string): number[] => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'number'))
      fail(model, [key], `x2many command '${what}' expects an array of ids.`, 'Pass record ids.');
    return v as number[];
  };
  const asRows = (v: unknown, what: string): Row[] => {
    if (!Array.isArray(v))
      fail(model, [key], `x2many command '${what}' expects an array.`, 'Pass an array of records.');
    return v as Row[];
  };

  if (field.kind === 'one2many') {
    const inverse = field.inverseField ?? '';
    const inverseField = target.fields[inverse] as Field;
    const linked: number[] = mode === 'create' ? [] : await host.children(model, parentId, key);
    const current = new Set(linked);
    for (const [cmd, arg] of Object.entries(commands)) {
      if (arg === undefined) continue;
      switch (cmd) {
        case 'create': {
          const created = await createRecords(
            host,
            target,
            asRows(arg, cmd).map((r) => ({ ...r, [inverse]: parentId })),
          );
          for (const id of created) current.add(id);
          break;
        }
        case 'update':
          for (const u of asRows(arg, cmd))
            await writeRecords(host, target, [Number(u['id'])], (u['values'] ?? {}) as Row);
          break;
        case 'delete': {
          const ids = asIds(arg, cmd);
          await unlinkRecords(host, target, ids);
          for (const id of ids) current.delete(id);
          break;
        }
        case 'link': {
          const ids = asIds(arg, cmd);
          await writeRecords(host, target, ids, { [inverse]: parentId });
          for (const id of ids) current.add(id);
          break;
        }
        case 'unlink':
        case 'clear':
        case 'set': {
          const keep = cmd === 'set' ? new Set(asIds(arg, cmd)) : new Set<number>();
          const remove =
            cmd === 'unlink' ? asIds(arg, cmd) : [...current].filter((id) => !keep.has(id));
          if (remove.length > 0) {
            if (inverseField.required)
              fail(
                model,
                [key],
                `cannot unlink from '${key}': the inverse '${inverse}' is required.`,
                'Delete the records instead (delete: [...]), or make the inverse optional.',
              );
            await writeRecords(host, target, remove, { [inverse]: null });
            for (const id of remove) current.delete(id);
          }
          if (cmd === 'set') {
            const add = [...keep].filter((id) => !current.has(id));
            if (add.length > 0) await writeRecords(host, target, add, { [inverse]: parentId });
            for (const id of add) current.add(id);
          }
          break;
        }
        default:
          fail(
            model,
            [key],
            `'${cmd}' is not an x2many command.`,
            'Use create, update, delete, link, unlink, set or clear.',
          );
      }
    }
    parentValues.set(key, [...current]);
    internals.trigger(model.name, key, [parentId]);
    return;
  }

  // many2many: junction table changes are immediate.
  const j = junctionTable(model, field, target);
  const rel = sql.id(j.table);
  const src = sql.id(j.sourceColumn);
  const tgt = sql.id(j.targetColumn);
  const link = async (ids: readonly number[]): Promise<void> => {
    if (ids.length === 0) return;
    await internals.query(
      compile(
        sql`INSERT INTO ${rel} (${src}, ${tgt}) SELECT * FROM unnest(${sql.array(
          ids.map(() => parentId),
          'bigint',
        )}, ${sql.array(ids, 'bigint')}) ON CONFLICT DO NOTHING`,
      ),
    );
  };
  const linked = mode === 'create' ? [] : await host.children(model, parentId, key);
  const current = new Set(linked);
  for (const [cmd, arg] of Object.entries(commands)) {
    if (arg === undefined) continue;
    switch (cmd) {
      case 'create': {
        const created = await createRecords(host, target, asRows(arg, cmd));
        await link(created);
        for (const id of created) current.add(id);
        break;
      }
      case 'update':
        for (const u of asRows(arg, cmd))
          await writeRecords(host, target, [Number(u['id'])], (u['values'] ?? {}) as Row);
        break;
      case 'link': {
        const ids = asIds(arg, cmd);
        await link(ids);
        for (const id of ids) current.add(id);
        break;
      }
      case 'unlink': {
        const ids = asIds(arg, cmd);
        await internals.query(
          compile(
            sql`DELETE FROM ${rel} WHERE ${src} = ${parentId} AND ${tgt} = ANY(${sql.array(ids, 'bigint')})`,
          ),
        );
        for (const id of ids) current.delete(id);
        break;
      }
      case 'delete': {
        const ids = asIds(arg, cmd);
        await unlinkRecords(host, target, ids);
        for (const id of ids) current.delete(id);
        break;
      }
      case 'set': {
        const ids = asIds(arg, cmd);
        await internals.query(
          compile(
            sql`DELETE FROM ${rel} WHERE ${src} = ${parentId} AND ${tgt} <> ALL(${sql.array(ids, 'bigint')})`,
          ),
        );
        await link(ids.filter((id) => !current.has(id)));
        current.clear();
        for (const id of ids) current.add(id);
        break;
      }
      case 'clear':
        await internals.query(compile(sql`DELETE FROM ${rel} WHERE ${src} = ${parentId}`));
        current.clear();
        break;
      default:
        fail(
          model,
          [key],
          `'${cmd}' is not an x2many command.`,
          'Use create, update, delete, link, unlink, set or clear.',
        );
    }
  }
  parentValues.set(key, [...current]);
  internals.trigger(model.name, key, [parentId]);
}

// -------------------------------------------------------------------------------------------------- flush

/** Writes dirty records of `modelName` (or all models) in one `UPDATE … FROM unnest(...)` per (model, field set). */
export async function flushDirty(host: WriteHost, modelName?: string): Promise<void> {
  const { internals } = host;
  const names = modelName === undefined ? internals.dirtyModels() : [modelName];
  for (const name of names) {
    const dirty = internals.takeDirty(name);
    if (dirty === undefined || dirty.size === 0) continue;
    const model = internals.registry.get(name).model;
    const groups = new Map<string, { fields: string[]; ids: number[] }>();
    for (const [id, fields] of dirty) {
      // A value invalidated by a trigger and not recomputed yet must not be written as null.
      const sorted = [...fields].filter((k) => host.values(name, id)?.has(k)).sort();
      if (sorted.length === 0) continue;
      const key = sorted.join(',');
      let group = groups.get(key);
      if (group === undefined) {
        group = { fields: sorted, ids: [] };
        groups.set(key, group);
      }
      group.ids.push(id);
    }
    for (const group of groups.values()) {
      const fields = group.fields.map((k) => ({
        key: k,
        field: model.fields[k] as Field,
        column: model.columns[k] ?? '',
      }));
      for (let i = 0; i < group.ids.length; i += CHUNK) {
        const chunk = group.ids.slice(i, i + CHUNK);
        const arrays: SqlFragment[] = [
          sql.array(chunk, 'bigint'),
          ...fields.map((f) =>
            sql.array(
              chunk.map((id) => bindValue(f.field, host.values(name, id)?.get(f.key))),
              arrayType(f.field),
            ),
          ),
        ];
        const names = [sql.id('id'), ...fields.map((f) => sql.id(f.column))];
        const sets = [
          ...fields.map((f) => sql`${sql.id(f.column)} = ${sql.id('v', f.column)}`),
          sql`${sql.id('updated_at')} = ${internals.now}`,
          sql`${sql.id('updated_by_id')} = ${internals.uid}`,
        ];
        const rows = await internals.query<{ id: number }>(
          compile(
            sql`UPDATE ${sql.id(model.table)} AS ${sql.id('x')} SET ${sql.join(sets)} FROM unnest(${sql.join(arrays)}) AS ${sql.id('v')}(${sql.join(names)}) WHERE ${sql.id('x', 'id')} = ${sql.id('v', 'id')} RETURNING ${sql.id('x', 'id')}`,
          ),
        );
        const updated = new Set(rows.map((r) => Number(r.id)));
        const absent = chunk.filter((id) => !updated.has(id));
        if (absent.length > 0) throw new MissingRecordError(name, absent);
        for (const id of chunk) {
          const values = host.values(name, id);
          values?.set('updatedAt', internals.now);
          values?.set('updatedBy', internals.uid);
        }
      }
    }
  }
}
