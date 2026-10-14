/**
 * `buildRegistry()` (RFC 0002 §7.4, first half: loading and cross-model checks). Extensions, overrides and mixins
 * come with the second half.
 */
import {
  DuplicateModelError,
  DuplicateModuleError,
  InvalidDependsPathError,
  InvalidRelationError,
  UndeclaredDependencyError,
  UnknownModelError,
} from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel, FieldDescription, ModelDescription } from '../model/model.js';
import { isModule, type Module } from './module.js';

/** A model and the module that owns it. */
export interface RegisteredModel {
  readonly model: AnyModel;
  readonly module: string;
}

/** Where a model or field comes from. */
export interface Origin {
  readonly module: string;
}

/** `ModelDescription` plus provenance (RFC 0001 §9, RFC 0002 §9). */
export interface RegistryModelDescription extends Omit<ModelDescription, 'fields'> {
  readonly origin: Origin;
  readonly fields: Readonly<Record<string, FieldDescription & { readonly origin: Origin }>>;
}

/** The built, frozen registry. */
export interface Registry {
  /** Modules in load order. */
  readonly modules: readonly Module[];
  /** Module names in load order. */
  readonly loadOrder: readonly string[];
  /** Models in load order (modules first, then definition order). */
  readonly models: ReadonlyMap<string, RegisteredModel>;
  has(name: string): boolean;
  /** @throws {UnknownModelError} */
  get(name: string): RegisteredModel;
  /** @throws {UnknownModelError} */
  describe(name: string): RegistryModelDescription;
}

/** Options of {@link buildRegistry}. */
export interface RegistryOptions {
  /** The application's modules; their dependencies are collected transitively. */
  readonly modules: readonly Module[];
}

const RELATION_KINDS = new Set(['many2one', 'one2many', 'many2many']);

function targetOf(field: Field): string | undefined {
  return RELATION_KINDS.has(field.kind)
    ? (field as unknown as { target: string }).target
    : undefined;
}

/** Collects every module reachable from the roots and checks that names are unique. */
function collect(roots: readonly Module[]): Map<string, Module> {
  const byName = new Map<string, Module>();
  const visit = (module: Module): void => {
    if (!isModule(module)) {
      throw new DuplicateModuleError(String((module as { name?: unknown }).name ?? '?'));
    }
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
function order(byName: ReadonlyMap<string, Module>): Module[] {
  const remaining = new Map<string, Set<string>>();
  for (const [name, module] of byName)
    remaining.set(name, new Set(module.depends.map((d) => d.name)));
  const result: Module[] = [];
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
function closure(module: Module): Set<string> {
  const names = new Set<string>();
  const walk = (m: Module): void => {
    if (names.has(m.name)) return;
    names.add(m.name);
    for (const dep of m.depends) walk(dep);
  };
  walk(module);
  return names;
}

/**
 * Builds the registry: collects and orders modules, registers models, and runs the checks that need every model:
 * relation targets exist and belong to a declared dependency, one2many inverses point back, `depends` paths resolve.
 *
 * @throws {DuplicateModuleError} {DuplicateModelError} {UnknownModelError} {UndeclaredDependencyError}
 * {InvalidRelationError} {InvalidDependsPathError}
 */
export function buildRegistry(options: RegistryOptions): Registry {
  const modules = order(collect(options.modules));
  const models = new Map<string, RegisteredModel>();
  for (const module of modules) {
    for (const model of module.models) {
      const existing = models.get(model.name);
      if (existing !== undefined)
        throw new DuplicateModelError(model.name, [existing.module, module.name]);
      models.set(model.name, { model, module: module.name });
    }
  }

  const closures = new Map(modules.map((m) => [m.name, closure(m)]));
  const resolve = (from: RegisteredModel, target: string, via: string): RegisteredModel => {
    const found = models.get(target);
    if (found === undefined) throw new UnknownModelError(target, via);
    if (!closures.get(from.module)?.has(found.module)) {
      throw new UndeclaredDependencyError(from.module, target, found.module, via);
    }
    return found;
  };

  for (const registered of models.values()) {
    const { model } = registered;
    for (const [key, field] of Object.entries(model.fields)) {
      const where = `field '${key}' of model '${model.name}'`;
      const target = targetOf(field);
      if (target !== undefined) {
        const other = resolve(registered, target, where);
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
            current = resolve(current, next, `the depends path '${path}' of ${where}`);
          }
        });
      }
    }
  }

  const registry: Registry = {
    modules: Object.freeze(modules),
    loadOrder: Object.freeze(modules.map((m) => m.name)),
    models,
    has: (name) => models.has(name),
    get(name) {
      const found = models.get(name);
      if (found === undefined) throw new UnknownModelError(name, undefined);
      return found;
    },
    describe(name) {
      const { model, module } = registry.get(name);
      const base = model.describe();
      const origin: Origin = { module };
      return {
        ...base,
        origin,
        fields: Object.fromEntries(
          Object.entries(base.fields).map(([key, field]) => [key, { ...field, origin }]),
        ),
      };
    },
  };
  return Object.freeze(registry);
}
