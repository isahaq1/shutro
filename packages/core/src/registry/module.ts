/**
 * `defineModule()` (RFC 0002 §7.1): a named, versioned unit that depends on other modules (by object, so a
 * dependency cycle can't even be written) and owns models.
 */
import { DuplicateModelError, InvalidModuleError } from '../errors.js';
import { type AnyModel, humanize, isModel } from '../model/model.js';

/** A module as `defineModule` returns it. */
export interface Module {
  readonly name: string;
  readonly version: string;
  readonly label: string;
  readonly depends: readonly Module[];
  readonly models: readonly AnyModel[];
}

/** The argument of {@link defineModule}. */
export interface ModuleDefinition {
  /** Unique, snake_case, stable (stored in the database for migrations). */
  readonly name: string;
  /** `major.minor.patch`. Defaults to `0.0.0`. */
  readonly version?: string;
  /** Human label; defaults to the humanized name. */
  readonly label?: string;
  /** Direct dependencies, as module objects. Transitive ones are collected by the registry. */
  readonly depends?: readonly Module[];
  /** Models this module owns. */
  readonly models: readonly AnyModel[];
}

const MODULE_NAME = /^[a-z][a-z0-9_]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;

const modules = new WeakSet<object>();

/** True when `value` was produced by {@link defineModule}. */
export function isModule(value: unknown): value is Module {
  return typeof value === 'object' && value !== null && modules.has(value);
}

/**
 * Defines a module.
 *
 * @example
 * ```ts
 * export default defineModule({ name: 'sale_stock', depends: [sale, stock], models: [SaleStockPicking] });
 * ```
 * @throws {InvalidModuleError} for a bad name or version, or `depends` / `models` entries that aren't modules / models.
 * @throws {DuplicateModelError} when two models in the list share a name.
 */
export function defineModule(definition: ModuleDefinition): Module {
  const { name } = definition;
  if (typeof name !== 'string' || !MODULE_NAME.test(name)) {
    throw new InvalidModuleError(
      `${JSON.stringify(name)} is not a valid module name.`,
      "Use lower-case snake_case such as 'sale_stock'; the name is stored in the database, so keep it stable.",
    );
  }
  const version = definition.version ?? '0.0.0';
  if (!VERSION.test(version)) {
    throw new InvalidModuleError(
      `Module '${name}' has version ${JSON.stringify(version)}.`,
      "Use 'major.minor.patch', e.g. '1.0.0'.",
    );
  }
  const depends = definition.depends ?? [];
  depends.forEach((dep, i) => {
    if (!isModule(dep)) {
      throw new InvalidModuleError(
        `Module '${name}' depends[${i}] is not a module.`,
        'Import the dependency module object (the result of defineModule) and pass it; names are not accepted, so typos are impossible.',
      );
    }
  });
  const seen = new Set<string>();
  definition.models.forEach((model, i) => {
    if (!isModel(model)) {
      throw new InvalidModuleError(
        `Module '${name}' models[${i}] is not a model.`,
        'Pass the result of defineModel().',
      );
    }
    if (seen.has(model.name)) throw new DuplicateModelError(model.name, [name, name]);
    seen.add(model.name);
  });
  const module: Module = Object.freeze({
    name,
    version,
    label: definition.label ?? humanize(name),
    depends: Object.freeze([...depends]),
    models: Object.freeze([...definition.models]),
  });
  modules.add(module);
  return module;
}
