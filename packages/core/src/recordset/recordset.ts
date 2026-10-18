/**
 * Recordset runtime (RFC 0004): identity map per transaction, prefetch groups, batched loads, typed access, and
 * the entry points of writes (see writes.ts) and computes (see compute.ts).
 */

import type { AuditEntry } from '@shutro/audit';
import { resolveTranslation, type Translations } from '@shutro/i18n';
import { compile, type SqlFragment, sql } from '@shutro/sql';
import { Decimal as DecimalJs } from 'decimal.js';
import { type Env, internalsOf, type ScopeInternals } from '../env/env.js';
import {
  FieldNotLoadedError,
  InvalidFieldError,
  MissingRecordError,
  SingletonError,
} from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { type Currency, defineCurrency } from '../money/currency.js';
import { Money } from '../money/money.js';
import { defineUom, Quantity, type Uom } from '../money/quantity.js';
import type { RoundingMethod } from '../money/rounding.js';
import type { RegisteredModel, Registry } from '../registry/registry.js';
import { targetOf } from '../registry/registry.js';
import { type AggregateQueryRaw, runAggregate } from './aggregate.js';
import { flushAudit, trailOf } from './audit.js';
import {
  assignComputed,
  type ComputeHost,
  type ComputeSpec,
  computeFields,
  recompute,
} from './compute.js';
import { checkConstraints } from './constraints.js';
import { compileDomain, compileOrder, scopingConditions, type TranslationScope } from './domain.js';
import {
  type OnchangeHost,
  type OnchangeInputRaw,
  type OnchangeResultRaw,
  runOnchange,
} from './onchange.js';
import { junctionTable } from './relations.js';
import {
  assertAccess,
  assertDomainFields,
  assertFields,
  explainDenied,
  loadedValue,
  readableKeys,
  ruleConditions,
} from './security.js';
import { assignNumbers } from './sequences.js';
import { sourceOf } from './source.js';
import { availableTransitions, runTransition } from './transitions.js';
import { companyValue } from './values.js';
import {
  assertExpected,
  createRecords,
  flushDirty,
  unlinkRecords,
  type WriteHost,
  writeRecords,
} from './writes.js';

const CHUNK = 1000;

// ------------------------------------------------------------------------------------------------ cache

/** Field values of one record. Scalars as values, many2one as id | null, x2many as id arrays. */
type Values = Map<string, unknown>;

/** The per-transaction identity map and value-object caches (RFC 0004 §7.4). */
export interface RecordCache {
  readonly records: Map<string, Map<number, Values>>;
  readonly currencies: Map<number, Currency>;
  readonly uoms: Map<number, Uom>;
}

/** @internal */
export function createRecordCache(): RecordCache {
  return { records: new Map(), currencies: new Map(), uoms: new Map() };
}

function valuesOf(
  cache: RecordCache,
  model: string,
  id: number,
  create = false,
): Values | undefined {
  let byId = cache.records.get(model);
  if (byId === undefined) {
    if (!create) return undefined;
    byId = new Map();
    cache.records.set(model, byId);
  }
  let values = byId.get(id);
  if (values === undefined && create) {
    values = new Map();
    byId.set(id, values);
  }
  return values;
}

// ---------------------------------------------------------------------------------------------- load specs

type NormalizedSpec = ComputeSpec;

function isX2Many(field: Field): boolean {
  return field.kind === 'one2many' || field.kind === 'many2many';
}

/** Stored, non-binary, not x2many (RFC 0004 §6.1). */
export function defaultKeys(model: AnyModel): string[] {
  return Object.entries(model.fields)
    .filter(([, f]) => f.store && f.kind !== 'binary' && !isX2Many(f))
    .map(([key]) => key);
}

/** Adds the sibling currency / uom fields that monetary / quantity values need. */
function withSiblings(model: AnyModel, keys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    out.add(key);
    const field = model.fields[key] as
      | (Field & { currencyField?: string; uomField?: string })
      | undefined;
    if (field?.currencyField !== undefined) out.add(field.currencyField);
    if (field?.uomField !== undefined) out.add(field.uomField);
  }
  return out;
}

function normalizeSpec(loader: Loader, model: AnyModel, spec: unknown): NormalizedSpec {
  // Default projections leave out fields the user may not read (RFC 0014 §7.4); explicit keys are checked instead.
  const defaults = (): Set<string> =>
    new Set(readableKeys(loader.internals, model, withSiblings(model, defaultKeys(model))));
  if (spec === undefined || spec === true) return { fields: defaults(), relations: new Map() };
  if (Array.isArray(spec)) {
    for (const key of spec) {
      const field = model.fields[String(key)];
      if (field === undefined || isX2Many(field)) {
        throw new FieldNotLoadedError(
          model.name,
          String(key),
          `'${String(key)}' is not a loadable field of ${model.name}; list scalar or many2one fields, or use { ${String(key)}: true } for relations.`,
        );
      }
    }
    return { fields: withSiblings(model, ['id', ...spec.map(String)]), relations: new Map() };
  }
  const relations = new Map<string, NormalizedSpec>();
  for (const [key, sub] of Object.entries(spec as Record<string, unknown>)) {
    if (sub === undefined || sub === false) continue;
    const field = model.fields[key];
    const target = field === undefined ? undefined : targetOf(field);
    if (field === undefined || target === undefined) {
      throw new FieldNotLoadedError(
        model.name,
        key,
        `'${key}' is not a relation of ${model.name}; nested load specs only take many2one, one2many and many2many fields.`,
      );
    }
    relations.set(key, normalizeSpec(loader, loader.registry.get(target).model, sub));
  }
  return { fields: defaults(), relations };
}

// ------------------------------------------------------------------------------------------------ loading

interface Loader {
  readonly env: Env;
  readonly internals: ScopeInternals;
  readonly registry: Registry;
}

function hydrate(
  loader: Loader,
  model: AnyModel,
  row: Record<string, unknown>,
  keys: Iterable<string>,
): number {
  const id = Number(row['id']);
  const values = valuesOf(loader.internals.cache, model.name, id, true) as Values;
  for (const key of keys) {
    const column = model.columns[key];
    if (column === undefined || key === 'id') continue;
    const field = model.fields[key] as Field;
    // The cache is authoritative within the transaction: a value written or computed here (possibly not flushed
    // yet) must not be replaced by the row's older value. Only fill keys that are not cached.
    if (values.has(key)) continue;
    values.set(key, loadedValue(loader.internals, field, row[column] ?? null));
  }
  return id;
}

/** Fetches the given fields for the records that don't have all of them cached. One query per 1,000 ids. */
async function fetchMissing(
  loader: Loader,
  model: AnyModel,
  ids: readonly number[],
  fields: ReadonlySet<string>,
  user = false,
): Promise<void> {
  const { cache } = loader.internals;
  const wanted = [...fields].filter((k) => k !== 'id' && model.columns[k] !== undefined);
  const missing = ids.filter((id) => {
    const values = valuesOf(cache, model.name, id);
    return values === undefined || wanted.some((k) => !values.has(k));
  });
  // User loads carry the read rules (RFC 0014 §7.3); engine loads do not.
  const rules = user ? ruleConditions(loader.internals, model, 'read') : [];
  const scope = rules.length === 0 ? sql.empty : sql` AND ${sql.join(rules, sql` AND `)}`;
  if (missing.length > 0 && wanted.length === 0) await assertExist(loader, model, missing, scope);
  if (missing.length > 0 && wanted.length > 0) {
    const columns = sql.join([sql.id('id'), ...wanted.map((k) => sql.id(model.columns[k] ?? ''))]);
    const seen = new Set<number>();
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const rows = await loader.internals.query<Record<string, unknown>>(
        compile(
          sql`SELECT ${columns} FROM ${sourceOf(loader.internals, model)} WHERE ${sql.id('id')} = ANY(${chunk})${scope}`,
        ),
      );
      for (const row of rows) seen.add(hydrate(loader, model, row, wanted));
    }
    const absent = missing.filter((id) => !seen.has(id));
    if (absent.length > 0) {
      if (rules.length > 0) await explainDenied(loader.internals, model, absent, 'read');
      throw new MissingRecordError(model.name, absent);
    }
  }
  // Even when every column was cached, the value objects behind monetary / quantity fields may not be.
  await ensureValueObjects(loader, model, ids, fields);
}

async function assertExist(
  loader: Loader,
  model: AnyModel,
  ids: readonly number[],
  scope: SqlFragment = sql.empty,
): Promise<void> {
  const rows = await loader.internals.query<{ id: number }>(
    compile(
      sql`SELECT ${sql.id('id')} FROM ${sourceOf(loader.internals, model)} WHERE ${sql.id('id')} = ANY(${[...ids]})${scope}`,
    ),
  );
  const found = new Set(rows.map((r) => Number(r.id)));
  const absent = ids.filter((id) => !found.has(id));
  if (absent.length > 0) {
    if (scope !== sql.empty) await explainDenied(loader.internals, model, absent, 'read');
    throw new MissingRecordError(model.name, absent);
  }
  for (const id of ids) valuesOf(loader.internals.cache, model.name, id, true);
}

/** Loads the currencies / units referenced by monetary / quantity fields, through the record cache. */
async function ensureValueObjects(
  loader: Loader,
  model: AnyModel,
  ids: readonly number[],
  fields: ReadonlySet<string>,
): Promise<void> {
  const { cache } = loader.internals;
  const needed = { currency: new Set<number>(), uom: new Set<number>() };
  for (const key of fields) {
    const field = model.fields[key] as
      | (Field & { currencyField?: string; uomField?: string })
      | undefined;
    if (field === undefined) continue;
    const ref =
      field.currencyField !== undefined
        ? ({ kind: 'currency', key: field.currencyField } as const)
        : field.uomField !== undefined
          ? ({ kind: 'uom', key: field.uomField } as const)
          : undefined;
    if (ref === undefined) continue;
    for (const id of ids) {
      const value = valuesOf(cache, model.name, id)?.get(ref.key);
      if (
        typeof value === 'number' &&
        !(ref.kind === 'currency' ? cache.currencies : cache.uoms).has(value)
      )
        needed[ref.kind].add(value);
    }
  }
  if (needed.currency.size > 0) {
    const currency = loader.registry.get('res.currency').model;
    const ids = [...needed.currency];
    await fetchMissing(loader, currency, ids, new Set(defaultKeys(currency)));
    for (const id of ids) {
      const v = valuesOf(cache, currency.name, id);
      const method =
        typeof v?.get('roundingMethod') === 'string'
          ? (String(v.get('roundingMethod')).replaceAll('_', '-') as RoundingMethod)
          : undefined;
      const places = v?.get('decimalPlaces');
      cache.currencies.set(
        id,
        defineCurrency({
          code: String(v?.get('name')),
          rounding: v?.get('rounding') as DecimalJs,
          ...(method === undefined ? {} : { roundingMethod: method }),
          ...(typeof places === 'number' ? { decimalPlaces: places } : {}),
          id,
        }),
      );
    }
  }
  if (needed.uom.size > 0) {
    const uom = loader.registry.get('uom.uom').model;
    const ids = [...needed.uom];
    await fetchMissing(loader, uom, ids, new Set(defaultKeys(uom)));
    for (const id of ids) {
      const v = valuesOf(cache, uom.name, id);
      cache.uoms.set(
        id,
        defineUom({
          name: String(v?.get('name')),
          category: String(v?.get('category')),
          ratio: v?.get('ratio') as DecimalJs,
          rounding: v?.get('rounding') as DecimalJs,
          id,
        }),
      );
    }
  }
}

/** Loads the relation `key` (x2many) of the parents whose child list isn't cached, with the sub-spec's fields, in one query. */
async function fetchX2Many(
  loader: Loader,
  model: AnyModel,
  key: string,
  parents: readonly number[],
  sub: NormalizedSpec,
  user = false,
): Promise<number[]> {
  const { cache } = loader.internals;
  const field = model.fields[key] as Field & { target: string; inverseField?: string };
  const target = loader.registry.get(field.target).model;
  const missing = parents.filter((id) => !valuesOf(cache, model.name, id)?.has(key));
  if (missing.length > 0) await loader.internals.flush(target.name); // re-pointed children must be visible
  if (user) {
    assertAccess(loader.internals, target, 'read');
    assertFields(loader.internals, target, sub.fields, 'read');
  }
  const rules = user ? ruleConditions(loader.internals, target, 'read') : [];
  const scope = rules.length === 0 ? sql.empty : sql` AND ${sql.join(rules, sql` AND `)}`;
  const wanted = [...sub.fields].filter((k) => k !== 'id' && target.columns[k] !== undefined);
  const children = new Map<number, number[]>();
  for (const id of missing) children.set(id, []);
  if (missing.length > 0) {
    const t = sql.id('t');
    const columns = sql.join([
      sql`${t}.${sql.id('id')}`,
      ...wanted.map((k) => sql`${t}.${sql.id(target.columns[k] ?? '')}`),
    ]);
    const order = compileOrder(target, undefined, translationScope(loader.internals));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      let rows: readonly Record<string, unknown>[];
      if (field.kind === 'one2many') {
        const inverse = sql.id(target.columns[field.inverseField ?? ''] ?? '');
        rows = await loader.internals.query(
          compile(
            sql`SELECT ${t}.${inverse} AS ${sql.id('parent_id')}, ${columns} FROM ${sourceOf(loader.internals, target)} AS ${t} WHERE ${t}.${inverse} = ANY(${chunk})${scope} ORDER BY ${order}`,
          ),
        );
      } else {
        const j = junctionTable(model, field, target);
        rows = await loader.internals.query(
          compile(
            sql`SELECT ${sql.id('rel', j.sourceColumn)} AS ${sql.id('parent_id')}, ${columns} FROM ${sql.id(j.table)} AS ${sql.id('rel')} INNER JOIN ${sql.id(target.table)} AS ${t} ON ${t}.${sql.id('id')} = ${sql.id('rel', j.targetColumn)} WHERE ${sql.id('rel', j.sourceColumn)} = ANY(${chunk})${scope} ORDER BY ${order}`,
          ),
        );
      }
      for (const row of rows) {
        const childId = hydrate(loader, target, row, wanted);
        children.get(Number(row['parent_id']))?.push(childId);
      }
    }
    for (const [parent, ids] of children)
      (valuesOf(cache, model.name, parent, true) as Values).set(key, ids);
  }
  const all: number[] = [];
  for (const id of parents)
    for (const child of (valuesOf(cache, model.name, id)?.get(key) as number[] | undefined) ?? [])
      all.push(child);
  const unique = [...new Set(all)];
  // Lists cached by x2many commands hold ids whose fields were never fetched: load the sub-spec for every child.
  await fetchMissing(loader, target, unique, sub.fields, user);
  await computeNonStored(loader, target, unique, sub.fields);
  return unique;
}

/** Computes the requested non-stored computed keys that are missing from the cache (RFC 0008 §7.4). */
async function computeNonStored(
  loader: Loader,
  model: AnyModel,
  ids: readonly number[],
  keys: ReadonlySet<string>,
): Promise<void> {
  const graph = loader.registry.compute;
  const fields = [...keys]
    .filter((k) => {
      const f = model.fields[k];
      return f?.computed === true && !f.store;
    })
    .map((k) => graph.field(model.name, k))
    .filter((f) => f !== undefined);
  if (fields.length === 0) return;
  const { cache } = loader.internals;
  const missing = ids.filter((id) => {
    const values = valuesOf(cache, model.name, id);
    return values === undefined || fields.some((f) => !values.has(f.key));
  });
  await computeFields(computeHost(loader), model, missing, fields);
}

/** Loads `spec` for `ids` of `model`, recursively (RFC 0004 §7.1). */
async function loadInto(
  loader: Loader,
  model: AnyModel,
  ids: readonly number[],
  spec: NormalizedSpec,
  user = false,
): Promise<void> {
  if (ids.length === 0) return;
  if (user) {
    assertAccess(loader.internals, model, 'read');
    assertFields(loader.internals, model, spec.fields, 'read');
  }
  // Pending triggers first, so stored computes are fresh when they are read (RFC 0008 §7.3).
  if (!loader.internals.compute.recomputing && loader.internals.hasPending())
    await recompute(computeHost(loader));
  await fetchMissing(loader, model, ids, spec.fields, user);
  await computeNonStored(loader, model, ids, spec.fields);
  for (const [key, sub] of spec.relations) {
    const field = model.fields[key] as Field & { target: string };
    if (field.kind === 'many2one') {
      const targetIds = new Set<number>();
      for (const id of ids) {
        const value = valuesOf(loader.internals.cache, model.name, id)?.get(key);
        if (typeof value === 'number') targetIds.add(value);
      }
      await loadInto(loader, loader.registry.get(field.target).model, [...targetIds], sub, user);
    } else {
      const children = await fetchX2Many(loader, model, key, ids, sub, user);
      const target = loader.registry.get(field.target).model;
      for (const [k, nested] of sub.relations) {
        await loadInto(
          loader,
          target,
          children,
          { fields: new Set(), relations: new Map([[k, nested]]) },
          user,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- recordsets

/** Ids shared by the records loaded together (RFC 0004 §7.3). */
interface Group {
  readonly ids: readonly number[];
}

interface Pending {
  readonly parentModel: AnyModel;
  readonly key: string;
  /** The parent record(s) this set belongs to. */
  readonly own: readonly number[];
  /** Every parent of the prefetch group: loading fetches the relation for all of them. */
  readonly parents: readonly number[];
}

const prototypes = new WeakMap<AnyModel, typeof RecordSetImpl>();

/** @internal Runtime recordset. Typed through `RecordSet` / `Rec` / `PendingSet` (types.ts). */
export class RecordSetImpl {
  readonly env: Env;
  readonly registered: RegisteredModel;
  readonly modelName: string;
  readonly #ids: readonly number[] | undefined;
  readonly #group: Group | undefined;
  readonly #pending: Pending | undefined;

  constructor(
    env: Env,
    registered: RegisteredModel,
    ids: readonly number[] | undefined,
    group: Group | undefined,
    pending: Pending | undefined,
  ) {
    this.env = env;
    this.registered = registered;
    this.modelName = registered.model.name;
    this.#ids = ids;
    this.#group = group;
    this.#pending = pending;
  }

  get #loader(): Loader {
    const internals = internalsOf(this.env);
    return { env: this.env, internals, registry: internals.registry };
  }

  get model(): AnyModel {
    return this.registered.model;
  }

  get ids(): readonly number[] {
    if (this.#ids === undefined) {
      throw new FieldNotLoadedError(
        this.modelName,
        this.#pending?.key ?? 'ids',
        'This x2many relation was not loaded yet: await set.load() (or load it with the parent: load({ lines: true })).',
      );
    }
    return this.#ids;
  }

  get length(): number {
    return this.ids.length;
  }

  isEmpty(): boolean {
    return this.ids.length === 0;
  }

  #record(id: number): RecordSetImpl {
    const Ctor = recordClass(this.model);
    return new Ctor(this.env, this.registered, [id], this.#group ?? { ids: this.ids }, undefined);
  }

  *[Symbol.iterator](): Iterator<RecordSetImpl> {
    for (const id of this.ids) yield this.#record(id);
  }

  first(): RecordSetImpl {
    const id = this.ids[0];
    if (id === undefined) throw new SingletonError(this.modelName, 0, 'first');
    return this.#record(id);
  }

  ensureOne(): RecordSetImpl {
    if (this.ids.length !== 1)
      throw new SingletonError(this.modelName, this.ids.length, 'ensureOne');
    return this.first();
  }

  /** The record's id (singletons only). */
  get id(): number {
    return this.ensureOne().ids[0] as number;
  }

  map<T>(fn: (record: never, index: number) => T): T[] {
    return [...this].map((r, i) => fn(r as never, i));
  }

  filter(fn: (record: never, index: number) => boolean): RecordSetImpl {
    const kept = [...this].filter((r, i) => fn(r as never, i)).map((r) => r.ids[0] as number);
    return new (recordClass(this.model))(this.env, this.registered, kept, this.#group, undefined);
  }

  /** A `Currency` from a currency, a record reference or an id (loaded with the records' monetary fields). */
  #currencyOf(
    currency: Currency | { readonly id: number } | number | undefined,
  ): Currency | undefined {
    if (currency === undefined) return undefined;
    if (typeof currency === 'object' && 'code' in currency) return currency;
    const id = typeof currency === 'number' ? currency : currency.id;
    const found = this.#loader.internals.cache.currencies.get(id);
    if (found === undefined)
      throw new FieldNotLoadedError(
        this.model.name,
        'currency',
        `Currency ${id} is not loaded: pass a Currency, or sum records whose monetary fields are loaded in it.`,
      );
    return found;
  }

  mapped(key: string): unknown[] {
    return [...this].map((r) => (r as unknown as Record<string, unknown>)[key]);
  }

  sum(key: string, currency?: Currency | { readonly id: number } | number): unknown {
    const kind = this.model.fields[key]?.kind;
    const values = this.mapped(key).filter((v) => v !== null && v !== undefined);
    if (kind === 'monetary') return Money.sum(values as Money[], this.#currencyOf(currency));
    if (kind === 'decimal')
      return values.reduce<DecimalJs>((total, v) => total.plus(v as DecimalJs), new DecimalJs(0));
    if (kind === 'integer' || kind === 'float')
      return values.reduce<number>((total, v) => total + (v as number), 0);
    throw new InvalidFieldError(
      `${this.model.name}.sum() needs an integer, float, decimal or monetary field; '${key}' is ${kind ?? 'not a field'}.`,
      'Sum a numeric field, or use mapped() and reduce the values yourself.',
    );
  }

  async load(spec?: unknown): Promise<RecordSetImpl> {
    const loader = this.#loader;
    const normalized = normalizeSpec(loader, this.model, spec);
    if (this.#pending !== undefined && this.#ids === undefined) {
      const { parentModel, key, parents, own } = this.#pending;
      await fetchX2Many(loader, parentModel, key, parents, normalized, true);
      const childrenOf = (p: number): number[] =>
        (valuesOf(loader.internals.cache, parentModel.name, p)?.get(key) as number[] | undefined) ??
        [];
      const mine = own.flatMap(childrenOf);
      const all = [...new Set(parents.flatMap(childrenOf))];
      for (const [k, nested] of normalized.relations) {
        await loadInto(
          loader,
          this.model,
          all,
          { fields: new Set(), relations: new Map([[k, nested]]) },
          true,
        );
      }
      return new (recordClass(this.model))(
        this.env,
        this.registered,
        mine,
        { ids: all },
        undefined,
      );
    }
    const group = this.#group?.ids ?? this.ids;
    await loadInto(loader, this.model, group, normalized, true);
    return new (recordClass(this.model))(
      this.env,
      this.registered,
      this.ids,
      this.#group,
      undefined,
    );
  }

  #host(): WriteHost {
    return writeHost(this.#loader);
  }

  /** Updates the records in the cache now; flushed at the next flush point. */
  async write(
    values: Readonly<Record<string, unknown>>,
    options: { readonly expect?: Readonly<Record<string, unknown>> } = {},
  ): Promise<void> {
    const ids = await this.resolveIds();
    if (options.expect !== undefined)
      await assertExpected(this.#loader.internals, this.model, ids, options.expect);
    await writeRecords(this.#host(), this.model, ids, values);
  }

  /** Deletes the records now. */
  async unlink(): Promise<void> {
    await unlinkRecords(this.#host(), this.model, await this.resolveIds());
  }

  /** Ids of a pending x2many set, loading them if needed. */
  async resolveIds(): Promise<readonly number[]> {
    if (this.#ids !== undefined) return this.#ids;
    return (await this.load([])).ids;
  }

  read(keys: readonly string[]): Record<string, unknown>[] {
    return [...this].map((r) => {
      const row: Record<string, unknown> = { id: r.ids[0] };
      for (const key of keys) row[key] = plain(r.fieldValue(key), this.model.fields[key]);
      return row;
    });
  }

  toJSON(): readonly number[] {
    return this.ids;
  }

  /** The full translation map of a translatable field of a singleton (`null` when empty). */
  translations(key: string): Translations | null {
    const field = this.model.fields[key];
    if (field === undefined || !field.translate)
      throw new FieldNotLoadedError(this.modelName, key, `'${key}' is not a translatable field.`);
    const values = valuesOf(internalsOf(this.env).cache, this.modelName, this.id);
    if (values === undefined || !values.has(key))
      throw new FieldNotLoadedError(
        this.modelName,
        key,
        `Load it first: await records.load(['${key}']).`,
      );
    const raw = values.get(key);
    return raw === null || raw === undefined ? null : (raw as Translations);
  }

  /** The audit rows of these records, newest first (RFC 0013 §7.4). Pending changes are flushed first. */
  async trail(
    options: {
      readonly field?: string;
      readonly limit?: number;
      readonly action?: AuditEntry['action'];
    } = {},
  ): Promise<AuditEntry[]> {
    const internals = internalsOf(this.env);
    assertAccess(internals, this.model, 'read');
    return trailOf(internals, this.model, await this.resolveIds(), options);
  }

  /** Numbers unnumbered records of a manual sequence field (RFC 0012 §7.4). */
  async assignNumber(
    key: string,
    options: { readonly date?: string | undefined } = {},
  ): Promise<void> {
    await assignNumbers(
      computeHost(this.#loader),
      this.model,
      await this.resolveIds(),
      key,
      options,
    );
  }

  /** @internal Runs a transition of state field `key` on these records (RFC 0010 §7.2). */
  async transition(key: string, name: string): Promise<void> {
    await runTransition(computeHost(this.#loader), this.model, await this.resolveIds(), key, name);
  }

  /** Transition names the current state allows (singleton, state loaded). Defaults to the model's state field. */
  transitions(key?: string): string[] {
    const stateKey =
      key ??
      Object.entries(this.model.fields)
        .filter(([, f]) => f.kind === 'state')
        .map(([k]) => k)[0];
    if (stateKey === undefined) return [];
    return availableTransitions(this.model, stateKey, this.fieldValue(stateKey));
  }

  /** @internal Assigns a computed field of a singleton from inside its compute (RFC 0008 §7.5). */
  assign(key: string, value: unknown): void {
    assignComputed(computeHost(this.#loader), this.model, this.id, key, value);
  }

  /** @internal Reads field `key` of a singleton from the cache. */
  fieldValue(key: string): unknown {
    const id = this.ids[0];
    const field = this.model.fields[key];
    if (id === undefined || field === undefined)
      throw new FieldNotLoadedError(
        this.modelName,
        key,
        `'${key}' is not a field of ${this.modelName}.`,
      );
    const internals = internalsOf(this.env);
    if (field.groups.read.length > 0) assertFields(internals, this.model, [key], 'read');
    const { cache } = internals;
    const values = valuesOf(cache, this.modelName, id);
    if (field.kind === 'one2many' || field.kind === 'many2many') {
      const target = this.#loader.registry.get(targetOf(field) ?? '');
      const children = values?.get(key) as number[] | undefined;
      const group = this.#group?.ids ?? [id];
      if (children === undefined) {
        return new (recordClass(target.model))(this.env, target, undefined, undefined, {
          parentModel: this.model,
          key,
          own: [id],
          parents: group,
        });
      }
      const groupChildren = group.flatMap(
        (p) => (valuesOf(cache, this.modelName, p)?.get(key) as number[] | undefined) ?? [],
      );
      return new (recordClass(target.model))(
        this.env,
        target,
        children,
        { ids: groupChildren },
        undefined,
      );
    }
    if (values === undefined || !values.has(key)) {
      const hint = field.computed
        ? field.store
          ? `It is computed and pending recompute (or not loaded): await records.load(['${key}']) or env.flush() first.`
          : `It is computed on load: await records.load(['${key}']).`
        : `Load it first: await records.load(['${key}'])${field.kind === 'many2one' ? ` or load({ ${key}: true }) for the related record` : ''}.`;
      throw new FieldNotLoadedError(this.modelName, key, hint);
    }
    const raw = field.companyDependent
      ? companyValue(field, values.get(key), this.env.companyId)
      : values.get(key);
    if (field.translate) {
      return resolveTranslation(
        raw as Translations | null,
        this.env.lang,
        internalsOf(this.env).sourceLang,
      );
    }
    if (field.kind === 'many2one') {
      if (raw === null) return null;
      const target = this.#loader.registry.get(targetOf(field) ?? '');
      const group = this.#group?.ids ?? [id];
      const targetIds = [
        ...new Set(
          group
            .map((p) => valuesOf(cache, this.modelName, p)?.get(key))
            .filter((v): v is number => typeof v === 'number'),
        ),
      ];
      const Ctor = recordClass(target.model);
      return new Ctor(this.env, target, [raw as number], { ids: targetIds }, undefined);
    }
    if (field.kind === 'monetary') {
      if (raw === null) return null;
      const currencyId = values.get((field as unknown as { currencyField: string }).currencyField);
      if (currencyId === null) return null; // no currency, no Money (e.g. a draft line without its order yet)
      const currency =
        typeof currencyId === 'number' ? cache.currencies.get(currencyId) : undefined;
      if (currency === undefined) {
        throw new FieldNotLoadedError(
          this.modelName,
          key,
          'The currency of this monetary field is not loaded; load the field through the ORM (search/load), which loads currencies with it.',
        );
      }
      return Money.of(raw as DecimalJs, currency);
    }
    if (field.kind === 'quantity') {
      if (raw === null) return null;
      const uomId = values.get((field as unknown as { uomField: string }).uomField);
      const uom = typeof uomId === 'number' ? cache.uoms.get(uomId) : undefined;
      if (uom === undefined) return null;
      return Quantity.of(raw as DecimalJs, uom);
    }
    return raw;
  }
}

function plain(value: unknown, field: Field | undefined): unknown {
  if (value instanceof RecordSetImpl)
    return field?.kind === 'many2one' ? value.ids[0] : [...value.ids];
  if (value instanceof Money || value instanceof Quantity) return value.toJSON();
  if (value instanceof Date) return value.toISOString();
  if (DecimalJs.isDecimal(value)) return (value as DecimalJs).toFixed();
  return value;
}

/** One subclass per model with an accessor per field, created on first use. Computed fields get a setter. */
function recordClass(model: AnyModel): typeof RecordSetImpl {
  let Ctor = prototypes.get(model);
  if (Ctor === undefined) {
    Ctor = class extends RecordSetImpl {};
    for (const [key, field] of Object.entries(model.fields)) {
      if (key === 'id') continue;
      Object.defineProperty(Ctor.prototype, key, {
        get(this: RecordSetImpl) {
          return this.fieldValue(key);
        },
        ...(field.computed
          ? {
              set(this: RecordSetImpl, value: unknown) {
                this.assign(key, value);
              },
            }
          : {}),
        enumerable: true,
      });
    }
    // Model methods (declared and generated transitions) are callable on every recordset of the model.
    for (const [name, fn] of Object.entries(model.methods))
      Object.defineProperty(Ctor.prototype, name, {
        value: fn,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    prototypes.set(model, Ctor);
  }
  return Ctor;
}

function recordsetOf(loader: Loader, model: AnyModel, ids: readonly number[]): RecordSetImpl {
  const Ctor = recordClass(model);
  return new Ctor(
    loader.env,
    loader.registry.get(model.name),
    [...ids],
    { ids: [...ids] },
    undefined,
  );
}

function computeHost(loader: Loader): ComputeHost {
  return {
    internals: loader.internals,
    load: (model, ids, spec) => loadInto(loader, model, ids, spec),
    valueObjects: (model, ids, fields) => ensureValueObjects(loader, model, ids, fields),
    values: (model, id, create) => valuesOf(loader.internals.cache, model, id, create),
    recordset: (model, ids) => recordsetOf(loader, model, ids),
  };
}

function onchangeHost(loader: Loader): OnchangeHost {
  const write = writeHost(loader);
  return {
    ...computeHost(loader),
    defaults: write.defaults,
    children: write.children,
    read: (model, ids, keys) => recordsetOf(loader, model, ids).read(keys),
  };
}

function writeHost(loader: Loader): WriteHost {
  return {
    internals: loader.internals,
    fetch: (model, ids, fields) => fetchMissing(loader, model, ids, fields),
    ensureValueObjects: (model, ids, fields) => ensureValueObjects(loader, model, ids, fields),
    defaults: (model) => withSiblings(model, defaultKeys(model)),
    values: (model, id, create) => valuesOf(loader.internals.cache, model, id, create),
    children: async (model, id, key) => {
      await fetchX2Many(loader, model, key, [id], {
        fields: new Set(['id']),
        relations: new Map(),
      });
      return [
        ...((valuesOf(loader.internals.cache, model.name, id)?.get(key) as number[] | undefined) ??
          []),
      ];
    },
    recordset: (model, ids) => recordsetOf(loader, model, ids),
  };
}

/** True when the domain has a relation path or an x2many `any` / `none` (it reads other models' tables). */
function followsRelations(
  model: AnyModel,
  where: Readonly<Record<string, unknown>> | undefined,
): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === 'or' || key === 'and') {
      if (
        Array.isArray(value) &&
        value.some((d) => followsRelations(model, d as Record<string, unknown>))
      )
        return true;
    } else if (key === 'not') {
      if (followsRelations(model, value as Record<string, unknown>)) return true;
    } else if (key.includes('.')) return true;
    else {
      const kind = model.fields[key]?.kind;
      if (kind === 'one2many' || kind === 'many2many') return true;
    }
  }
  return false;
}

function translationScope(internals: ScopeInternals): TranslationScope {
  return {
    lang: internals.env.lang,
    source: internals.sourceLang,
    company: internals.env.companyId,
    ...(internals.asOf === undefined ? {} : { from: (m: AnyModel) => sourceOf(internals, m) }),
  };
}

/** @internal The currency value object of a `res.currency` id, loaded through the cache. */
export async function currencyById(internals: ScopeInternals, id: number): Promise<Currency> {
  const cached = internals.cache.currencies.get(id);
  if (cached !== undefined) return cached;
  const loader: Loader = { env: internals.env, internals, registry: internals.registry };
  const currency = internals.registry.get('res.currency').model;
  await fetchMissing(loader, currency, [id], new Set(defaultKeys(currency)));
  const v = valuesOf(internals.cache, currency.name, id);
  const method =
    typeof v?.get('roundingMethod') === 'string'
      ? (String(v.get('roundingMethod')).replaceAll('_', '-') as RoundingMethod)
      : undefined;
  const places = v?.get('decimalPlaces');
  const built = defineCurrency({
    code: String(v?.get('name')),
    rounding: v?.get('rounding') as DecimalJs,
    ...(method === undefined ? {} : { roundingMethod: method }),
    ...(typeof places === 'number' ? { decimalPlaces: places } : {}),
    id,
  });
  internals.cache.currencies.set(id, built);
  return built;
}

/** @internal The currency id of a company (`res.company.currency`). */
export async function companyCurrencyId(
  internals: ScopeInternals,
  company: number,
): Promise<number> {
  const loader: Loader = { env: internals.env, internals, registry: internals.registry };
  const model = internals.registry.get('res.company').model;
  await fetchMissing(loader, model, [company], new Set(['currency']));
  const id = valuesOf(internals.cache, model.name, company)?.get('currency');
  if (typeof id !== 'number') throw new MissingRecordError(model.name, [company]);
  return id;
}

/** @internal Flushes the unit of work (every model, or one): pending computes first, then the dirty records. */
export async function flushAll(internals: ScopeInternals, model?: string): Promise<void> {
  const loader: Loader = { env: internals.env, internals, registry: internals.registry };
  await recompute(computeHost(loader));
  await checkConstraints(computeHost(loader));
  await flushDirty(writeHost(loader), model);
  await flushAudit(internals, model);
}

/** @internal `env.model(name)`. */
export function modelRef(
  env: Env,
  name: string,
): {
  modelName: string;
  create(rows: readonly Readonly<Record<string, unknown>>[]): Promise<RecordSetImpl>;
  search(query?: unknown): Promise<RecordSetImpl>;
  browse(ids: readonly number[]): RecordSetImpl;
  onchange(input: OnchangeInputRaw): Promise<OnchangeResultRaw>;
  copy(rows: readonly Readonly<Record<string, unknown>>[]): Promise<RecordSetImpl>;
  aggregate(query: AggregateQueryRaw): Promise<Record<string, unknown>[]>;
} {
  const internals = internalsOf(env);
  const registered = internals.registry.get(name);
  const model = registered.model;
  const loader: Loader = { env, internals, registry: internals.registry };
  return {
    modelName: name,
    async create(rows: readonly Readonly<Record<string, unknown>>[]): Promise<RecordSetImpl> {
      const ids = await createRecords(writeHost(loader), model, rows);
      return new (recordClass(model))(env, registered, ids, { ids }, undefined);
    },
    async search(
      query: {
        where?: Record<string, unknown>;
        order?: readonly string[];
        limit?: number;
        offset?: number;
      } = {},
    ): Promise<RecordSetImpl> {
      assertAccess(internals, model, 'read');
      assertDomainFields(internals, model, query.where);
      assertFields(
        internals,
        model,
        (query.order ?? []).map((o) => o.split(' ')[0] ?? ''),
        'read',
      );
      // The search must see pending writes (and computes): of every model when a relation path reaches others.
      await internals.flush(followsRelations(model, query.where) ? undefined : model.name);
      const fields = new Set(
        readableKeys(internals, model, withSiblings(model, defaultKeys(model))),
      );
      const wanted = [...fields].filter((k) => k !== 'id' && model.columns[k] !== undefined);
      const columns = sql.join([
        sql.id('id'),
        ...wanted.map((k) => sql.id(model.columns[k] ?? '')),
      ]);
      const translation = translationScope(internals);
      const conditions = [
        ...compileDomain(
          model,
          query.where,
          translation,
          (n) => internals.registry.get(n).model,
          (target) => ruleConditions(internals, target, 'read'),
        ),
        ...scopingConditions(model, env),
        ...ruleConditions(internals, model, 'read'),
      ];
      const where =
        conditions.length === 0 ? sql.empty : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
      const limit = query.limit === undefined ? sql.empty : sql` LIMIT ${query.limit}`;
      const offset = query.offset === undefined ? sql.empty : sql` OFFSET ${query.offset}`;
      const rows = await internals.query<Record<string, unknown>>(
        compile(
          sql`SELECT ${columns} FROM ${sourceOf(internals, model)}${where} ORDER BY ${compileOrder(model, query.order, translation)}${limit}${offset}`,
        ),
      );
      const ids = rows.map((row) => hydrate(loader, model, row, wanted));
      await ensureValueObjects(loader, model, ids, fields);
      return new (recordClass(model))(env, registered, ids, { ids }, undefined);
    },
    browse(ids: readonly number[]): RecordSetImpl {
      return new (recordClass(model))(env, registered, [...ids], { ids: [...ids] }, undefined);
    },
    onchange: (input) => runOnchange(onchangeHost(loader), model, input),
    async copy(rows: readonly Readonly<Record<string, unknown>>[]): Promise<RecordSetImpl> {
      const ids = await createRecords(writeHost(loader), model, rows, { copy: true });
      return new (recordClass(model))(env, registered, ids, { ids }, undefined);
    },
    aggregate: (query) =>
      runAggregate(
        {
          internals,
          translation: translationScope(internals),
          currency: (id) => currencyById(internals, id),
        },
        model,
        query,
      ),
  };
}
