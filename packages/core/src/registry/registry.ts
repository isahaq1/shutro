/**
 * `buildRegistry()` (RFC 0002 §7.4): loads modules in dependency order, applies extensions under the view-safety
 * rules, composes method chains, and runs the cross-model checks. The registry's type is the schema view of every
 * model (with its extensions) in the module tree.
 */
import {
  DuplicateModelError,
  DuplicateModuleError,
  ExtensionConflictError,
  InvalidDependsPathError,
  InvalidExtensionError,
  InvalidModuleError,
  InvalidRelationError,
  UndeclaredDependencyError,
  UnknownModelError,
  UnknownSequenceError,
} from '../errors.js';
import {
  type Field,
  overrideField,
  type StateHooks,
  type StateSpec,
  type Transition,
} from '../model/field.js';
import {
  type AnyModel,
  type ConstraintSpec,
  defineModel,
  type FieldDescription,
  type IndexSpec,
  type ModelDescription,
  markTransition,
  type OnchangeFn,
  RESERVED_KEYS,
  type SqlCheckConstraint,
  type SqlUniqueConstraint,
  transitionOf,
} from '../model/model.js';
import type { AnyExtension, OverrideFn } from './extension.js';
import { isModule, type Module, type ModuleBase } from './module.js';

// ------------------------------------------------------------------------------------------------- schema types

import {
  type AccessSpec,
  type FieldGroupsInput,
  type GroupDefinition,
  groupClosure,
  mergeAccess,
  normalizeFieldGroups,
  type PermissionDefinition,
  type RuleSpec,
  SecurityDefinitionError,
} from '@shutro/security';
import type { SequenceDefinition } from '@shutro/sequence';
import { buildComputeGraph, type ComputeGraph } from '../compute/graph.js';
import { validateData } from '../data/data.js';
import { delegatedField } from '../model/field.js';
import { relatedPath } from '../model/related.js';

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
type Simplify<T> = { [K in keyof T]: T[K] } & NonNullable<unknown>;
type NameOf<X> = X extends { readonly name: infer N extends string }
  ? string extends N
    ? never
    : N
  : never;
/** Models and extensions keyed by name; several contributions to one name intersect (fields and methods merge). */
type ByName<X> = UnionToIntersection<
  X extends unknown
    ? NameOf<X> extends never
      ? NonNullable<unknown>
      : { readonly [K in NameOf<X>]: X }
    : never
>;
/** The schema view of one module: its models and extensions plus those of its dependencies, recursively. */
export type SchemaOfModule<M> =
  M extends Module<infer Ms, infer Deps, infer Exts>
    ? ByName<Ms[number] | Exts[number]> & SchemaOfModules<Deps>
    : NonNullable<unknown>;
/** The schema view of several modules. */
export type SchemaOfModules<Mods> = Mods extends readonly [infer H, ...infer T]
  ? SchemaOfModule<H> & SchemaOfModules<T>
  : Mods extends readonly (infer U)[]
    ? ModuleBase extends U
      ? NonNullable<unknown> // the wide module type carries no model information; stop here
      : UnionToIntersection<SchemaOfModule<U>>
    : NonNullable<unknown>;

// ------------------------------------------------------------------------------------------------------ types

/** One layer of a method: the definition, an override that calls `next`, or a replacement (RFC 0002 §7.4 step 6). */
export interface MethodLayer {
  readonly module: string;
  readonly kind: 'definition' | 'override' | 'replace';
}

/** A model with its extensions applied, and where everything came from. */
export interface RegisteredModel {
  /** The final model (base definition plus extensions, rebuilt through `defineModel`). */
  readonly model: AnyModel;
  /** The owning module. */
  readonly module: string;
  /** Modules that extended the model, in load order. */
  readonly extensions: readonly string[];
  /** Field key → contributing module. */
  readonly fieldOrigins: Readonly<Record<string, string>>;
  /** Method name → layers, innermost first. */
  readonly methodLayers: Readonly<Record<string, readonly MethodLayer[]>>;
}

/** Where a model or field comes from. */
export interface Origin {
  readonly module: string;
}

/** `ModelDescription` plus provenance (RFC 0001 §9, RFC 0002 §9). */
export interface RegistryModelDescription extends Omit<ModelDescription, 'fields'> {
  readonly origin: Origin;
  readonly extensions: readonly string[];
  readonly fields: Readonly<Record<string, FieldDescription & { readonly origin: Origin }>>;
  readonly methodLayers: Readonly<Record<string, readonly MethodLayer[]>>;
}

/** The built, frozen registry. `S` is the schema view: model name → model type. */
export interface Registry<S = unknown> {
  /** Phantom. */
  readonly '~schema'?: S;
  /** Modules in load order. */
  readonly modules: readonly ModuleBase[];
  /** Module names in load order. */
  readonly loadOrder: readonly string[];
  /** Models in load order (owning modules first, then definition order). */
  readonly models: ReadonlyMap<string, RegisteredModel>;
  /** The compute dependency graph (RFC 0008 §9). */
  readonly compute: ComputeGraph;
  /** Document sequences by code (RFC 0012 §7.1). */
  readonly sequences: ReadonlyMap<string, SequenceDefinition>;
  /** External ids the modules' data declares → owning module and model (RFC 0017). */
  readonly externalIds: ReadonlyMap<string, { readonly module: string; readonly model: string }>;
  /** Security groups and their closure (RFC 0014 §7.1). */
  readonly security: {
    readonly groups: ReadonlyMap<string, GroupDefinition>;
    closure(codes: Iterable<string>): Set<string>;
    /** True when one of `groups` (a closure) is an administrator group (RFC 0014 §7.9). */
    isAdministrator(groups: ReadonlySet<string>): boolean;
    /** Feature permissions by code (RFC 0014 §7.9). */
    readonly permissions: ReadonlyMap<string, PermissionDefinition>;
    /** False only when the registry was built with `security: { enforce: false }`. */
    readonly enforce: boolean;
    /**
     * `'warn'`: ACL and field-group denials are reported through {@link SecurityOptions.onDenied} and allowed
     * (record rules still apply). `'enforce'` otherwise (or `'off'` with `enforce: false`).
     */
    readonly mode: 'enforce' | 'warn' | 'off';
    /** Reports a denial `'warn'` mode let through; each distinct message once per registry. */
    denied(message: string): void;
  };
  has(name: string): boolean;
  /** @throws {UnknownModelError} */
  get(name: string): RegisteredModel;
  /** @throws {UnknownModelError} */
  describe(name: string): RegistryModelDescription;
  /** The layers of a method, innermost first (`shutro inspect`). @throws {UnknownModelError} */
  explain(model: string, method: string): readonly MethodLayer[];
}

/** Options of {@link buildRegistry}. */
export interface RegistryOptions<Mods extends readonly ModuleBase[]> {
  /** The application's modules; their dependencies are collected transitively. */
  readonly modules: Mods;
  /**
   * Access control (RFC 0014). Enforced by default; `enforce: false` makes every model, record and field accessible
   * to every environment, for prototypes and for tests of other features. Never ship it off.
   */
  readonly security?: SecurityOptions;
}

/** Access-control options of {@link buildRegistry}. */
export interface SecurityOptions {
  /**
   * `true` (default) enforces ACL, rules and field groups. `'warn'` is for development: a missing grant is reported
   * and allowed, so prototypes run before their `access` declarations are written; it is refused when
   * `NODE_ENV=production`. `false` turns access control off (tests of other features).
   */
  readonly enforce?: boolean | 'warn';
  /** Where `'warn'` reports go. Defaults to `process.emitWarning` (code `SHUTRO_ACCESS_WOULD_DENY`). */
  readonly onDenied?: (message: string) => void;
}

const RELATION_KINDS = new Set(['many2one', 'one2many', 'many2many']);

/** The target model of a relation field, else `undefined`. */
export function targetOf(field: Field): string | undefined {
  return RELATION_KINDS.has(field.kind)
    ? (field as unknown as { target: string }).target
    : undefined;
}

// ----------------------------------------------------------------------------------------------------- loading

/** Collects every module reachable from the roots and checks that names are unique. */
function collect(roots: readonly ModuleBase[]): Map<string, ModuleBase> {
  const byName = new Map<string, ModuleBase>();
  const visit = (module: ModuleBase): void => {
    if (!isModule(module))
      throw new DuplicateModuleError(String((module as { name?: unknown }).name ?? '?'));
    const known = byName.get(module.name);
    if (known === module) return;
    if (known !== undefined) throw new DuplicateModuleError(module.name);
    byName.set(module.name, module);
    for (const dep of module.depends) visit(dep);
  };
  for (const root of roots) visit(root);
  return byName;
}

/** Kahn's algorithm with the smallest name first: the order is a pure function of the module set (RFC 0002 R5). */
function order(byName: ReadonlyMap<string, ModuleBase>): ModuleBase[] {
  const remaining = new Map<string, Set<string>>();
  for (const [name, module] of byName)
    remaining.set(name, new Set(module.depends.map((d) => d.name)));
  const result: ModuleBase[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    const next = ready[0];
    if (next === undefined) {
      // Unreachable with module objects (a module can't depend on one defined after it), kept as a guard.
      throw new DuplicateModuleError([...remaining.keys()].join(' → '));
    }
    const module = byName.get(next);
    if (module !== undefined) result.push(module);
    remaining.delete(next);
    for (const deps of remaining.values()) deps.delete(next);
  }
  return result;
}

/** Transitive dependency names of a module, including itself. */
function closure(module: ModuleBase): Set<string> {
  const names = new Set<string>();
  const walk = (m: ModuleBase): void => {
    if (names.has(m.name)) return;
    names.add(m.name);
    for (const dep of m.depends) walk(dep);
  };
  walk(module);
  return names;
}

// ------------------------------------------------------------------------------------------------ extensions

type AnyFn = (this: unknown, ...args: never[]) => unknown;

/** The merged state of one model while extensions are applied. */
interface Draft {
  readonly base: AnyModel;
  readonly module: string;
  readonly extensions: string[];
  readonly fields: Record<string, Field>;
  readonly fieldOrigins: Record<string, string>;
  readonly methods: Record<string, AnyFn>;
  readonly methodLayers: Record<string, MethodLayer[]>;
  readonly constraints: Record<string, ConstraintSpec>;
  readonly onchange: Record<string, OnchangeFn>;
  access: AccessSpec;
  readonly rules: Record<string, RuleSpec>;
  readonly sqlConstraints: Record<string, SqlUniqueConstraint<string> | SqlCheckConstraint>;
  readonly indexes: IndexSpec<string>[];
  readonly tracking: string[];
}

function draftOf(model: AnyModel, module: string): Draft {
  const fieldOrigins: Record<string, string> = {};
  for (const key of Object.keys(model.fields)) fieldOrigins[key] = module;
  const methodLayers: Record<string, MethodLayer[]> = {};
  for (const key of Object.keys(model.methods))
    methodLayers[key] = [{ module, kind: 'definition' }];
  const def = model.definition;
  return {
    base: model,
    module,
    extensions: [],
    fields: { ...(def.fields as Record<string, Field>) },
    fieldOrigins,
    methods: { ...(model.methods as Record<string, AnyFn>) },
    methodLayers,
    constraints: { ...(def.constraints ?? {}) },
    onchange: { ...(def.onchange ?? {}) },
    access: { ...(def.access ?? {}) },
    rules: { ...(def.rules ?? {}) },
    sqlConstraints: { ...(def.sqlConstraints ?? {}) } as Record<
      string,
      SqlUniqueConstraint<string> | SqlCheckConstraint
    >,
    indexes: [...(def.indexes ?? [])] as IndexSpec<string>[],
    tracking: [...(def.tracking ?? [])],
  };
}

/** Wraps `prev` with `layer`: `layer.call(this, next, ...args)` where `next` is `prev` bound to `this`. */
function compose(prev: AnyFn, layer: OverrideFn): AnyFn {
  const composed = function composed(this: unknown, ...args: never[]): unknown {
    const next = (...nextArgs: never[]): unknown => prev.apply(this, nextArgs);
    return layer.call(this, next as never, ...args);
  };
  // A wrapped transition is still the transition (the rebuilt model must not regenerate it, RFC 0010 §7.1).
  const transition = transitionOf(prev);
  return transition === undefined
    ? composed
    : markTransition(composed, transition.field, transition.name);
}

function applyExtension(
  draft: Draft,
  ext: AnyExtension,
  module: string,
  reachable: ReadonlySet<string>,
): void {
  const where = `Module '${module}' extending '${ext.name}'`;
  const conflict = (what: string, key: string, origin: string, fix: string): never => {
    const problem = reachable.has(origin)
      ? `${where}: ${what} '${key}' already exists (from '${origin}').`
      : `${what} '${key}' of '${ext.name}' is added by both '${origin}' and '${module}', which do not depend on each other.`;
    throw new ExtensionConflictError(problem, fix);
  };

  for (const [key, field] of Object.entries(ext.fields)) {
    const origin = draft.fieldOrigins[key];
    if (origin !== undefined) {
      conflict(
        'field',
        key,
        origin,
        reachable.has(origin)
          ? 'Use fieldOverrides to change an existing field.'
          : 'Rename one field, or make one module depend on the other and use fieldOverrides.',
      );
    }
    if (
      field.required &&
      field.default === undefined &&
      !field.computed &&
      field.kind !== 'boolean' &&
      // x2many relations are "required" only in the sense that they always hold a (possibly empty) list.
      field.kind !== 'one2many' &&
      field.kind !== 'many2many'
    ) {
      throw new InvalidExtensionError(
        `${where}: the new field '${key}' is required but has no default.`,
        'A required field added by an extension needs a default or a compute (RFC 0002 S1), so code that does not know the field can still create records.',
      );
    }
    draft.fields[key] = field;
    draft.fieldOrigins[key] = module;
  }

  for (const [key, override] of Object.entries(ext.fieldOverrides)) {
    const field = draft.fields[key];
    if (field === undefined) {
      const implicit = draft.base.fields[key] !== undefined;
      throw new InvalidExtensionError(
        `${where}: fieldOverrides names '${key}', which is ${implicit ? 'an implicit field' : 'not a field'} of '${ext.name}'.`,
        implicit
          ? 'Implicit fields (id, createdAt, company, ...) cannot be overridden.'
          : `Fields: ${Object.keys(draft.fields).join(', ')}.`,
      );
    }
    const changes: Parameters<typeof overrideField>[1] & {
      selection?: readonly (readonly [string, string])[];
    } = {};
    for (const [attr, value] of Object.entries(override)) {
      if (value === undefined) continue;
      switch (attr) {
        case 'label':
        case 'help':
        case 'default':
        case 'index':
        case 'tracking':
        case 'copy':
          Object.assign(changes, { [attr]: value });
          break;
        case 'groups':
          Object.assign(changes, { groups: normalizeFieldGroups(value as FieldGroupsInput) });
          break;
        case 'required': {
          if (value === false && field.required) {
            throw new InvalidExtensionError(
              `${where}: fieldOverrides.${key} relaxes required to false.`,
              'Required can only be tightened (RFC 0002 S2): code compiled against the original view reads a non-null value.',
            );
          }
          if (
            value === true &&
            !field.required &&
            override.default === undefined &&
            field.default === undefined
          ) {
            throw new InvalidExtensionError(
              `${where}: fieldOverrides.${key} sets required without a default.`,
              'Give the field a default in the same override (RFC 0002 S2), so existing create() calls keep working.',
            );
          }
          Object.assign(changes, { required: value });
          break;
        }
        case 'selectionAdd': {
          const selectable = field as Field & {
            selection?: readonly (readonly [string, string])[] | (() => readonly string[]);
            extensible?: boolean;
          };
          if (
            (field.kind !== 'selection' && field.kind !== 'state') ||
            typeof selectable.selection === 'function'
          ) {
            throw new InvalidExtensionError(
              `${where}: fieldOverrides.${key}.selectionAdd on a ${field.kind} field.`,
              'selectionAdd applies to selection and state fields with a static map.',
            );
          }
          if (selectable.extensible !== true) {
            throw new InvalidExtensionError(
              `${where}: '${key}' is not an extensible selection.`,
              'The owner must declare the field with extensible: true (RFC 0002 S5); consumers then handle unknown values.',
            );
          }
          const existing = selectable.selection ?? [];
          const added = Object.entries(value as Record<string, string>).filter(
            ([k]) => !existing.some(([e]) => e === k),
          );
          changes.selection = [...existing, ...added.map(([k, v]) => [k, v] as const)];
          break;
        }
        case 'statesAdd':
        case 'transitionsAdd': {
          const stateField = field as Field & {
            selection?: readonly (readonly [string, string])[];
            transitions?: Readonly<Record<string, Transition<string>>>;
            stateHooks?: Readonly<Record<string, StateHooks>>;
            extensible?: boolean;
          };
          if (field.kind !== 'state') {
            throw new InvalidExtensionError(
              `${where}: fieldOverrides.${key}.${attr} on a ${field.kind} field.`,
              'statesAdd / transitionsAdd apply to state fields.',
            );
          }
          if (stateField.extensible !== true) {
            throw new InvalidExtensionError(
              `${where}: '${key}' is not an extensible state field.`,
              'The owner must declare the field with extensible: true (RFC 0002 S6).',
            );
          }
          const selection = [...(changes.selection ?? stateField.selection ?? [])];
          const hooks: Record<string, StateHooks> = {
            ...(changes.stateHooks ?? stateField.stateHooks ?? {}),
          };
          const transitions: Record<string, Transition<string>> = {
            ...(changes.transitions ?? stateField.transitions ?? {}),
          };
          if (attr === 'statesAdd') {
            for (const [s, spec] of Object.entries(value as Record<string, string | StateSpec>)) {
              if (selection.some(([e]) => e === s))
                throw new InvalidExtensionError(
                  `${where}: state '${s}' already exists on '${key}'.`,
                  'Add new states only (RFC 0002 S6).',
                );
              selection.push([s, typeof spec === 'string' ? spec : spec.label]);
              if (
                typeof spec !== 'string' &&
                (spec.onEnter !== undefined || spec.onExit !== undefined)
              )
                hooks[s] = {
                  ...(spec.onEnter === undefined ? {} : { onEnter: spec.onEnter }),
                  ...(spec.onExit === undefined ? {} : { onExit: spec.onExit }),
                };
            }
            Object.assign(changes, { selection, stateHooks: hooks });
          } else {
            const states = new Set(selection.map(([s]) => s));
            for (const [tname, t] of Object.entries(value as Record<string, Transition<string>>)) {
              if (transitions[tname] !== undefined)
                throw new InvalidExtensionError(
                  `${where}: transition '${tname}' already exists on '${key}'.`,
                  'Add new transitions only; wrap existing ones with overrides (RFC 0002 S6).',
                );
              for (const s of [...t.from, t.to]) {
                if (!states.has(s))
                  throw new InvalidExtensionError(
                    `${where}: transition '${tname}' refers to unknown state '${s}'.`,
                    `States of '${key}': ${[...states].join(', ')} (add states with statesAdd first, in the same override).`,
                  );
              }
              transitions[tname] = t;
              draft.methodLayers[tname] = [{ module, kind: 'definition' }];
            }
            Object.assign(changes, { transitions });
          }
          break;
        }
        default:
          throw new InvalidExtensionError(
            `${where}: fieldOverrides.${key}.${attr} is not an attribute an extension may change.`,
            'Allowed: label, help, default, index, tracking, copy, groups, required (tighten only), selectionAdd, statesAdd, transitionsAdd (RFC 0002 S2–S6).',
          );
      }
    }
    draft.fields[key] = overrideField(field, changes);
  }

  for (const [key, fn] of Object.entries(ext.methods)) {
    const layers = draft.methodLayers[key];
    if (layers !== undefined) {
      const origin = layers[0]?.module ?? draft.module;
      conflict(
        'method',
        key,
        origin,
        reachable.has(origin)
          ? 'Use overrides to wrap an existing method.'
          : 'Rename one method, or make one module depend on the other and use overrides.',
      );
    }
    draft.methods[key] = fn as AnyFn;
    draft.methodLayers[key] = [{ module, kind: 'definition' }];
  }

  for (const [key, { kind, fn }] of Object.entries(ext.overrides)) {
    const prev = draft.methods[key];
    if (prev === undefined) {
      throw new InvalidExtensionError(
        `${where}: overrides names '${key}', which is not a method of '${ext.name}'.`,
        `Methods: ${Object.keys(draft.methods).join(', ') || '(none)'}. Add new methods under \`methods\`.`,
      );
    }
    draft.methods[key] = kind === 'replace' ? (fn as unknown as AnyFn) : compose(prev, fn);
    draft.methodLayers[key] = [...(draft.methodLayers[key] ?? []), { module, kind }];
  }

  for (const [key, spec] of Object.entries(ext.constraints)) {
    if (draft.constraints[key] !== undefined)
      conflict('constraint', key, draft.module, 'Use a different constraint key.');
    draft.constraints[key] = spec;
  }
  draft.access = mergeAccess(draft.access, ext.access);
  for (const [key, rule] of Object.entries(ext.rules)) {
    if (draft.rules[key] !== undefined)
      conflict('rule', key, draft.module, 'Use a different rule key.');
    draft.rules[key] = rule;
  }
  for (const [key, fn] of Object.entries(ext.onchange)) {
    if (draft.onchange[key] !== undefined)
      conflict(
        'onchange',
        key,
        draft.module,
        'Call a shared method from the existing handler instead.',
      );
    draft.onchange[key] = fn;
  }
  for (const [key, spec] of Object.entries(ext.sqlConstraints)) {
    if (draft.sqlConstraints[key] !== undefined)
      conflict(
        'sqlConstraints',
        key,
        draft.module,
        'Use a different key (prefix it with the module name).',
      );
    draft.sqlConstraints[key] = spec;
  }
  draft.indexes.push(...ext.indexes);
  for (const key of ext.tracking) if (!draft.tracking.includes(key)) draft.tracking.push(key);
  draft.extensions.push(module);
}

/** Rebuilds the final model from the draft through `defineModel`, so every model-level check applies to it. */
function finalize(draft: Draft): RegisteredModel {
  const def = draft.base.definition;
  const model = defineModel(draft.base.name, {
    ...def,
    fields: draft.fields,
    methods: draft.methods,
    constraints: draft.constraints,
    onchange: draft.onchange,
    access: draft.access,
    rules: draft.rules,
    sqlConstraints: draft.sqlConstraints,
    indexes: draft.indexes,
    tracking: draft.tracking,
  } as never) as unknown as AnyModel;
  const fieldOrigins: Record<string, string> = {};
  for (const key of Object.keys(model.fields))
    fieldOrigins[key] = draft.fieldOrigins[key] ?? draft.module;
  return {
    model,
    module: draft.module,
    extensions: Object.freeze([...draft.extensions]),
    fieldOrigins: Object.freeze(fieldOrigins),
    methodLayers: Object.freeze(
      Object.fromEntries(
        Object.entries(draft.methodLayers).map(([k, v]) => [k, Object.freeze([...v])]),
      ),
    ),
  };
}

// -------------------------------------------------------------------------------------------------- building

/**
 * Builds the registry: collects and orders modules, registers models, applies extensions in load order under the
 * view-safety rules, and runs the checks that need every model: relation targets exist and belong to a declared
 * dependency, one2many inverses point back, `depends` paths resolve.
 *
 * @throws {DuplicateModuleError} {DuplicateModelError} {UnknownModelError} {UndeclaredDependencyError}
 * {InvalidRelationError} {InvalidDependsPathError} {InvalidExtensionError} {ExtensionConflictError}
 */
export function buildRegistry<const Mods extends readonly ModuleBase[]>(
  options: RegistryOptions<Mods>,
): Registry<Simplify<SchemaOfModules<Mods>>> {
  const modules = order(collect(options.modules));
  const closures = new Map(modules.map((m) => [m.name, closure(m)]));

  const drafts = new Map<string, Draft>();
  for (const module of modules) {
    for (const model of module.models) {
      const existing = drafts.get(model.name);
      if (existing !== undefined)
        throw new DuplicateModelError(model.name, [existing.module, module.name]);
      drafts.set(model.name, draftOf(model, module.name));
    }
  }
  for (const module of modules) {
    const reachable = closures.get(module.name) ?? new Set<string>();
    for (const ext of module.extensions) {
      const draft = drafts.get(ext.name);
      if (draft === undefined)
        throw new UnknownModelError(ext.name, `the extension in module '${module.name}'`);
      if (!reachable.has(draft.module))
        throw new UndeclaredDependencyError(module.name, ext.name, draft.module, 'an extension');
      applyExtension(draft, ext, module.name, reachable);
    }
  }

  // Delegation: the parent's fields (after its extensions) become writable related fields of the child.
  for (const draft of drafts.values()) {
    for (const key of (draft.base.definition as { delegates?: readonly string[] }).delegates ??
      []) {
      const target = (draft.fields[key] as { target?: string } | undefined)?.target ?? '';
      const parent = drafts.get(target);
      if (parent === undefined)
        throw new UnknownModelError(target, `delegates '${key}' of '${draft.base.name}'`);
      for (const [pk, pf] of Object.entries(parent.fields)) {
        if (RESERVED_KEYS.includes(pk) || pk in draft.fields) continue;
        if (pf.kind === 'one2many' || pf.kind === 'many2many' || pf.kind === 'state') continue;
        draft.fields[pk] = delegatedField(pf, `${key}.${pk}`);
        draft.fieldOrigins[pk] = parent.fieldOrigins[pk] ?? parent.module;
      }
    }
  }

  const models = new Map<string, RegisteredModel>();
  for (const [name, draft] of drafts) models.set(name, finalize(draft));

  const resolve = (fromModule: string, target: string, via: string): RegisteredModel => {
    const found = models.get(target);
    if (found === undefined) throw new UnknownModelError(target, via);
    if (!closures.get(fromModule)?.has(found.module))
      throw new UndeclaredDependencyError(fromModule, target, found.module, via);
    return found;
  };

  const securityGroups = new Map<string, GroupDefinition>();
  for (const module of modules) {
    for (const group of module.groups) {
      if (securityGroups.has(group.code)) {
        throw new InvalidModuleError(
          `Module '${module.name}' declares the group '${group.code}', which another module already declares.`,
          'Group codes are global: declare each group once.',
        );
      }
      securityGroups.set(group.code, group);
    }
  }
  const permissions = new Map<string, PermissionDefinition>();
  for (const module of modules) {
    for (const permission of module.permissions) {
      if (permissions.has(permission.code))
        throw new InvalidModuleError(
          `Module '${module.name}' declares the permission '${permission.code}', which another module already declares.`,
          'Permission codes are global: declare each permission once.',
        );
      for (const code of permission.groups)
        if (!securityGroups.has(code))
          throw new InvalidModuleError(
            `Permission '${permission.code}' is granted to the group '${code}', which no module declares.`,
            'Declare it with defineGroup() in a module, or fix the code.',
          );
      permissions.set(permission.code, permission);
    }
  }
  for (const { model } of models.values()) {
    for (const [key, field] of Object.entries(model.fields)) {
      const transitions = (
        field as { transitions?: Readonly<Record<string, { requires?: string }>> }
      ).transitions;
      for (const [name, t] of Object.entries(transitions ?? {}))
        if (t.requires !== undefined && !permissions.has(t.requires))
          throw new InvalidModuleError(
            `Transition '${name}' of ${model.name}.${key} requires the permission '${t.requires}', which no module declares.`,
            'Declare it with definePermission() in a module, or fix the code.',
          );
    }
  }
  for (const { model } of models.values()) {
    if (model.backdate !== undefined && !permissions.has(model.backdate.permission))
      throw new InvalidModuleError(
        `Model '${model.name}' requires the permission '${model.backdate.permission}' for back-dated entries, which no module declares.`,
        'Declare it with definePermission() in a module, or fix the code.',
      );
  }
  const administrators = new Set(
    [...securityGroups.values()].filter((g) => g.administrator).map((g) => g.code),
  );
  for (const { model } of models.values()) {
    for (const code of [
      ...Object.keys(model.access),
      ...Object.values(model.rules).flatMap((r) => (r.groups === 'global' ? [] : [...r.groups])),
    ]) {
      if (!securityGroups.has(code))
        throw new InvalidModuleError(
          `Model '${model.name}' grants access to the group '${code}', which no module declares.`,
          'Declare it with defineGroup() in a module, or fix the code.',
        );
    }
  }
  const sequences = new Map<string, SequenceDefinition>();
  for (const module of modules) {
    for (const definition of module.sequences) {
      if (sequences.has(definition.code)) {
        throw new InvalidModuleError(
          `Module '${module.name}' declares the sequence '${definition.code}', which another module already declares.`,
          'Sequence codes are global: prefix them with the module name, or declare the sequence once.',
        );
      }
      sequences.set(definition.code, definition);
    }
  }

  for (const registered of models.values()) {
    const { model } = registered;
    for (const [key, field] of Object.entries(model.fields)) {
      const where = `field '${key}' of model '${model.name}'`;
      const fromModule = registered.fieldOrigins[key] ?? registered.module;
      const target = targetOf(field);
      if (target !== undefined) {
        const other = resolve(fromModule, target, where);
        const withoutKey =
          field.kind === 'many2one' && (field as { foreignKey?: boolean }).foreignKey === false;
        if (field.kind !== 'one2many' && other.model.partition !== undefined && !withoutKey) {
          throw new InvalidRelationError(
            `${where} points at '${target}', which is partitioned.`,
            'A foreign key cannot reference a partitioned table without its partition key: use f.many2one(target, { foreignKey: false }) (ids checked by the ORM), or reference a non-partitioned model.',
          );
        }
        if (field.kind === 'one2many') {
          const inverseKey = (field as unknown as { inverseField: string }).inverseField;
          const inverse = other.model.fields[inverseKey];
          if (
            inverse === undefined ||
            inverse.kind !== 'many2one' ||
            targetOf(inverse) !== model.name
          ) {
            throw new InvalidRelationError(
              `The one2many ${where} names inverse '${inverseKey}', which is not a many2one('${model.name}') on '${target}'.`,
              `Declare ${inverseKey}: f.many2one('${model.name}') on '${target}', or point the one2many at the right inverse field.`,
            );
          }
        }
      }
      if (
        field.kind === 'many2one' &&
        (field as { checkCompany?: boolean }).checkCompany === true
      ) {
        const targetName = targetOf(field) ?? '';
        const targetModel = resolve(fromModule, targetName, where).model;
        if (targetModel.companyScoped === undefined) {
          throw new InvalidRelationError(
            `${where} has checkCompany, but '${targetName}' is not companyScoped.`,
            'checkCompany compares the companies of both records: make the target companyScoped, or drop the option.',
          );
        }
      }
      for (const [kind, codes] of [
        ['read', field.groups.read],
        ['write', field.groups.write],
      ] as const) {
        for (const code of codes) {
          if (!securityGroups.has(code))
            throw new InvalidModuleError(
              `${where} restricts ${kind} to the group '${code}', which no module declares.`,
              'Declare it with defineGroup() in a module the field can see, or fix the code.',
            );
        }
      }
      if (field.sequence !== undefined) {
        const definition = sequences.get(field.sequence.code);
        if (definition === undefined) throw new UnknownSequenceError(field.sequence.code, where);
        if (field.sequence.gapless !== undefined && field.sequence.gapless !== definition.gapless) {
          throw new InvalidModuleError(
            `${where} declares the sequence '${definition.code}' as ${field.sequence.gapless ? 'gapless' : 'standard'}, but the definition says ${definition.gapless ? 'gapless' : 'standard'}.`,
            'The definition is authoritative: drop gapless from the field, or change the definition.',
          );
        }
        if (
          field.sequence.dateField !== undefined &&
          model.fields[field.sequence.dateField] === undefined
        ) {
          throw new InvalidModuleError(
            `${where} names dateField '${field.sequence.dateField}', which is not a field of '${model.name}'.`,
            'Point dateField at a date / datetime field of the model.',
          );
        }
      }
      for (const path of field.depends) {
        let current = registered;
        const segments = path.split('.');
        segments.forEach((segment, i) => {
          const step = current.model.fields[segment];
          if (segment === '' || step === undefined) {
            throw new InvalidDependsPathError(
              `The depends path '${path}' of ${where} is invalid: '${segment}' is not a field of '${current.model.name}'.`,
              `Use dotted paths through real fields, e.g. 'lines.subtotal'. Fields of '${current.model.name}': ${Object.keys(current.model.fields).join(', ')}.`,
            );
          }
          if (i < segments.length - 1) {
            const next = targetOf(step);
            if (next === undefined) {
              throw new InvalidDependsPathError(
                `The depends path '${path}' of ${where} is invalid: '${segment}' is a ${step.kind} field and cannot be traversed.`,
                'Only many2one, one2many and many2many fields can be followed by another segment.',
              );
            }
            current = resolve(fromModule, next, `the depends path '${path}' of ${where}`);
          }
        });
      }
    }
  }

  const enforce = options.security?.enforce ?? true;
  const mode = enforce === 'warn' ? 'warn' : enforce ? 'enforce' : 'off';
  if (mode === 'warn' && process.env['NODE_ENV'] === 'production') {
    throw new SecurityDefinitionError(
      "security: { enforce: 'warn' } is refused when NODE_ENV=production.",
      "Declare the missing access grants (the warnings name them) and remove enforce: 'warn'.",
    );
  }
  const reported = new Set<string>();
  const onDenied =
    options.security?.onDenied ??
    ((message: string): void => {
      process.emitWarning(message, { code: 'SHUTRO_ACCESS_WOULD_DENY' });
    });
  // Related fields mirror a field of the same kind at the end of their path (many2one steps only).
  for (const { model } of models.values()) {
    for (const [key, field] of Object.entries(model.fields)) {
      const path = relatedPath(field.compute);
      if (path === undefined) continue;
      const where = `Related field '${key}' of ${model.name} ('${path}')`;
      let current: AnyModel = model;
      const steps = path.split('.');
      for (const [i, step] of steps.entries()) {
        const f = current.fields[step];
        if (f === undefined)
          throw new InvalidRelationError(
            `${where}: '${step}' is not a field of ${current.name}.`,
            'Fix the path.',
          );
        if (i === steps.length - 1) {
          const sameTarget = f.kind !== 'many2one' || targetOf(f) === targetOf(field);
          if (f.kind !== field.kind || !sameTarget)
            throw new InvalidRelationError(
              `${where} is a ${field.kind}${field.kind === 'many2one' ? ` of ${targetOf(field)}` : ''}, but the path ends at a ${f.kind}${f.kind === 'many2one' ? ` of ${targetOf(f)}` : ''}.`,
              'Declare the related field with the same kind (and target) as the field it mirrors.',
            );
          break;
        }
        if (f.kind !== 'many2one')
          throw new InvalidRelationError(
            `${where}: '${step}' is a ${f.kind}; related paths go through many2one fields.`,
            'Use a compute for x2many paths.',
          );
        const next = models.get(targetOf(f) ?? '');
        if (next === undefined) break; // the relation check reports unknown targets
        current = next.model;
      }
    }
  }
  const externalIds = validateData(modules, models);
  const registry: Registry<Simplify<SchemaOfModules<Mods>>> = {
    modules: Object.freeze(modules),
    compute: buildComputeGraph(models),
    sequences,
    externalIds,
    security: {
      groups: securityGroups,
      closure: (codes) => groupClosure(securityGroups, codes),
      isAdministrator: (groups) => [...administrators].some((code) => groups.has(code)),
      permissions,
      enforce: mode !== 'off',
      mode,
      denied(message) {
        if (reported.has(message)) return;
        reported.add(message);
        onDenied(message);
      },
    },
    loadOrder: Object.freeze(modules.map((m) => m.name)),
    models,
    has: (name) => models.has(name),
    get(name) {
      const found = models.get(name);
      if (found === undefined) throw new UnknownModelError(name, undefined);
      return found;
    },
    describe(name) {
      const registered = registry.get(name);
      const base = registered.model.describe();
      return {
        ...base,
        origin: { module: registered.module },
        extensions: registered.extensions,
        fields: Object.fromEntries(
          Object.entries(base.fields).map(([key, field]) => [
            key,
            { ...field, origin: { module: registered.fieldOrigins[key] ?? registered.module } },
          ]),
        ),
        methodLayers: registered.methodLayers,
      };
    },
    explain(model, method) {
      const layers = registry.get(model).methodLayers[method];
      if (layers === undefined) throw new UnknownModelError(`${model}.${method}`, 'explain()');
      return layers;
    },
  };
  return Object.freeze(registry);
}
