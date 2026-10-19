/**
 * `defineModule()` (RFC 0002 §7.1): a named, versioned unit that depends on other modules (by object, so a
 * dependency cycle can't even be written), owns models and extends models of its dependencies. The module type
 * carries its models, extensions and dependencies, so a registry built from modules knows every model it contains
 * (until `shutro generate` emits the same view).
 */

import type { GroupDefinition, PermissionDefinition } from '@shutro/security';
import type { SequenceDefinition } from '@shutro/sequence';
import type { DataRecord } from '../data/data.js';
import { DuplicateModelError, InvalidModuleError } from '../errors.js';
import { type AnyModel, humanize, isModel } from '../model/model.js';
import { type AnyExtension, isExtension } from './extension.js';
import type { Registry } from './registry.js';

/** What a data-migration hook receives: raw SQL on the migration transaction, and the registry. */
export interface MigrationContext {
  sql<R extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly R[]>;
  readonly registry: Registry;
}

/** A per-module data migration: runs once when the module is upgraded past `version` (never on a fresh install). */
export interface DataMigration {
  /** `major.minor.patch`; must not exceed the module's version. */
  readonly version: string;
  readonly description?: string;
  readonly up: (ctx: MigrationContext) => Promise<void>;
}

/** A module without the type parameters that carry its models and dependencies. */
export interface ModuleBase {
  readonly name: string;
  readonly version: string;
  readonly label: string;
  readonly depends: readonly ModuleBase[];
  readonly models: readonly AnyModel[];
  readonly extensions: readonly AnyExtension[];
  /** Data-migration hooks, sorted by version. */
  readonly migrations: readonly DataMigration[];
  /** Document sequences this module declares (RFC 0012 §7.1). */
  readonly sequences: readonly SequenceDefinition[];
  /** Security groups this module declares (RFC 0014 §7.1). */
  readonly groups: readonly GroupDefinition[];
  /** Feature permissions this module declares (RFC 0014 §7.9). */
  readonly permissions: readonly PermissionDefinition[];
  /** Records the module ships (RFC 0017), in load order. */
  readonly data: readonly DataRecord[];
}

/** A module as `defineModule` returns it; the type parameters carry the model types for the registry's schema view. */
export interface Module<
  Ms extends readonly AnyModel[] = readonly AnyModel[],
  Deps extends readonly ModuleBase[] = readonly ModuleBase[],
  Exts extends readonly AnyExtension[] = readonly AnyExtension[],
> extends ModuleBase {
  readonly depends: Deps;
  readonly models: Ms;
  readonly extensions: Exts;
}

/** The argument of {@link defineModule}. */
export interface ModuleDefinition<
  Ms extends readonly AnyModel[],
  Deps extends readonly ModuleBase[],
  Exts extends readonly AnyExtension[],
> {
  /** Unique, snake_case, stable (stored in the database for migrations). */
  readonly name: string;
  /** `major.minor.patch`. Defaults to `0.0.0`. */
  readonly version?: string;
  /** Human label; defaults to the humanized name. */
  readonly label?: string;
  /** Direct dependencies, as module objects. Transitive ones are collected by the registry. */
  readonly depends?: Deps;
  /** Models this module owns. */
  readonly models: Ms;
  /** Extensions of models owned by (transitive) dependencies. */
  readonly extensions?: Exts;
  /** Data-migration hooks (see {@link DataMigration}). */
  readonly migrations?: readonly DataMigration[];
  /** Document sequences (`defineSequence`). */
  readonly sequences?: readonly SequenceDefinition[];
  /** Security groups (`defineGroup`). */
  readonly groups?: readonly GroupDefinition[];
  /** Feature permissions (`definePermission`): apps, menus, buttons, approvals. */
  readonly permissions?: readonly PermissionDefinition[];
  /** Records the module ships (`record`, `override`; RFC 0017), loaded in this order by `shutro migrate apply`. */
  readonly data?: readonly DataRecord[];
}

const MODULE_NAME = /^[a-z][a-z0-9_]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;

const modules = new WeakSet<object>();

/** Numeric comparison of `major.minor.patch` versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when `value` was produced by {@link defineModule}. */
export function isModule(value: unknown): value is Module {
  return typeof value === 'object' && value !== null && modules.has(value);
}

/**
 * Defines a module.
 *
 * @example
 * ```ts
 * export default defineModule({ name: 'sale_stock', depends: [sale, stock], models: [], extensions: [SaleOrderStock] });
 * ```
 * @throws {InvalidModuleError} for a bad name or version, or `depends` / `models` / `extensions` entries of the wrong kind.
 * @throws {DuplicateModelError} when two models in the list share a name.
 */
export function defineModule<
  const Ms extends readonly AnyModel[],
  const Deps extends readonly ModuleBase[] = readonly [],
  const Exts extends readonly AnyExtension[] = readonly [],
>(definition: ModuleDefinition<Ms, Deps, Exts>): Module<Ms, Deps, Exts> {
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
  const depends = (definition.depends ?? []) as Deps;
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
    if (!isModel(model))
      throw new InvalidModuleError(
        `Module '${name}' models[${i}] is not a model.`,
        'Pass the result of defineModel().',
      );
    if (seen.has(model.name)) throw new DuplicateModelError(model.name, [name, name]);
    seen.add(model.name);
  });
  const extensions = (definition.extensions ?? []) as Exts;
  extensions.forEach((ext, i) => {
    if (!isExtension(ext))
      throw new InvalidModuleError(
        `Module '${name}' extensions[${i}] is not an extension.`,
        'Pass the result of extendModel().',
      );
    if (seen.has(ext.name)) {
      throw new InvalidModuleError(
        `Module '${name}' both defines and extends '${ext.name}'.`,
        'Put the extension content into the model definition instead.',
      );
    }
  });
  const migrations = [...(definition.migrations ?? [])];
  for (const m of migrations) {
    if (!VERSION.test(m.version))
      throw new InvalidModuleError(
        `Module '${name}' has a migration with version ${JSON.stringify(m.version)}.`,
        "Use 'major.minor.patch'.",
      );
    if (compareVersions(m.version, version) > 0)
      throw new InvalidModuleError(
        `Module '${name}' has a migration for ${m.version}, beyond its version ${version}.`,
        'Raise the module version, or lower the migration version.',
      );
    if (typeof m.up !== 'function')
      throw new InvalidModuleError(
        `Module '${name}' migration ${m.version} has no up() function.`,
        'Pass { version, up: async (ctx) => { ... } }.',
      );
  }
  for (const seq of definition.sequences ?? []) {
    if (typeof seq !== 'object' || seq === null || typeof seq.code !== 'string')
      throw new InvalidModuleError(
        `Module '${name}' has a malformed sequence.`,
        'Pass defineSequence({ code, ... }) entries.',
      );
  }
  migrations.sort((a, b) => compareVersions(a.version, b.version));
  const module: Module<Ms, Deps, Exts> = Object.freeze({
    name,
    version,
    label: definition.label ?? humanize(name),
    depends: Object.freeze([...depends]) as unknown as Deps,
    models: Object.freeze([...definition.models]) as unknown as Ms,
    extensions: Object.freeze([...extensions]) as unknown as Exts,
    migrations: Object.freeze(migrations),
    sequences: Object.freeze([...(definition.sequences ?? [])]),
    groups: Object.freeze([...(definition.groups ?? [])]),
    permissions: Object.freeze([...(definition.permissions ?? [])]),
    data: Object.freeze([...(definition.data ?? [])]),
  });
  modules.add(module);
  return module;
}
