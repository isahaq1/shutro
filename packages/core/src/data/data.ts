/**
 * Module data (RFC 0017): records a module ships, identified by external ids (`module.name`), and references between
 * them. Declarations are plain values; {@link validateData} checks every name and reference when the registry is
 * built, so broken data never reaches a database.
 */
import { InvalidModuleError } from '../errors.js';
import type { Id } from '../model/id.js';
import type { AnyModel } from '../model/model.js';

const REF: unique symbol = Symbol.for('shutro.ref');
const LOCAL = /^[a-z][a-z0-9_]*$/;
const FULL = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** One record a module ships: created (`record`) or a dependency's record updated (`override`). */
export interface DataRecord {
  readonly kind: 'record' | 'override';
  readonly model: string;
  /** Local name for `record` (`'currency_bdt'`), full external id for `override` (`'base.main_company'`). */
  readonly name: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** Created once, then owned by the users: never updated or deleted by later loads. */
  readonly noupdate: boolean;
}

/** A reference to a data record, resolved to its id at load time. */
export interface DataRef {
  readonly [REF]: true;
  readonly model: string;
  readonly id: string;
}

/** True for a value made by {@link ref}. */
export function isRef(value: unknown): value is DataRef {
  return (
    typeof value === 'object' && value !== null && (value as { [REF]?: unknown })[REF] === true
  );
}

/**
 * A record the module ships, with external id `<module>.<name>`.
 * @example record('res.currency', 'currency_bdt', { name: 'BDT', rounding: '0.01' })
 */
export function record(
  model: string,
  name: string,
  values: Readonly<Record<string, unknown>>,
  options: { readonly noupdate?: boolean } = {},
): DataRecord {
  if (!LOCAL.test(name))
    throw new InvalidModuleError(
      `${JSON.stringify(name)} is not a data record name.`,
      "Use a local snake_case name such as 'currency_bdt'; the module name is added (base.currency_bdt).",
    );
  return Object.freeze({
    kind: 'record',
    model,
    name,
    values,
    noupdate: options.noupdate === true,
  });
}

/**
 * Updates a record a dependency ships (`'base.main_company'`): same model, update only.
 * @example override('res.company', 'base.main_company', { name: 'Acme Ltd' })
 */
export function override(
  model: string,
  id: string,
  values: Readonly<Record<string, unknown>>,
): DataRecord {
  if (!FULL.test(id))
    throw new InvalidModuleError(
      `${JSON.stringify(id)} is not an external id.`,
      "Override a dependency's record by its full id, e.g. 'base.main_company'.",
    );
  return Object.freeze({ kind: 'override', model, name: id, values, noupdate: false });
}

/**
 * A reference to a data record of `model`, usable wherever an id of `model` is (many2one values, x2many `link` /
 * `set`). Checked when the registry is built; resolved when data is loaded.
 */
export function ref<M extends string>(model: M, id: string): Id<M> {
  if (!FULL.test(id))
    throw new InvalidModuleError(
      `${JSON.stringify(id)} is not an external id.`,
      "Refer to records by their full id, e.g. ref('res.currency', 'base.currency_bdt').",
    );
  return Object.freeze({ [REF]: true, model, id }) as unknown as Id<M>;
}

/** The full external id of a record of `module`. */
export function fullId(module: string, record: DataRecord): string {
  return record.kind === 'override' ? record.name : `${module}.${record.name}`;
}

/** Every reference inside a value (nested commands and arrays included). */
export function refsIn(value: unknown, out: DataRef[] = []): DataRef[] {
  if (isRef(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    for (const v of Object.values(value)) refsIn(v, out);
  return out;
}

interface DataModule {
  readonly name: string;
  readonly depends: readonly DataModule[];
  readonly data: readonly DataRecord[];
}

function closure(module: DataModule, out = new Set<string>()): Set<string> {
  for (const d of module.depends) {
    if (out.has(d.name)) continue;
    out.add(d.name);
    closure(d, out);
  }
  return out;
}

/**
 * Checks the data of every module, in load order (RFC 0017 §4): record names, duplicates, override targets, field
 * names, and that every reference names a record of the given model declared earlier in the module or in a
 * dependency. Returns external id → model. @throws {InvalidModuleError}
 */
export function validateData(
  modules: readonly DataModule[],
  models: ReadonlyMap<string, { readonly model: AnyModel }>,
): ReadonlyMap<string, { readonly module: string; readonly model: string }> {
  const index = new Map<string, { module: string; model: string }>();
  for (const module of modules) {
    const deps = closure(module);
    const visible = (id: string): { module: string; model: string } | undefined => {
      const found = index.get(id);
      return found !== undefined && (found.module === module.name || deps.has(found.module))
        ? found
        : undefined;
    };
    for (const rec of module.data) {
      const id = fullId(module.name, rec);
      const where = `Data record '${id}' of module '${module.name}'`;
      const target = models.get(rec.model)?.model;
      if (target === undefined)
        throw new InvalidModuleError(
          `${where} is of model '${rec.model}', which is not installed.`,
          'Fix the model name, or depend on the module that defines it.',
        );
      for (const key of Object.keys(rec.values))
        if (target.fields[key] === undefined)
          throw new InvalidModuleError(
            `${where} sets '${key}', which is not a field of ${rec.model}.`,
            `Fields: ${Object.keys(target.fields).join(', ')}.`,
          );
      for (const r of refsIn(rec.values)) {
        const found = visible(r.id);
        if (found === undefined)
          throw new InvalidModuleError(
            `${where} refers to '${r.id}', which is not declared before it in this module or in a dependency.`,
            'Declare the referenced record first (data loads in order), or add the module that ships it to depends.',
          );
        if (found.model !== r.model)
          throw new InvalidModuleError(
            `${where} refers to '${r.id}' as ${r.model}, but it is a ${found.model}.`,
            'Fix the model in ref().',
          );
      }
      if (rec.kind === 'override') {
        const owner = index.get(id);
        if (owner === undefined || !deps.has(owner.module))
          throw new InvalidModuleError(
            `${where} overrides '${id}', which no dependency declares.`,
            'Override records of modules this one depends on.',
          );
        if (owner.model !== rec.model)
          throw new InvalidModuleError(
            `${where} overrides '${id}' as ${rec.model}, but it is a ${owner.model}.`,
            "Use the record's model.",
          );
        continue;
      }
      if (index.has(id))
        throw new InvalidModuleError(
          `${where} is declared twice.`,
          'External ids are unique: rename one of them.',
        );
      index.set(id, { module: module.name, model: rec.model });
    }
  }
  return index;
}
