/**
 * `defineModel()` (RFC 0001 §7): merges implicit fields, derives names, validates everything that only needs the
 * model itself (sibling references, methods, constraints), and exposes runtime metadata for Kosh.
 * Cross-model checks (relation targets, `depends` paths, one2many inverses) belong to the registry (RFC 0002).
 */
import { isSql, type SqlFragment } from '@shutro/sql';
import type { Env } from '../env/env.js';
import { InvalidModelError } from '../errors.js';
import { companyConsistencyCheck } from './company.js';
import type { FlagsOfField } from './faces.js';
import {
  type CharField,
  type Field,
  f,
  type IdField,
  implicitIdField,
  isField,
  type Many2oneField,
  type ScalarField,
  withDefaultLabel,
} from './field.js';
import type { Id } from './id.js';

// ------------------------------------------------------------------------------------------------- field records

/** A record of field descriptors. */
export type FieldsRecord = Readonly<Record<string, Field>>;
/** Model methods. Parameter and return types must be explicit (RFC 0001 §7.8); `this` is typed by the recordset layer. */
export type MethodsRecord = Readonly<Record<string, (...args: never[]) => unknown>>;
type NoMethods = Record<never, never>;
type NoFields = Record<never, never>;

/** Generated transition methods of the state fields in `Fs` (RFC 0010 §7.1). */
export type TransitionMethods<Fs> = {
  readonly [K in keyof Fs as Fs[K] extends { readonly transitions: infer T }
    ? keyof T & string
    : never]: () => Promise<void>;
};

const TRANSITION = Symbol.for('shutro.transition');
/** The state field and transition a generated (or wrapped) method runs, if it is one (RFC 0010 §7.1). */
export function transitionOf(
  fn: unknown,
): { readonly field: string; readonly name: string } | undefined {
  return typeof fn === 'function'
    ? ((
        fn as unknown as Record<
          symbol,
          { readonly field: string; readonly name: string } | undefined
        >
      )[TRANSITION] ?? undefined)
    : undefined;
}
/** @internal Marks `fn` as running transition `name` of `field`. */
export function markTransition<F>(fn: F, field: string, name: string): F {
  Object.defineProperty(fn, TRANSITION, {
    value: Object.freeze({ field, name }),
    enumerable: false,
  });
  return fn;
}

/** `companyScoped` option: adds a `company` many2one. Nullable means "shared across companies". */
export interface CompanyScope {
  readonly required: boolean;
}

type ReadonlyRequired = {
  required: true;
  readonly: true;
  computed: false;
  inverse: false;
  hasDefault: false;
  sequence: false;
};
type ReadonlyOptional = {
  required: false;
  readonly: true;
  computed: false;
  inverse: false;
  hasDefault: false;
  sequence: false;
};

/** The fields every model has (RFC 0001 §7.4). */
export interface ImplicitFieldsBase<N extends string> {
  readonly id: IdField<N>;
  readonly createdAt: ScalarField<'datetime', Date, Date, ReadonlyRequired>;
  readonly updatedAt: ScalarField<'datetime', Date, Date, ReadonlyRequired>;
  readonly createdBy: Many2oneField<'res.users', ReadonlyOptional>;
  readonly updatedBy: Many2oneField<'res.users', ReadonlyOptional>;
  /** Non-stored, computed from `recName` unless the model defines it. */
  readonly displayName: CharField<{
    required: true;
    readonly: true;
    computed: true;
    inverse: false;
    hasDefault: false;
    sequence: false;
  }>;
}
/** `archivable: true` adds `active`. */
export type ActiveField = ScalarField<
  'boolean',
  boolean,
  boolean,
  {
    required: true;
    readonly: false;
    computed: false;
    inverse: false;
    hasDefault: true;
    sequence: false;
  }
>;
/** `companyScoped` adds `company`. */
export type CompanyField<R extends boolean> = Many2oneField<
  'res.company',
  {
    required: R;
    readonly: false;
    computed: false;
    inverse: false;
    hasDefault: true;
    sequence: false;
  }
>;

/** Implicit fields for the given opt-ins. */
export type ImplicitFields<
  N extends string,
  A extends boolean,
  C extends CompanyScope | undefined,
> = ImplicitFieldsBase<N> &
  (A extends true ? { readonly active: ActiveField } : NoFields) &
  (C extends { readonly required: infer R extends boolean }
    ? { readonly company: CompanyField<R> }
    : NoFields);

type Simplify<T> = { [K in keyof T]: T[K] } & NonNullable<unknown>;

/** The model's fields: implicit ones (a user-defined `displayName` wins) plus the declared ones. */
export type ModelFields<
  N extends string,
  Fs extends FieldsRecord,
  A extends boolean,
  C extends CompanyScope | undefined,
> = Simplify<Omit<ImplicitFields<N, A, C>, keyof Fs> & Fs>;

// ----------------------------------------------------------------------------------------------------- options

/** `'field'`, `'field asc'` or `'field desc'`. */
export type OrderSpec<K extends string> = K | `${K} asc` | `${K} desc`;

/** A unique constraint over stored fields, optionally partial. */
export interface SqlUniqueConstraint<K extends string> {
  readonly unique: readonly K[];
  readonly where?: SqlFragment;
  /** Shown to users when the constraint fails. Say what to do. */
  readonly message: string;
}
/** A check constraint written with the `sql` tag. */
export interface SqlCheckConstraint {
  readonly check: SqlFragment;
  readonly message: string;
}
/** An index over stored fields. */
export interface IndexSpec<K extends string> {
  readonly fields: readonly K[];
  readonly unique?: boolean;
  readonly where?: SqlFragment;
  readonly method?: 'btree' | 'gin' | 'gist' | 'brin';
}
/** A batch business constraint (RFC 0001 §7.7). Typed by the recordset layer. */
export interface ConstraintSpec {
  /** Fields whose change triggers the check. */
  readonly depends: readonly string[];
  /** Returns the failing records. */
  readonly check: (records: never) => unknown;
  readonly message: string | ((failing: never) => string);
}
/** An onchange handler (RFC 0009 §7.3): receives the draft and the environment. Typed by the recordset layer. */
export type OnchangeFn = (draft: never, env: never) => void | Promise<void>;

/** The argument of {@link defineModel} after `name`. */
export interface ModelDefinition<
  Fs extends FieldsRecord,
  Ms extends MethodsRecord,
  A extends boolean,
  C extends CompanyScope | undefined,
> {
  readonly fields: Fs;
  readonly methods?: Ms;
  /** Human label; defaults to the humanized model name. */
  readonly label?: string;
  /** Table name; defaults to the model name with dots replaced by underscores. */
  readonly table?: string;
  /** Default ordering; defaults to `['id asc']`. An `id` tiebreaker is appended by the query layer. */
  readonly order?: readonly OrderSpec<ModelKeys<Fs, A, C>>[];
  /** The field shown as a record's name; defaults to `name` when present, else `id`. */
  readonly recName?: ModelKeys<Fs, A, C>;
  readonly archivable?: A;
  readonly companyScoped?: C;
  /** Fields whose changes are tracked in the audit trail. */
  readonly tracking?: readonly ModelKeys<Fs, A, C>[];
  readonly indexes?: readonly IndexSpec<ModelKeys<Fs, A, C>>[];
  readonly sqlConstraints?: Readonly<
    Record<string, SqlUniqueConstraint<ModelKeys<Fs, A, C>> | SqlCheckConstraint>
  >;
  readonly constraints?: Readonly<Record<string, ConstraintSpec>>;
  /** Form-assist handlers keyed by the field they react to (RFC 0009 §7.3). */
  readonly onchange?: Readonly<Record<string, OnchangeFn>>;
}

type ModelKeys<
  Fs extends FieldsRecord,
  A extends boolean,
  C extends CompanyScope | undefined,
> = keyof ModelFields<string, Fs, A, C> & string;

// --------------------------------------------------------------------------------------------- sibling checks

/** Keys that can't be user fields or methods: implicit fields and the recordset API (RFC 0001 §7.5). */
export const RESERVED_KEYS: readonly string[] = Object.freeze([
  'id',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'env',
  'ids',
  'model',
  'length',
  'load',
  'read',
  'write',
  'create',
  'unlink',
  'search',
  'browse',
  'exists',
  'ensureOne',
  'first',
  'filter',
  'map',
  'mapped',
  'sortedBy',
  'groupBy',
  'sum',
  'union',
  'intersect',
  'minus',
  'concat',
  'copy',
  'withEnv',
  'withCompany',
  'withLang',
  'withFlags',
  'toJSON',
  'describe',
  'equals',
  'isEmpty',
  'names',
  'modelName',
  'registered',
  'resolveIds',
  'fieldValue',
]);
/** @see RESERVED_KEYS */
export type ReservedKey =
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'createdBy'
  | 'updatedBy'
  | 'env'
  | 'ids'
  | 'model'
  | 'length'
  | 'load'
  | 'read'
  | 'write'
  | 'create'
  | 'unlink'
  | 'search'
  | 'browse'
  | 'exists'
  | 'ensureOne'
  | 'first'
  | 'filter'
  | 'map'
  | 'mapped'
  | 'sortedBy'
  | 'groupBy'
  | 'sum'
  | 'union'
  | 'intersect'
  | 'minus'
  | 'concat'
  | 'copy'
  | 'withEnv'
  | 'withCompany'
  | 'withLang'
  | 'withFlags'
  | 'toJSON'
  | 'describe'
  | 'equals'
  | 'isEmpty'
  | 'names'
  | 'modelName'
  | 'registered'
  | 'resolveIds'
  | 'fieldValue';

type KeysTargeting<Fs, T extends string> = {
  [K in keyof Fs]: Fs[K] extends { readonly kind: 'many2one'; readonly target: T } ? K : never;
}[keyof Fs] &
  string;

type SiblingRule<K, F, Fs> = K extends ReservedKey
  ? never
  : F extends { readonly kind: 'monetary'; readonly currencyField: infer C }
    ? C extends KeysTargeting<Fs, 'res.currency'>
      ? unknown
      : { readonly currencyField: KeysTargeting<Fs, 'res.currency'> }
    : F extends { readonly kind: 'quantity'; readonly uomField: infer U }
      ? U extends KeysTargeting<Fs, 'uom.uom'>
        ? unknown
        : { readonly uomField: KeysTargeting<Fs, 'uom.uom'> }
      : unknown;

type ComputeRule<F, Ms> = FlagsOfField<F>['computeName'] extends infer Cm
  ? Cm extends string
    ? string extends Cm
      ? unknown
      : Cm extends keyof Ms
        ? unknown
        : { readonly compute: keyof Ms & string }
    : unknown
  : unknown;

/**
 * Per-field constraints that need the whole `fields` record: reserved keys, `monetary.currency` →
 * `many2one('res.currency')`, `quantity.uom` → `many2one('uom.uom')`, `compute: 'name'` → a method.
 * Non-homomorphic on purpose so it is never an inference source for `Fs`.
 */
export type FieldRules<Fs extends FieldsRecord, Ms extends MethodsRecord> = {
  readonly [K in keyof Fs & string]: SiblingRule<K, Fs[K], Fs> & ComputeRule<Fs[K], Ms>;
};

// -------------------------------------------------------------------------------------------------- the model

/** One term of a model's default order. */
export interface OrderTerm<K extends string> {
  readonly field: K;
  readonly direction: 'asc' | 'desc';
}
/** A resolved SQL constraint with its PostgreSQL name. */
export interface ResolvedSqlConstraint<K extends string> {
  readonly key: string;
  readonly name: string;
  readonly kind: 'unique' | 'check';
  readonly fields: readonly K[];
  readonly columns: readonly string[];
  readonly where?: SqlFragment | undefined;
  readonly check?: SqlFragment;
  readonly message: string;
}
/** A resolved index with its PostgreSQL name. */
export interface ResolvedIndex<K extends string> {
  readonly name: string;
  readonly fields: readonly K[];
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where: SqlFragment | undefined;
  readonly method: 'btree' | 'gin' | 'gist' | 'brin';
}
/** A resolved business constraint. */
export interface ResolvedConstraint extends ConstraintSpec {
  readonly key: string;
}

/** A defined model: frozen metadata plus the types of its fields and methods. */
export interface Model<N extends string, Fs extends FieldsRecord, Ms extends MethodsRecord> {
  readonly name: N;
  readonly table: string;
  readonly label: string;
  readonly fields: Fs;
  /** Column per field key; `undefined` for x2many relations and non-stored computes. */
  readonly columns: { readonly [K in keyof Fs]: string | undefined };
  readonly order: readonly OrderTerm<keyof Fs & string>[];
  readonly recName: keyof Fs & string;
  readonly archivable: boolean;
  readonly companyScoped: CompanyScope | undefined;
  readonly tracking: readonly (keyof Fs & string)[];
  readonly indexes: readonly ResolvedIndex<keyof Fs & string>[];
  readonly sqlConstraints: readonly ResolvedSqlConstraint<keyof Fs & string>[];
  readonly constraints: readonly ResolvedConstraint[];
  readonly onchange: Readonly<Record<string, OnchangeFn>>;
  readonly methods: Ms;
  /** Keys of the fields the model declared itself (implicit fields excluded); extensions add to these. */
  readonly declaredFields: readonly string[];
  /** The definition as given, so the registry can rebuild the model with extensions applied. */
  readonly definition: ModelDefinition<
    FieldsRecord,
    MethodsRecord,
    boolean,
    CompanyScope | undefined
  >;
  /** Plain, JSON-serializable metadata (RFC 0001 §9). */
  describe(): ModelDescription;
}

/** Any model. */
export type AnyModel = Model<string, FieldsRecord, MethodsRecord>;

/** JSON-serializable description of a field. Kind-specific keys are present only where they apply. */
export interface FieldDescription {
  readonly kind: string;
  readonly label: string;
  readonly help: string | null;
  readonly column: string | null;
  readonly pgType: string;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly store: boolean;
  readonly computed: boolean;
  /** The method name, `'inline'`, or `null`. */
  readonly compute: string | null;
  readonly depends: readonly string[];
  readonly hasDefault: boolean;
  readonly index: string | null;
  readonly copy: boolean;
  readonly tracking: boolean;
  readonly translate: boolean;
  readonly sequence: { readonly code: string; readonly gapless: boolean } | null;
  readonly deprecated: string | null;
  readonly groups: readonly string[];
  readonly [extra: string]: unknown;
}

/** JSON-serializable description of a model. */
export interface ModelDescription {
  readonly name: string;
  readonly label: string;
  readonly table: string;
  readonly recName: string;
  readonly order: readonly OrderTerm<string>[];
  readonly archivable: boolean;
  readonly companyScoped: CompanyScope | null;
  readonly tracking: readonly string[];
  readonly fields: Readonly<Record<string, FieldDescription>>;
  readonly sqlConstraints: readonly {
    readonly key: string;
    readonly name: string;
    readonly kind: 'unique' | 'check';
    readonly fields: readonly string[];
    readonly message: string;
  }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly fields: readonly string[];
    readonly unique: boolean;
    readonly method: string;
    readonly partial: boolean;
  }[];
  readonly constraints: readonly {
    readonly key: string;
    readonly depends: readonly string[];
    readonly message: string | null;
  }[];
  readonly methods: readonly string[];
  /** Fields with an onchange handler. */
  readonly onchange: readonly string[];
}

// --------------------------------------------------------------------------------------------------- helpers

const MODEL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER = 63;

const models = new WeakSet<object>();

/** @internal The compute of the implicit `displayName`: the engine derives it from `recName` (RFC 0008 §7.1). */
export const defaultDisplayName = (): undefined => undefined;

/** True when `value` was produced by {@link defineModel}. */
export function isModel(value: unknown): value is AnyModel {
  return typeof value === 'object' && value !== null && models.has(value);
}

/** `amountTotal` → `amount_total`. */
export function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** `amountTotal` → `Amount Total`, `sale.order` → `Sale Order`. */
export function humanize(name: string): string {
  return name
    .replace(/[._]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function columnOf(key: string, field: Field): string | undefined {
  if (!field.store) return undefined;
  if (field.column !== undefined) return field.column;
  const snake = snakeCase(key);
  return field.kind === 'many2one' ? `${snake}_id` : snake;
}

function fail(model: string, problem: string, hint: string): never {
  throw new InvalidModelError(model, problem, hint);
}

function sqlName(table: string, suffix: string, model: string): string {
  const name = `${table}_${suffix}`;
  if (name.length > MAX_IDENTIFIER) {
    fail(
      model,
      `the PostgreSQL name '${name}' is longer than ${MAX_IDENTIFIER} characters.`,
      'Use a shorter table name or constraint/index key.',
    );
  }
  return name;
}

// ---------------------------------------------------------------------------------------------- defineModel

/**
 * Defines a model (RFC 0001).
 *
 * @example
 * ```ts
 * export const SaleOrder = defineModel('sale.order', {
 *   companyScoped: { required: true },
 *   fields: {
 *     name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),
 *     partner: f.many2one('res.partner', { required: true }),
 *     currency: f.many2one('res.currency', { required: true }),
 *     amountTotal: f.monetary({ currency: 'currency', store: true, depends: ['lines.subtotal'], compute: 'computeAmounts' }),
 *   },
 *   methods: { computeAmounts(): void { … } },
 * });
 * ```
 * @throws {InvalidModelError} for reserved or non-camelCase keys, column collisions, a `monetary.currency` that
 * isn't a `many2one('res.currency')`, a `compute` name that isn't a method, and invalid order / constraints / indexes.
 */
export function defineModel<
  const N extends string,
  const Fs extends FieldsRecord,
  const Ms extends MethodsRecord = NoMethods,
  const A extends boolean = false,
  const C extends CompanyScope | undefined = undefined,
>(
  name: N,
  definition: ModelDefinition<Fs, Ms, A, C> & {
    readonly fields: FieldRules<NoInfer<Fs>, NoInfer<Ms>>;
  },
): Model<N, ModelFields<N, Fs, A, C>, Ms & TransitionMethods<Fs>> {
  if (typeof name !== 'string' || !MODEL_NAME.test(name)) {
    throw new InvalidModelError(
      String(name),
      'the model name is not a dotted lower-case identifier.',
      "Use names such as 'res.partner' or 'sale.order.line'.",
    );
  }
  const table = definition.table ?? name.replaceAll('.', '_');
  if (!IDENTIFIER.test(table) || table.length > MAX_IDENTIFIER) {
    fail(
      name,
      `'${table}' is not a valid table name.`,
      'Use lower-case snake_case, at most 63 characters.',
    );
  }

  // --- user fields
  const user: Record<string, Field> = {};
  for (const [key, field] of Object.entries(definition.fields)) {
    if (!FIELD_KEY.test(key))
      fail(
        name,
        `field key '${key}' is not camelCase.`,
        "Use keys like 'amountTotal'; columns become snake_case automatically.",
      );
    if (RESERVED_KEYS.includes(key) && key !== 'displayName') {
      fail(
        name,
        `'${key}' is a reserved field name.`,
        `Rename the field; reserved: ${RESERVED_KEYS.join(', ')}.`,
      );
    }
    if (!isField(field))
      fail(
        name,
        `field '${key}' is not a descriptor made by f.*.`,
        'Build fields with f.char(), f.many2one(), …',
      );
    user[key] = withDefaultLabel(field, humanize(key));
  }

  // --- implicit fields
  const implicit: Record<string, Field> = {
    id: implicitIdField(name),
    createdAt: f.datetime({ required: true, readonly: true, label: 'Created At', copy: false }),
    updatedAt: f.datetime({ required: true, readonly: true, label: 'Updated At', copy: false }),
    createdBy: f.many2one('res.users', {
      readonly: true,
      ondelete: 'set null',
      label: 'Created By',
      copy: false,
    }),
    updatedBy: f.many2one('res.users', {
      readonly: true,
      ondelete: 'set null',
      label: 'Updated By',
      copy: false,
    }),
    displayName:
      user['displayName'] ??
      f.char({ required: true, label: 'Display Name', compute: defaultDisplayName, copy: false }),
  };
  if (definition.archivable === true)
    implicit['active'] = f.boolean({ default: true, label: 'Active' });
  if (definition.companyScoped !== undefined) {
    implicit['company'] = f.many2one('res.company', {
      required: definition.companyScoped.required,
      label: 'Company',
      index: true,
      default: (env: Env) => env.companyId as Id<'res.company'>,
    });
  }
  const fields: Record<string, Field> = { ...implicit };
  for (const [key, field] of Object.entries(user)) if (key !== 'displayName') fields[key] = field;
  const keys = Object.keys(fields);
  const has = (key: string): boolean => Object.hasOwn(fields, key);

  // --- columns
  const columns: Record<string, string | undefined> = {};
  const seen = new Map<string, string>();
  for (const [key, field] of Object.entries(fields)) {
    const column = columnOf(key, field);
    columns[key] = column;
    if (column === undefined) continue;
    const other = seen.get(column);
    if (other !== undefined) {
      fail(
        name,
        `fields '${other}' and '${key}' both map to column '${column}'.`,
        'Rename one of them, or set `column` explicitly on one.',
      );
    }
    seen.set(column, key);
  }

  // --- methods
  const methods: Record<string, (...args: never[]) => unknown> = { ...(definition.methods ?? {}) };
  for (const [key, fn] of Object.entries(methods)) {
    if (!FIELD_KEY.test(key))
      fail(name, `method name '${key}' is not camelCase.`, "Use names like 'computeAmounts'.");
    if (RESERVED_KEYS.includes(key))
      fail(
        name,
        `'${key}' is a reserved method name.`,
        'Rename the method; it would shadow the recordset API.',
      );
    if (typeof fn !== 'function')
      fail(name, `method '${key}' is not a function.`, 'Methods are functions taking a recordset.');
  }

  // --- sibling references
  const expectTarget = (key: string, ref: string, target: string, option: string): void => {
    const sibling = fields[ref];
    if (
      sibling === undefined ||
      sibling.kind !== 'many2one' ||
      (sibling as Many2oneField<string, never>).target !== target
    ) {
      fail(
        name,
        `field '${key}' has ${option}: '${ref}', which is not a many2one('${target}') field of this model.`,
        `Point ${option} at a sibling field declared as f.many2one('${target}').`,
      );
    }
  };
  for (const [key, field] of Object.entries(fields)) {
    if (field.kind === 'monetary')
      expectTarget(
        key,
        (field as unknown as { currencyField: string }).currencyField,
        'res.currency',
        'currency',
      );
    if (field.kind === 'quantity')
      expectTarget(key, (field as unknown as { uomField: string }).uomField, 'uom.uom', 'uom');
    if (typeof field.compute === 'string' && typeof methods[field.compute] !== 'function') {
      fail(
        name,
        `field '${key}' has compute: '${field.compute}', which is not a method of this model.`,
        'Add the method under `methods`, or pass an inline compute function.',
      );
    }
  }

  // --- order, recName, tracking
  const order: OrderTerm<string>[] = (definition.order ?? ['id asc']).map((spec) => {
    const [field, direction = 'asc', ...rest] = spec.split(' ');
    if (field === undefined || rest.length > 0 || (direction !== 'asc' && direction !== 'desc')) {
      fail(
        name,
        `order entry '${spec}' is malformed.`,
        "Use 'field', 'field asc' or 'field desc'.",
      );
    }
    if (!has(field) || fields[field]?.kind === 'one2many' || fields[field]?.kind === 'many2many') {
      fail(
        name,
        `order refers to '${field}', which is not a sortable field.`,
        'Order by scalar fields or many2one ids; sort by related names with a path (query layer).',
      );
    }
    return { field, direction };
  });
  const recName = definition.recName ?? (has('name') ? 'name' : 'id');
  if (
    !has(recName) ||
    fields[recName]?.kind === 'one2many' ||
    fields[recName]?.kind === 'many2many'
  ) {
    fail(
      name,
      `recName '${recName}' is not a scalar field.`,
      'Choose a char/text field (or leave it to `name`).',
    );
  }
  const tracking = [...(definition.tracking ?? [])];
  for (const key of tracking)
    if (!has(key))
      fail(name, `tracking refers to unknown field '${key}'.`, 'List existing field keys.');

  // --- transitions become methods (RFC 0010 §7.1)
  for (const [key, field] of Object.entries(fields)) {
    if (field.kind !== 'state') continue;
    const transitions = (field as unknown as { transitions: Record<string, unknown> }).transitions;
    for (const tname of Object.keys(transitions)) {
      const existing = methods[tname];
      if (existing !== undefined && transitionOf(existing) === undefined)
        fail(
          name,
          `transition '${tname}' of state field '${key}' clashes with method '${tname}'.`,
          'A transition is already a method: remove the declared one, or wrap it with overrides in an extension.',
        );
      if (RESERVED_KEYS.includes(tname))
        fail(
          name,
          `transition '${tname}' is a reserved name.`,
          'Rename the transition; it would shadow the recordset API.',
        );
      if (existing === undefined)
        methods[tname] = markTransition(
          function transition(this: unknown): Promise<void> {
            return (this as { transition(k: string, n: string): Promise<void> }).transition(
              key,
              tname,
            );
          },
          key,
          tname,
        );
    }
  }

  // --- SQL constraints
  const sqlConstraints: ResolvedSqlConstraint<string>[] = Object.entries(
    definition.sqlConstraints ?? {},
  ).map(([key, spec]) => {
    if (!FIELD_KEY.test(key))
      fail(
        name,
        `sqlConstraints key '${key}' is not camelCase.`,
        "Use keys like 'nameUniquePerCompany'.",
      );
    if (typeof spec.message !== 'string' || spec.message.trim() === '') {
      fail(
        name,
        `sqlConstraints '${key}' has no message.`,
        'Give users a message that says what went wrong and what to do.',
      );
    }
    const sqlConstraintName = sqlName(table, snakeCase(key), name);
    if ('unique' in spec) {
      if (spec.unique.length === 0)
        fail(
          name,
          `unique constraint '${key}' lists no fields.`,
          'List at least one stored field.',
        );
      const cols = spec.unique.map((field) => {
        const column = columns[field];
        if (!has(field) || column === undefined)
          fail(
            name,
            `unique constraint '${key}' refers to '${field}', which is not a stored field.`,
            'Use stored scalar or many2one fields.',
          );
        return column;
      });
      if (spec.where !== undefined && !isSql(spec.where))
        fail(
          name,
          `unique constraint '${key}' has a non-sql where.`,
          'Write it with the sql`...` tag.',
        );
      return {
        key,
        name: sqlConstraintName,
        kind: 'unique',
        fields: [...spec.unique],
        columns: cols,
        where: spec.where,
        message: spec.message,
      };
    }
    if (!isSql(spec.check))
      fail(
        name,
        `check constraint '${key}' is not a sql fragment.`,
        'Write it with the sql`...` tag, e.g. sql`debit = 0 OR credit = 0`.',
      );
    return {
      key,
      name: sqlConstraintName,
      kind: 'check',
      fields: [],
      columns: [],
      check: spec.check,
      message: spec.message,
    };
  });

  // --- indexes
  const indexes: ResolvedIndex<string>[] = (definition.indexes ?? []).map((spec) => {
    if (spec.fields.length === 0)
      fail(name, 'an index lists no fields.', 'List at least one stored field.');
    const cols = spec.fields.map((field) => {
      const column = columns[field];
      if (!has(field) || column === undefined)
        fail(
          name,
          `an index refers to '${field}', which is not a stored field.`,
          'Use stored scalar or many2one fields.',
        );
      return column;
    });
    if (spec.where !== undefined && !isSql(spec.where))
      fail(name, 'an index has a non-sql where.', 'Write it with the sql`...` tag.');
    return {
      name: sqlName(table, `${cols.join('_')}_idx`, name),
      fields: [...spec.fields],
      columns: cols,
      unique: spec.unique ?? false,
      where: spec.where,
      method: spec.method ?? 'btree',
    };
  });

  // --- business constraints
  const constraints: ResolvedConstraint[] = Object.entries(definition.constraints ?? {}).map(
    ([key, spec]) => {
      if (!FIELD_KEY.test(key))
        fail(
          name,
          `constraints key '${key}' is not camelCase.`,
          "Use keys like 'validityAfterOrderDate'.",
        );
      if (!Array.isArray(spec.depends) || spec.depends.length === 0)
        fail(
          name,
          `constraint '${key}' has no depends.`,
          'List the fields whose change triggers the check.',
        );
      if (typeof spec.check !== 'function')
        fail(
          name,
          `constraint '${key}' has no check function.`,
          'check(records) returns the failing records.',
        );
      if (typeof spec.message !== 'string' && typeof spec.message !== 'function')
        fail(
          name,
          `constraint '${key}' has no message.`,
          'Give a message string or a function of the failing records.',
        );
      return { key, ...spec };
    },
  );

  // --- multi-company consistency (RFC 0003 §7.4): a synthesized constraint over the checkCompany many2ones
  const checked = Object.entries(fields)
    .filter(
      ([, f]) => f.kind === 'many2one' && (f as { checkCompany?: boolean }).checkCompany === true,
    )
    .map(([k]) => k);
  if (checked.length > 0) {
    if (definition.companyScoped === undefined)
      fail(
        name,
        `checkCompany on '${checked[0]}' needs a companyScoped model.`,
        'Set companyScoped: { required: true } (or false) on the model, or drop checkCompany.',
      );
    if (constraints.some((c) => c.key === 'companyConsistency'))
      fail(
        name,
        "'companyConsistency' is a reserved constraint key.",
        'It is synthesized for checkCompany fields; rename yours.',
      );
    constraints.push({
      key: 'companyConsistency',
      depends: ['company', ...checked],
      check: companyConsistencyCheck(name, checked),
      message: 'Records must reference shared records or records of their own company.',
    });
  }

  // --- onchange handlers
  const onchange: Record<string, OnchangeFn> = {};
  for (const [key, fn] of Object.entries(definition.onchange ?? {})) {
    if (!has(key))
      fail(name, `onchange key '${key}' is not a field.`, `Fields: ${keys.join(', ')}.`);
    if (typeof fn !== 'function')
      fail(name, `onchange '${key}' is not a function.`, 'Pass (draft, env) => { ... }.');
    onchange[key] = fn;
  }

  const model = {
    name,
    table,
    label: definition.label ?? humanize(name),
    fields: Object.freeze(fields),
    columns: Object.freeze(columns),
    order: Object.freeze(order),
    recName,
    archivable: definition.archivable === true,
    companyScoped:
      definition.companyScoped === undefined
        ? undefined
        : Object.freeze({ ...definition.companyScoped }),
    tracking: Object.freeze(tracking),
    indexes: Object.freeze(indexes),
    sqlConstraints: Object.freeze(sqlConstraints),
    constraints: Object.freeze(constraints),
    onchange: Object.freeze(onchange),
    methods: Object.freeze(methods),
    declaredFields: Object.freeze(Object.keys(user)),
    definition: Object.freeze({ ...definition }) as unknown as ModelDefinition<
      FieldsRecord,
      MethodsRecord,
      boolean,
      CompanyScope | undefined
    >,
    describe(): ModelDescription {
      return describeModel(model as AnyModel);
    },
  };
  Object.freeze(model);
  models.add(model);
  void keys;
  return model as unknown as Model<N, ModelFields<N, Fs, A, C>, Ms & TransitionMethods<Fs>>;
}

// ----------------------------------------------------------------------------------------------------- describe

function describeField(
  field: Field,
  column: string | undefined,
  trackedByModel: boolean,
): FieldDescription {
  const base: FieldDescription = {
    kind: field.kind,
    label: field.label ?? '',
    help: field.help ?? null,
    column: column ?? null,
    pgType: field.pgType,
    required: field.required,
    readonly: field.readonly,
    store: field.store,
    computed: field.computed,
    compute:
      field.compute === undefined
        ? null
        : typeof field.compute === 'string'
          ? field.compute
          : 'inline',
    depends: [...field.depends],
    hasDefault: field.default !== undefined,
    index: field.index === undefined ? null : field.index === true ? 'btree' : field.index,
    copy: field.copy,
    // Tracked either on the field or in the model's `tracking` list.
    tracking: field.tracking || trackedByModel,
    translate: field.translate,
    sequence: field.sequence === undefined ? null : { ...field.sequence },
    deprecated: field.deprecated ?? null,
    groups: [...field.groups],
  };
  const extra: Record<string, unknown> = {};
  const x = field as unknown as Record<string, unknown>;
  for (const key of [
    'size',
    'scale',
    'precision',
    'currencyField',
    'uomField',
    'target',
    'inverseField',
    'relation',
    'ondelete',
    'checkCompany',
    'initial',
    'identity',
    'extensible',
    'sanitize',
  ] as const) {
    if (x[key] !== undefined) extra[key] = x[key];
  }
  if (field.kind === 'selection' || field.kind === 'state') {
    const selection = x['selection'];
    extra['selection'] =
      typeof selection === 'function'
        ? 'dynamic'
        : (selection as readonly (readonly [string, string])[]).map(([k, v]) => [k, v]);
  }
  if (field.kind === 'state') {
    const transitions = x['transitions'] as Readonly<
      Record<string, { readonly from: readonly string[]; readonly to: string }>
    >;
    extra['transitions'] = Object.fromEntries(
      Object.entries(transitions).map(([k, t]) => [
        k,
        {
          from: [...t.from],
          to: t.to,
          guarded: typeof (t as { guard?: unknown }).guard === 'function',
        },
      ]),
    );
  }
  return { ...base, ...extra };
}

function describeModel(model: AnyModel): ModelDescription {
  return {
    name: model.name,
    label: model.label,
    table: model.table,
    recName: model.recName,
    order: model.order.map((o) => ({ ...o })),
    archivable: model.archivable,
    companyScoped: model.companyScoped ?? null,
    tracking: [...model.tracking],
    fields: Object.fromEntries(
      Object.entries(model.fields).map(([key, field]) => [
        key,
        describeField(field, model.columns[key], model.tracking.includes(key)),
      ]),
    ),
    sqlConstraints: model.sqlConstraints.map((c) => ({
      key: c.key,
      name: c.name,
      kind: c.kind,
      fields: [...c.fields],
      message: c.message,
    })),
    indexes: model.indexes.map((i) => ({
      name: i.name,
      fields: [...i.fields],
      unique: i.unique,
      method: i.method,
      partial: i.where !== undefined,
    })),
    constraints: model.constraints.map((c) => ({
      key: c.key,
      depends: [...c.depends],
      message: typeof c.message === 'string' ? c.message : null,
    })),
    methods: Object.keys(model.methods),
    onchange: Object.keys(model.onchange),
  };
}
