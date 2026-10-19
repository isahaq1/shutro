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

/** What an uninstall blocker receives (RFC 0019 §7.6): raw SQL on the uninstall transaction, and the registry. */
export type UninstallContext = MigrationContext;

/** Uninstall behaviour of a module (RFC 0019 §7.6). */
export interface UninstallSpec {
  /**
   * Reasons to refuse the uninstall, e.g. "posted journal entries exist". An empty list allows it. Runs inside the
   * uninstall transaction, before anything changes.
   */
  readonly blockers?: (ctx: UninstallContext) => Promise<readonly string[]>;
}

/** A module without the type parameters that carry its models and dependencies. */
export interface ModuleBase {
  readonly name: string;
  readonly version: string;
  readonly label: string;
  /** Listed in the app catalog (RFC 0019 §7.1); other modules are technical. */
  readonly application: boolean;
  /** Installed with the last of its dependencies and removed with the first (glue modules, RFC 0019 R6). */
  readonly autoInstall: boolean;
  /** Can never be uninstalled (`base`, `settings`). */
  readonly required: boolean;
  /** SVG icon: inline markup (`<svg …>`) or a URL / path ending in `.svg`. */
  readonly icon: string | undefined;
  /** A short terminal glyph (an emoji), shown when the terminal supports Unicode. */
  readonly glyph: string | undefined;
  /** Catalog category; `'Technical'` for non-applications without one. */
  readonly category: string;
  /** One line describing what the module does. */
  readonly summary: string;
  /** Uninstall behaviour. */
  readonly uninstall: UninstallSpec;
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

/**
 * App flags of {@link ModuleDefinition}: an application is chosen by people, a glue module (`autoInstall`) follows its
 * dependencies, so a module cannot be both.
 */
export type AppKind =
  | {
      /** Listed in the app catalog (RFC 0019 §7.1). */
      readonly application: true;
      readonly autoInstall?: false;
    }
  | {
      readonly application?: false;
      /** Installed with the last of its dependencies, removed with the first (RFC 0019 R6). */
      readonly autoInstall?: boolean;
    };

/** The argument of {@link defineModule}. */
export type ModuleDefinition<
  Ms extends readonly AnyModel[],
  Deps extends readonly ModuleBase[],
  Exts extends readonly AnyExtension[],
> = ModuleFields<Ms, Deps, Exts> & AppKind;

/** The fields of {@link ModuleDefinition} other than the app flags. */
export interface ModuleFields<
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
  /** Can never be uninstalled (RFC 0019 §11.4). */
  readonly required?: boolean;
  /** SVG icon for app stores: inline markup (`<svg …>`, at most 64 KB) or a URL / path ending in `.svg`. */
  readonly icon?: string | URL;
  /** A short terminal glyph, e.g. `'🛒'`. */
  readonly glyph?: string;
  /** Catalog category, e.g. `'Sales'`. */
  readonly category?: string;
  /** One line describing what the module does. */
  readonly summary?: string;
  /** Uninstall behaviour (RFC 0019 §7.6). */
  readonly uninstall?: UninstallSpec;
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

const MAX_INLINE_ICON = 64 * 1024;

/** Validates an icon: inline SVG markup within the size limit, or a URL / path to an `.svg` file. */
function iconOf(module: string, icon: string | URL | undefined): string | undefined {
  if (icon === undefined) return undefined;
  const text: unknown = icon instanceof URL ? icon.href : icon;
  if (typeof text !== 'string')
    throw new InvalidModuleError(
      `Module '${module}' has an icon that is neither a string nor a URL.`,
      "Pass inline SVG markup, a path, or new URL('./icon.svg', import.meta.url).",
    );
  if (text.trimStart().startsWith('<svg')) {
    const size = Buffer.byteLength(text);
    if (size > MAX_INLINE_ICON)
      throw new InvalidModuleError(
        `Module '${module}' has an inline icon of ${size} bytes.`,
        'Keep icons at 64 KB or less: simplify the SVG, or ship it as a file.',
      );
    return text;
  }
  if (!/\.svg([?#].*)?$/i.test(text))
    throw new InvalidModuleError(
      `Module '${module}' has icon ${JSON.stringify(text)}, which is not an SVG.`,
      'Icons are SVG so they scale in every app store: pass inline <svg> markup or a path ending in .svg.',
    );
  return text;
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
  const application = definition.application === true;
  const autoInstall = definition.autoInstall === true;
  if (application && autoInstall)
    throw new InvalidModuleError(
      `Module '${name}' is both an application and autoInstall.`,
      'Applications are chosen by people; autoInstall is for glue modules that follow their dependencies. Drop one.',
    );
  if (autoInstall && depends.length < 2)
    throw new InvalidModuleError(
      `Module '${name}' is autoInstall with ${depends.length} dependency(ies).`,
      'autoInstall glues two or more modules together (sale_purchase depends on sale and purchase); otherwise make it a dependency of the app.',
    );
  if (definition.glyph !== undefined && [...definition.glyph].length > 4)
    throw new InvalidModuleError(
      `Module '${name}' has glyph ${JSON.stringify(definition.glyph)}.`,
      "Use one emoji or a short symbol, e.g. '🛒'.",
    );
  if (
    definition.uninstall?.blockers !== undefined &&
    typeof definition.uninstall.blockers !== 'function'
  )
    throw new InvalidModuleError(
      `Module '${name}' uninstall.blockers is not a function.`,
      'Pass uninstall: { blockers: async (ctx) => [...reasons] }.',
    );
  const module: Module<Ms, Deps, Exts> = Object.freeze({
    name,
    version,
    label: definition.label ?? humanize(name),
    application,
    autoInstall,
    required: definition.required === true,
    icon: iconOf(name, definition.icon),
    glyph: definition.glyph,
    category: definition.category ?? (application ? 'Other' : 'Technical'),
    summary: definition.summary ?? '',
    uninstall: Object.freeze({ ...(definition.uninstall ?? {}) }),
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
