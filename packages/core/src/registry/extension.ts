/**
 * `extendModel()` (RFC 0002 §7.2–7.3): a module's contribution to a model owned by a dependency. Extensions are
 * plain data; the registry applies them in load order and enforces the view-safety rules.
 */
import type { AccessSpec, FieldGroupsInput, RuleSpec } from '@shutro/security';
import { InvalidExtensionError } from '../errors.js';
import {
  type Field,
  type IndexKind,
  isField,
  type StateSpec,
  type Transition,
} from '../model/field.js';
import {
  type ConstraintSpec,
  type FieldsRecord,
  type IndexSpec,
  type MethodsRecord,
  type OnchangeFn,
  RESERVED_KEYS,
  type SqlCheckConstraint,
  type SqlUniqueConstraint,
} from '../model/model.js';

/**
 * An override layer: receives the previous implementation as `next` (bound to `this`), then the call's arguments.
 * Parameters are `never` so that any typed implementation is accepted; `shutro generate` will type `next` exactly.
 */
export type OverrideFn = (this: unknown, next: never, ...args: never[]) => unknown;

/** A `replace()`d implementation: the previous layers are dropped (reported by the inspector). */
export interface Replacement {
  readonly '~replace': true;
  readonly fn: (this: unknown, ...args: never[]) => unknown;
}

/** Marks an override that intentionally does not call `next` (RFC 0002 §7.3). */
export function replace(fn: (this: unknown, ...args: never[]) => unknown): Replacement {
  if (typeof fn !== 'function') {
    throw new InvalidExtensionError(
      'replace() expects a function.',
      'Pass the new implementation: replace(function () { ... }).',
    );
  }
  return Object.freeze({ '~replace': true as const, fn });
}

/** Changes an extension may make to an existing field (RFC 0002 §7.5 S2–S6). */
export interface FieldOverride {
  readonly label?: string;
  readonly help?: string;
  readonly default?: unknown;
  readonly index?: IndexKind;
  readonly tracking?: boolean;
  readonly copy?: boolean;
  readonly groups?: FieldGroupsInput;
  /** May only tighten (`true`), and then needs a default (here or on the field). */
  readonly required?: boolean;
  /** New values for an `extensible` selection or state. */
  readonly selectionAdd?: Readonly<Record<string, string>>;
  /** New states of an `extensible` state field (RFC 0010 §7.4). */
  readonly statesAdd?: Readonly<Record<string, string | StateSpec>>;
  /** New transitions of an `extensible` state field; existing ones are never changed. */
  readonly transitionsAdd?: Readonly<Record<string, Transition<string>>>;
}

/** The argument of {@link extendModel} after the model name. */
export interface ExtensionDefinition<Fs extends FieldsRecord, Ms extends MethodsRecord> {
  /** New fields. Required ones need a default or a compute (S1). */
  readonly fields?: Fs;
  readonly fieldOverrides?: Readonly<Record<string, FieldOverride>>;
  /** New methods (an existing name is a conflict: use `overrides`). */
  readonly methods?: Ms;
  /** Wrappers of existing methods, receiving `next`. */
  readonly overrides?: Readonly<Record<string, OverrideFn | Replacement>>;
  readonly constraints?: Readonly<Record<string, ConstraintSpec>>;
  /** Onchange handlers for fields without one (an existing key is a conflict). */
  readonly onchange?: Readonly<Record<string, OnchangeFn>>;
  /** Permissions to add (never removed). */
  readonly access?: AccessSpec;
  /** Record rules to add (an existing key is a conflict). */
  readonly rules?: Readonly<Record<string, RuleSpec>>;
  readonly sqlConstraints?: Readonly<
    Record<string, SqlUniqueConstraint<string> | SqlCheckConstraint>
  >;
  readonly indexes?: readonly IndexSpec<string>[];
  readonly tracking?: readonly string[];
  /** Turn on change events for the model (RFC 0018 §7.5); an extension cannot turn them off. */
  readonly changeEvents?: boolean;
}

/** An extension as `extendModel` returns it. `fields` / `methods` carry types for the registry's schema view. */
export interface Extension<
  N extends string = string,
  Fs extends FieldsRecord = FieldsRecord,
  Ms extends MethodsRecord = MethodsRecord,
> {
  readonly '~extension': true;
  readonly name: N;
  readonly fields: Fs;
  readonly fieldOverrides: Readonly<Record<string, FieldOverride>>;
  readonly methods: Ms;
  readonly overrides: Readonly<
    Record<string, { readonly kind: 'override' | 'replace'; readonly fn: OverrideFn }>
  >;
  readonly constraints: Readonly<Record<string, ConstraintSpec>>;
  readonly onchange: Readonly<Record<string, OnchangeFn>>;
  readonly access: AccessSpec;
  readonly rules: Readonly<Record<string, RuleSpec>>;
  readonly sqlConstraints: Readonly<
    Record<string, SqlUniqueConstraint<string> | SqlCheckConstraint>
  >;
  readonly indexes: readonly IndexSpec<string>[];
  readonly tracking: readonly string[];
  readonly changeEvents: boolean;
}

/** Any extension. */
export type AnyExtension = Extension<string, FieldsRecord, MethodsRecord>;

const MODEL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const KEY = /^[a-z][a-zA-Z0-9]*$/;

const extensions = new WeakSet<object>();

/** True when `value` was produced by {@link extendModel}. */
export function isExtension(value: unknown): value is AnyExtension {
  return typeof value === 'object' && value !== null && extensions.has(value);
}

function isReplacement(value: unknown): value is Replacement {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { '~replace'?: unknown })['~replace'] === true
  );
}

/**
 * Declares an extension of model `name` (owned by a module this module depends on).
 *
 * @example
 * ```ts
 * export const SaleOrderStock = extendModel('sale.order', {
 *   fields: { warehouse: f.many2one('stock.warehouse', { required: true, default: (env) => ... }) },
 *   overrides: { async confirm(next): Promise<void> { await next(); await this.createPickings(); } },
 * });
 * ```
 * @throws {InvalidExtensionError} for a bad model name, non-camelCase or reserved keys, non-descriptor fields, or
 * overrides that aren't functions / `replace()` markers.
 */
export function extendModel<
  const N extends string,
  const Fs extends FieldsRecord = Record<never, never>,
  const Ms extends MethodsRecord = Record<never, never>,
>(name: N, definition: ExtensionDefinition<Fs, Ms>): Extension<N, Fs, Ms> {
  if (typeof name !== 'string' || !MODEL_NAME.test(name)) {
    throw new InvalidExtensionError(
      `${JSON.stringify(name)} is not a valid model name.`,
      "Use the model's dotted name, e.g. extendModel('sale.order', { ... }).",
    );
  }
  const fields = definition.fields ?? ({} as Fs);
  for (const [key, field] of Object.entries(fields)) {
    if (!KEY.test(key))
      throw new InvalidExtensionError(
        `Extension of '${name}': field key '${key}' is not camelCase.`,
        "Use keys like 'deliveryDate'.",
      );
    if (RESERVED_KEYS.includes(key))
      throw new InvalidExtensionError(
        `Extension of '${name}': '${key}' is a reserved field name.`,
        'Rename the field.',
      );
    if (!isField(field as Field))
      throw new InvalidExtensionError(
        `Extension of '${name}': field '${key}' is not a descriptor made by f.*.`,
        'Build fields with f.char(), f.many2one(), …',
      );
  }
  const methods = definition.methods ?? ({} as Ms);
  for (const [key, fn] of Object.entries(methods)) {
    if (!KEY.test(key) || RESERVED_KEYS.includes(key))
      throw new InvalidExtensionError(
        `Extension of '${name}': method name '${key}' is invalid or reserved.`,
        "Use names like 'createPickings'.",
      );
    if (typeof fn !== 'function')
      throw new InvalidExtensionError(
        `Extension of '${name}': method '${key}' is not a function.`,
        'Methods are functions taking a recordset.',
      );
  }
  const overrides: Record<
    string,
    { readonly kind: 'override' | 'replace'; readonly fn: OverrideFn }
  > = {};
  for (const [key, value] of Object.entries(definition.overrides ?? {})) {
    if (!KEY.test(key))
      throw new InvalidExtensionError(
        `Extension of '${name}': override name '${key}' is not camelCase.`,
        'Name the method being overridden.',
      );
    if (isReplacement(value))
      overrides[key] = { kind: 'replace', fn: value.fn as unknown as OverrideFn };
    else if (typeof value === 'function') overrides[key] = { kind: 'override', fn: value };
    else
      throw new InvalidExtensionError(
        `Extension of '${name}': override '${key}' is not a function.`,
        'Write overrides: { confirm(next, ...args) { ...; return next(...args); } } or replace(fn).',
      );
  }
  for (const [key, override] of Object.entries(definition.fieldOverrides ?? {})) {
    if (!KEY.test(key))
      throw new InvalidExtensionError(
        `Extension of '${name}': fieldOverrides key '${key}' is not camelCase.`,
        'Name the field being changed.',
      );
    if (typeof override !== 'object' || override === null)
      throw new InvalidExtensionError(
        `Extension of '${name}': fieldOverrides.${key} must be an object.`,
        "E.g. { label: 'Reference', required: true, default: 'x' }.",
      );
  }
  const extension: Extension<N, Fs, Ms> = Object.freeze({
    '~extension': true as const,
    name,
    fields: Object.freeze({ ...fields }) as Fs,
    fieldOverrides: Object.freeze({ ...(definition.fieldOverrides ?? {}) }),
    methods: Object.freeze({ ...methods }) as Ms,
    overrides: Object.freeze(overrides),
    constraints: Object.freeze({ ...(definition.constraints ?? {}) }),
    onchange: Object.freeze({ ...(definition.onchange ?? {}) }),
    access: Object.freeze({ ...(definition.access ?? {}) }),
    rules: Object.freeze({ ...(definition.rules ?? {}) }),
    sqlConstraints: Object.freeze({ ...(definition.sqlConstraints ?? {}) }),
    indexes: Object.freeze([...(definition.indexes ?? [])]),
    tracking: Object.freeze([...(definition.tracking ?? [])]),
    changeEvents: definition.changeEvents === true,
  });
  extensions.add(extension);
  return extension;
}
