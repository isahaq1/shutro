/**
 * The records API (RFC 0020 §7.3). Every handler runs inside the user's `shutro.run()`: ACL, record rules, field
 * groups, company scope, constraints and the audit trail apply exactly as for code. Responses are plain JSON:
 * many2one values come with their display name, Money as `{ amount, currency }`, decimals as strings.
 */
import { callTransition, type DynamicEnv, type DynamicRecords } from './dynamic.js';
import { badRequest, HttpError, notFound } from './errors.js';
import type { ModelMeta } from './meta.js';

/** A many2one value as the client receives it. */
export interface Ref {
  readonly id: number;
  readonly name: string;
}

/** Rows for the client: many2one ids replaced by `{ id, name }` (one name query per target model, no N+1). */
async function serialize(
  env: DynamicEnv,
  model: ModelMeta,
  models: Readonly<Record<string, ModelMeta>>,
  records: DynamicRecords,
  keys: readonly string[],
): Promise<Record<string, unknown>[]> {
  const rows = records.read(keys);
  for (const key of keys) {
    const f = model.fields[key];
    if (f?.kind !== 'many2one' || f.target === undefined) continue;
    const target = models[f.target];
    const ids = [
      ...new Set(rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number')),
    ];
    const names = new Map<number, string>();
    if (ids.length > 0 && target !== undefined && target.recName !== 'id') {
      const loaded = await env.model(f.target).browse(ids).load([target.recName]);
      for (const r of loaded.read([target.recName]))
        names.set(Number(r['id']), String(r[target.recName] ?? ''));
    }
    for (const row of rows) {
      const id = row[key];
      if (typeof id === 'number') row[key] = { id, name: names.get(id) ?? `#${id}` } satisfies Ref;
    }
  }
  return rows;
}

const MAX_LIMIT = 500;

/** The fields a request may name: readable by the user, and loadable (not x2many). */
function fieldsOf(
  model: ModelMeta,
  requested: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const keys = requested ?? fallback;
  for (const key of keys) {
    const f = model.fields[key];
    if (f === undefined)
      throw new HttpError(
        400,
        'UNKNOWN_FIELD',
        `'${key}' is not a field of ${model.name} you can read.`,
        'Check the field list.',
        [key],
      );
  }
  const loadable = keys.filter((k) => {
    const kind = model.fields[k]?.kind;
    return kind !== 'one2many' && kind !== 'many2many';
  });
  return [...new Set(['updatedAt', ...loadable])].filter(
    (k) => k === 'updatedAt' || model.fields[k] !== undefined,
  );
}

const asObject = (value: unknown, what: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw badRequest(`${what} must be a JSON object.`, 'Send { ... }.');
  return value as Readonly<Record<string, unknown>>;
};

const asStringList = (value: unknown, what: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw badRequest(`${what} must be a list of strings.`, 'Send ["name", ...].');
  return value;
};

/** Values from JSON to what `create()` / `write()` accept: datetimes as `Date`, the rest as sent. */
function inputValues(
  model: ModelMeta,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const f = model.fields[key];
    if (f === undefined)
      throw new HttpError(
        422,
        'UNKNOWN_FIELD',
        `'${key}' is not a field of ${model.name} you can write.`,
        'Remove it from the values.',
        [key],
      );
    if (f.readonly && f.kind !== 'one2many')
      throw new HttpError(
        422,
        'READONLY_FIELD',
        `'${key}' of ${model.name} is read-only.`,
        'Remove it from the values.',
        [key],
      );
    out[key] =
      f.kind === 'datetime' && typeof value === 'string'
        ? new Date(value)
        : f.kind === 'many2one' && typeof value === 'object' && value !== null && 'id' in value
          ? (value as Ref).id
          : value;
  }
  return out;
}

/** `POST /api/records/:model/search`. */
export async function search(
  env: DynamicEnv,
  models: Readonly<Record<string, ModelMeta>>,
  model: ModelMeta,
  body: unknown,
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const q = asObject(body ?? {}, 'The search');
  const limit = Math.min(MAX_LIMIT, Number(q['limit'] ?? 80));
  const offset = Math.max(0, Number(q['offset'] ?? 0));
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 0)
    throw badRequest('limit and offset must be integers.', `Use limit ≤ ${MAX_LIMIT}.`);
  const where = q['where'] === undefined ? undefined : asObject(q['where'], 'where');
  const order = asStringList(q['order'], 'order');
  const keys = fieldsOf(model, asStringList(q['fields'], 'fields'), model.views.list.columns);
  const ref = env.model(model.name);
  const found = await ref.search({
    ...(where === undefined ? {} : { where }),
    ...(order === undefined ? {} : { order }),
    limit,
    offset,
  });
  const loaded = await found.load(keys);
  const rows = await serialize(env, model, models, loaded, keys);
  const total =
    found.length < limit && offset === 0
      ? found.length
      : Number(
          (
            await ref.aggregate({
              ...(where === undefined ? {} : { where }),
              measures: { n: 'count' },
            })
          )[0]?.['n'] ?? 0,
        );
  return { rows, total };
}

/** `POST /api/records/:model/group`: counts (and sums of monetary fields) per group, for kanban columns and lists. */
export async function group(
  env: DynamicEnv,
  model: ModelMeta,
  body: unknown,
): Promise<Record<string, unknown>[]> {
  const q = asObject(body ?? {}, 'The grouping');
  const by = typeof q['by'] === 'string' ? q['by'] : undefined;
  if (by === undefined || model.fields[by] === undefined)
    throw badRequest(
      'Group by a field you can read.',
      `Fields: ${Object.keys(model.fields).join(', ')}.`,
    );
  const where = q['where'] === undefined ? undefined : asObject(q['where'], 'where');
  const sums = Object.entries(model.fields).filter(([, f]) => f.kind === 'monetary' && f.store);
  return env.model(model.name).aggregate({
    ...(where === undefined ? {} : { where }),
    groupBy: [by],
    measures: { count: 'count', ...Object.fromEntries(sums.map(([k]) => [k, { sum: k }])) },
  });
}

async function one(env: DynamicEnv, model: ModelMeta, id: number): Promise<DynamicRecords> {
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound(`${model.label} #${id}`);
  const found = await env.model(model.name).search({ where: { id }, limit: 1 });
  if (found.length === 0) throw notFound(`${model.label} #${id}`); // missing, or out of the user's record rules
  return found;
}

/** `GET /api/records/:model/:id`: the form's fields, its allowed transitions. */
export async function read(
  env: DynamicEnv,
  models: Readonly<Record<string, ModelMeta>>,
  model: ModelMeta,
  id: number,
  fields: readonly string[] | undefined,
): Promise<{ row: Record<string, unknown>; transitions: readonly string[] }> {
  const form = model.views.form;
  const keys = fieldsOf(
    model,
    fields,
    [
      form.title,
      ...form.main,
      ...form.notes,
      ...form.smart,
      ...form.totals,
      ...(form.statusbar === null ? [] : [form.statusbar]),
    ].filter((k) => model.fields[k] !== undefined),
  );
  const records = await (await one(env, model, id)).load(keys);
  const [row] = await serialize(env, model, models, records, keys);
  if (row === undefined) throw notFound(`${model.label} #${id}`);
  return {
    row,
    transitions:
      model.stateField === null ? [] : records.transitions().filter((t) => t in model.transitions),
  };
}

/** `POST /api/records/:model`. */
export async function create(
  env: DynamicEnv,
  model: ModelMeta,
  body: unknown,
): Promise<{ id: number }> {
  const values = inputValues(model, asObject(asObject(body, 'The request')['values'], 'values'));
  const created = await env.model(model.name).create([values]);
  await env.flush();
  const id = created.ids[0];
  if (id === undefined)
    throw new HttpError(500, 'CREATE_FAILED', 'Nothing was created.', 'Try again.');
  return { id };
}

/** `PATCH /api/records/:model/:id`, with `expect: { updatedAt }` against lost updates. */
export async function write(
  env: DynamicEnv,
  model: ModelMeta,
  id: number,
  body: unknown,
): Promise<void> {
  const request = asObject(body, 'The request');
  const values = inputValues(model, asObject(request['values'], 'values'));
  const expect =
    request['expect'] === undefined ? undefined : asObject(request['expect'], 'expect');
  const records = await one(env, model, id);
  await records.write(
    values,
    expect === undefined
      ? undefined
      : {
          expect: Object.fromEntries(
            Object.entries(expect).map(([k, v]) => [
              k,
              k === 'updatedAt' && typeof v === 'string' ? new Date(v) : v,
            ]),
          ),
        },
  );
  await env.flush();
}

/** `DELETE /api/records/:model/:id`. */
export async function remove(env: DynamicEnv, model: ModelMeta, id: number): Promise<void> {
  await (await one(env, model, id)).unlink();
}

/** `POST /api/records/:model/onchange`: what the form must change while the user types. */
export async function onchange(
  env: DynamicEnv,
  models: Readonly<Record<string, ModelMeta>>,
  model: ModelMeta,
  body: unknown,
): Promise<{ values: Record<string, unknown>; warnings: readonly string[] }> {
  const request = asObject(body, 'The request');
  const changed = asStringList(request['changed'], 'changed') ?? [];
  for (const key of changed)
    if (model.fields[key] === undefined)
      throw badRequest(`'${key}' is not a field.`, 'Send the changed field keys.');
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(asObject(request['values'] ?? {}, 'values')))
    if (model.fields[k] !== undefined && model.fields[k]?.kind !== 'one2many')
      values[k] = typeof v === 'object' && v !== null && 'id' in v ? (v as Ref).id : v;
  const id = typeof request['id'] === 'number' ? request['id'] : undefined;
  const result = await env
    .model(model.name)
    .onchange({ ...(id === undefined ? {} : { id }), values, changed });
  // Many2one values come back as ids: give them their display names, like every other response.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.values)) {
    if (model.fields[key] === undefined) continue; // fields the user may not read stay out
    out[key] = value;
  }
  for (const [key, value] of Object.entries(out)) {
    const f = model.fields[key];
    if (f?.kind !== 'many2one' || typeof value !== 'number' || f.target === undefined) continue;
    const target = models[f.target];
    if (target === undefined || target.recName === 'id') {
      out[key] = { id: value, name: `#${value}` } satisfies Ref;
      continue;
    }
    const [row] = (await env.model(f.target).browse([value]).load([target.recName])).read([
      target.recName,
    ]);
    out[key] = { id: value, name: String(row?.[target.recName] ?? `#${value}`) } satisfies Ref;
  }
  return { values: out, warnings: result.warnings };
}

/** `POST /api/records/:model/:id/transition/:name`: declared transitions only, with their guards and permissions. */
export async function transition(
  env: DynamicEnv,
  model: ModelMeta,
  id: number,
  name: string,
): Promise<void> {
  if (model.transitions[name] === undefined)
    throw notFound(`Transition '${name}' of ${model.name}`);
  await callTransition(await one(env, model, id), name);
  await env.flush();
}

/** `GET /api/records/:model/:id/trail`: the record's history, newest first. */
export async function trail(
  env: DynamicEnv,
  model: ModelMeta,
  id: number,
  before: number | undefined,
): Promise<readonly unknown[]> {
  return (await one(env, model, id)).trail({
    limit: 50,
    ...(before === undefined ? {} : { before }),
  });
}

/** `GET /api/records/:model/names?q=`: many2one pickers. */
export async function names(
  env: DynamicEnv,
  model: ModelMeta,
  query: string,
): Promise<readonly { id: number; name: string }[]> {
  const recName = model.recName;
  const field = model.fields[recName];
  const where =
    query === '' || field === undefined || recName === 'id'
      ? undefined
      : { [recName]: { ilike: `%${query}%` } };
  const found = await env
    .model(model.name)
    .search({ ...(where === undefined ? {} : { where }), limit: 12 });
  const rows = (await found.load(recName === 'id' ? [] : [recName])).read(
    recName === 'id' ? [] : [recName],
  );
  return rows.map((r) => ({
    id: Number(r['id']),
    name: recName === 'id' ? `#${r['id']}` : String(r[recName] ?? ''),
  }));
}

/** The meta of `name` for this user, or 404 (unknown models and unreadable ones look the same). */
export function modelOf(models: Readonly<Record<string, ModelMeta>>, name: string): ModelMeta {
  const model = models[name];
  if (model === undefined) throw notFound(`Model '${name}'`);
  return model;
}
