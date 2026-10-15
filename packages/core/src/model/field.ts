/**
 * Field builders (`f.*`) and descriptors, RFC 0001 §7.3. A descriptor is frozen runtime metadata (what Kosh and
 * the migrator read) plus phantom types that carry the field's read / create / write faces.
 */

import type { Translations } from '@shutro/i18n';
import { type FieldGroups, type FieldGroupsInput, normalizeFieldGroups } from '@shutro/security';
import type { Env } from '../env/env.js';
import { InvalidFieldError, ShutroError } from '../errors.js';
import type { Decimal } from '../money/decimal.js';
import { toDecimal } from '../money/decimal.js';
import type { Money } from '../money/money.js';
import type { Quantity } from '../money/quantity.js';
import type { Id, X2ManyCommands } from './id.js';
import { related } from './related.js';

// ------------------------------------------------------------------------------------------------ shared types

/** Every field kind. */
export type FieldKind =
  | 'char'
  | 'text'
  | 'html'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'float'
  | 'decimal'
  | 'monetary'
  | 'quantity'
  | 'date'
  | 'datetime'
  | 'selection'
  | 'state'
  | 'json'
  | 'binary'
  | 'many2one'
  | 'one2many'
  | 'many2many';

/** Index kinds. `'trigram'` needs `pg_trgm`, `'brin'` suits append-only time series. */
export type IndexKind = true | 'unique' | 'trigram' | 'brin';

/** Batch compute: receives the recordset to fill (typed by the schema view, RFC 0002). */
export type ComputeFn = (records: never) => void | Promise<void>;
/** Makes a computed field writable: receives the records whose computed value was written. */
export type InverseFn = (records: never) => void | Promise<void>;

/** The normalized `sequence` option of a field (RFC 0012 §7.1). */
export interface SequenceFieldOptions {
  readonly code: string;
  /** As given on the field; the definition is authoritative. */
  readonly gapless: boolean | undefined;
  readonly on: 'create' | 'manual';
  readonly dateField: string | undefined;
}

/** Phantom flags that decide a field's faces (RFC 0001 §7.3). */
export interface FieldFlags {
  readonly required: boolean;
  /** Excluded from create and write: explicit `readonly`, a sequence, a compute without inverse, or a state. */
  readonly readonly: boolean;
  readonly computed: boolean;
  readonly inverse: boolean;
  readonly hasDefault: boolean;
  readonly sequence: boolean;
  /** The method name when `compute` is a string (phantom; drives the methods check in `defineModel`). */
  readonly computeName?: string | undefined;
  /** Persisted as a column (phantom; `undefined` means not stored). */
  readonly store?: boolean | undefined;
}

/** Phantom read/write types and flags of a field. */
export interface FieldTypes<R, W, Fl extends FieldFlags> {
  readonly read: R;
  readonly write: W;
  readonly flags: Fl;
}

/** Runtime metadata common to every field. */
export interface FieldBase<K extends FieldKind, R, W, Fl extends FieldFlags> {
  readonly kind: K;
  /** PostgreSQL column type. `numeric` for named precisions until the registry resolves them. */
  readonly pgType: string;
  readonly label: string | undefined;
  readonly help: string | undefined;
  readonly required: boolean;
  readonly readonly: boolean;
  /** Persisted as a column (`false` for non-stored computes and x2many relations). */
  readonly store: boolean;
  readonly computed: boolean;
  readonly compute: ComputeFn | string | undefined;
  readonly inverse: InverseFn | undefined;
  readonly depends: readonly string[];
  /** A value, or `(env) => value`. */
  readonly default: unknown;
  readonly index: IndexKind | undefined;
  readonly copy: boolean;
  readonly tracking: boolean;
  /** Column-name override. */
  readonly column: string | undefined;
  readonly groups: FieldGroups;
  readonly deprecated: string | undefined;
  readonly sequence: SequenceFieldOptions | undefined;
  readonly translate: boolean;
  /** Stored encrypted with the application keys (RFC 0014 §7.6); char / text only. */
  readonly encrypted: boolean;
  /** One value per company (a `jsonb` map by company id); reads and writes see the current company's value. */
  readonly companyDependent: boolean;
  /** How filters on this non-stored computed field translate to stored fields. */
  readonly search: SearchFn | undefined;
  /** The column type of one value (`pgType` is `jsonb` for company-dependent fields). */
  readonly valueType: string;
  /** Phantom. Never present at runtime. */
  readonly '~types'?: FieldTypes<R, W, Fl>;
}

/** Options accepted by every builder. `V` is the field's write type. */
export interface CommonOptions<V> {
  readonly label?: string;
  readonly help?: string;
  readonly required?: boolean;
  readonly readonly?: boolean;
  readonly default?: V | ((env: Env) => V);
  readonly index?: IndexKind;
  readonly copy?: boolean;
  readonly tracking?: boolean;
  readonly column?: string;
  /** Groups that may read / write the field (RFC 0014 §7.4): an array for both, or { read, write }. */
  readonly groups?: FieldGroupsInput;
  readonly deprecated?: string;
  /** Persist a computed field (recomputed in batches before commit). */
  readonly store?: boolean;
  /** Dotted paths the compute reads. Checked against the schema view (RFC 0002). */
  readonly depends?: readonly string[];
  /** Inline batch function, or the key of a model method shared by several fields. */
  readonly compute?: ComputeFn | string;
  readonly inverse?: InverseFn;
  /**
   * One value per company (Odoo `company_dependent`): reads, writes, filters and sorts use the current company's
   * value, falling back to `default`. Not required, stored, computed, translated or encrypted.
   */
  readonly companyDependent?: boolean;
  /**
   * Makes a non-stored computed field searchable (Odoo `search=`): returns the domain on stored fields that matches
   * `operator` and `value` (`'eq'` for a plain value). Called while the search is compiled.
   * @example search: (op, value) => (op === 'eq' && value === true ? { price: { gt: '100' } } : { price: { lte: '100' } })
   */
  readonly search?: SearchFn;
}

/** Translates a filter on a non-stored computed field into a domain on stored fields. */
export type SearchFn = (operator: string, value: unknown) => Readonly<Record<string, unknown>>;

/** Options of text-like fields. */
export interface TextOptions extends CommonOptions<string> {
  /** Store per-language values as JSONB (RFC 0001 §7.3). */
  readonly translate?: boolean;
  /** Encrypt at rest with the application's keys (RFC 0014 §7.6). Not searchable, not translatable. */
  readonly encrypted?: boolean;
}
/** Options of `f.char`. */
export interface CharOptions extends TextOptions {
  /** `varchar(size)`; unlimited `text` when omitted. */
  readonly size?: number;
}
/** Options of `f.html`. */
export interface HtmlOptions extends TextOptions {
  /** Sanitize on write (default `true`). */
  readonly sanitize?: boolean;
}
/** Options of `f.decimal`. */
export interface DecimalOptions extends CommonOptions<Decimal | string> {
  /** Digits after the point, or a named precision such as `'product.price'` (RFC 0006 §7.5). */
  readonly scale: number | string;
  /** Total digits (default 32). Only with a numeric `scale`. */
  readonly precision?: number;
}
/** Options of `f.monetary`. */
export interface MonetaryOptions extends CommonOptions<Decimal | string> {
  /** The sibling `many2one('res.currency')` field. Checked by `defineModel`. */
  readonly currency: string;
}
/** Options of `f.quantity`. */
export interface QuantityOptions extends CommonOptions<Decimal | string> {
  /** The sibling `many2one('uom.uom')` field. */
  readonly uom: string;
  readonly scale?: number | string;
}
/** Options of `f.selection`. */
export interface SelectionOptions<V extends string> extends CommonOptions<V> {
  /** Let other modules add values (RFC 0002 S5). Consumers must then handle unknown options. */
  readonly extensible?: boolean;
}
/** Events of a state: run once per batch when records enter / leave it (RFC 0010 §7.2). */
export interface StateHooks {
  readonly onEnter?: (records: never) => unknown;
  readonly onExit?: (records: never) => unknown;
}
/** A state with a label and optional events. */
export interface StateSpec extends StateHooks {
  readonly label: string;
}
/** A state transition: source states, target, optional guard and events (RFC 0010 §7.1). */
export interface Transition<S extends string> {
  readonly from: readonly S[];
  readonly to: S;
  /** Returns the records that may not transition (a recordset, records or ids); empty means go. */
  readonly guard?: (records: never) => unknown;
  /** User-facing message when the guard rejects records. */
  readonly message?: string;
  readonly before?: (records: never) => unknown;
  readonly after?: (records: never) => unknown;
  /** A feature permission (`definePermission`) the user needs to run this transition (RFC 0014 §7.9). */
  readonly requires?: string;
}
/** Options of `f.state`. */
export interface StateOptions<
  S extends Record<string, string | StateSpec>,
  T extends Record<string, Transition<keyof S & string>>,
> {
  readonly states: S;
  readonly initial: keyof S & string;
  readonly transitions: T;
  readonly label?: string;
  readonly help?: string;
  readonly tracking?: boolean;
  readonly extensible?: boolean;
}
/** Options of `f.json`. */
export interface JsonOptions<V> extends CommonOptions<V> {}
/** Options of `f.binary`. */
export interface BinaryOptions extends CommonOptions<Uint8Array> {}
/** `ON DELETE` behaviour of a many2one. */
export type OnDelete = 'restrict' | 'cascade' | 'set null';
/** Options of `f.many2one`. */
export interface Many2oneOptions<T extends string> extends CommonOptions<Id<T>> {
  readonly ondelete?: OnDelete;
  /** The target must be shared or in the same company as the record (RFC 0003 §7.4). The model must be companyScoped. */
  readonly checkCompany?: boolean;
  /**
   * `false`: no database foreign key (e.g. the target is partitioned, RFC 0015). The ORM checks that written ids
   * exist; deleting the target is not restricted by the database, so `ondelete` cannot be set.
   */
  readonly foreignKey?: boolean;
}
/** Options of x2many fields (never stored as a column). */
export interface X2ManyOptions<T extends string>
  extends Omit<CommonOptions<X2ManyCommands<T>>, 'store' | 'index' | 'tracking'> {}
/** Options of `f.many2many`. */
export interface Many2manyOptions<T extends string> extends X2ManyOptions<T> {
  /** Junction table name; derived deterministically when omitted. */
  readonly relation?: string;
}

/** The descriptor of a field whose faces are plain values. */
export interface ScalarField<K extends FieldKind, R, W, Fl extends FieldFlags>
  extends FieldBase<K, R, W, Fl> {}
/** The write type of a text field: a map of translations too when `translate: true` (RFC 0011). */
export type TextWrite<O> = O extends { readonly translate: true } ? string | Translations : string;
/** `f.char` descriptor. */
export interface CharField<Fl extends FieldFlags, W extends string | Translations = string>
  extends FieldBase<'char', string, W, Fl> {
  readonly size: number | undefined;
}
/** `f.float` descriptor. */
export interface FloatField<Fl extends FieldFlags> extends FieldBase<'float', number, number, Fl> {
  readonly discouraged: string;
}
/** `f.decimal` descriptor. */
export interface DecimalField<Fl extends FieldFlags>
  extends FieldBase<'decimal', Decimal, Decimal | string, Fl> {
  readonly scale: number | string;
  readonly precision: number | undefined;
}
/** `f.monetary` descriptor. */
export interface MonetaryField<C extends string, Fl extends FieldFlags>
  extends FieldBase<'monetary', Money, Decimal | string | Money, Fl> {
  readonly currencyField: C;
}
/** `f.quantity` descriptor. */
export interface QuantityField<U extends string, Fl extends FieldFlags>
  extends FieldBase<'quantity', Quantity, Decimal | string | Quantity, Fl> {
  readonly uomField: U;
  readonly scale: number | string | undefined;
}
/** `f.selection` descriptor. */
export interface SelectionField<V extends string, Fl extends FieldFlags>
  extends FieldBase<'selection', V, V, Fl> {
  /** `[value, label]` pairs, or the function of a dynamic selection. */
  readonly selection: readonly (readonly [string, string])[] | (() => readonly string[]);
  readonly extensible: boolean;
}
/** `f.state` descriptor. Never writable: values change through transitions. */
export interface StateField<
  S extends string,
  T extends Record<string, Transition<S>>,
  Fl extends FieldFlags,
> extends FieldBase<'state', S, S, Fl> {
  readonly selection: readonly (readonly [string, string])[];
  readonly initial: S;
  readonly transitions: T;
  /** Events per state (RFC 0010 §7.2). */
  readonly stateHooks: Readonly<Record<string, StateHooks>>;
  readonly extensible: boolean;
}
/** `f.json` descriptor. */
export interface JsonField<V, Fl extends FieldFlags> extends FieldBase<'json', V, V, Fl> {}
/** `f.binary` descriptor. Never prefetched. */
export interface BinaryField<Fl extends FieldFlags>
  extends FieldBase<'binary', Uint8Array, Uint8Array, Fl> {
  readonly prefetch: false;
}
/** `f.many2one` descriptor. The read face is the id until recordsets exist (RFC 0004). */
export interface Many2oneField<T extends string, Fl extends FieldFlags>
  extends FieldBase<'many2one', { readonly id: Id<T> }, Id<T>, Fl> {
  readonly target: T;
  readonly ondelete: OnDelete;
  readonly checkCompany: boolean;
  /** `false` when the column has no database foreign key. */
  readonly foreignKey: boolean;
}
/** `f.one2many` descriptor. */
export interface One2manyField<T extends string, Fl extends FieldFlags>
  extends FieldBase<'one2many', { readonly model: T }, X2ManyCommands<T>, Fl> {
  readonly target: T;
  /** The `many2one` on the target that points back here. */
  readonly inverseField: string;
}
/** `f.many2many` descriptor. */
export interface Many2manyField<T extends string, Fl extends FieldFlags>
  extends FieldBase<'many2many', { readonly model: T }, X2ManyCommands<T>, Fl> {
  readonly target: T;
  readonly relation: string | undefined;
}

/** Any field descriptor. */
export type Field = FieldBase<FieldKind, unknown, unknown, FieldFlags>;

// ---------------------------------------------------------------------------------------------- flag inference

/** Any non-nullish value (what `{}` means in a conditional, spelled out). */
type Defined = NonNullable<unknown>;
/** The empty options object: the default when a builder is called without arguments. */
type NoOptions = Record<never, never>;

type IsTrue<O, K extends string> = O extends Record<K, true> ? true : false;
type Present<O, K extends string> = O extends Record<K, Defined | null> ? true : false;

/**
 * Resolves a mapped object into a fresh structural type. Without it, two `FlagsOf` instantiations with the same
 * result but different option objects are not *identical* to TypeScript (only mutually assignable), which breaks
 * `toEqualTypeOf` between generated views (`F.*`, RFC 0002 §7.7) and declared fields.
 */
type Resolved<T> = { [K in keyof T]: T[K] };

/** Derives the phantom flags from a builder's options and its kind defaults. */
export type FlagsOf<
  O,
  D extends { required?: true; readonly?: true; hasDefault?: true } = NoOptions,
> = Resolved<RawFlagsOf<O, D>>;

type RawFlagsOf<O, D extends { required?: true; readonly?: true; hasDefault?: true }> = {
  readonly required: IsTrue<O, 'required'> extends true
    ? true
    : D extends { required: true }
      ? true
      : false;
  readonly computed: Present<O, 'compute'>;
  readonly inverse: Present<O, 'inverse'>;
  readonly sequence: Present<O, 'sequence'>;
  readonly computeName: O extends { compute: infer Cm extends string } ? Cm : undefined;
  readonly store: Present<O, 'compute'> extends true ? IsTrue<O, 'store'> : true;
  readonly hasDefault: Present<O, 'default'> extends true
    ? true
    : D extends { hasDefault: true }
      ? true
      : false;
  readonly readonly: IsTrue<O, 'readonly'> extends true
    ? true
    : Present<O, 'sequence'> extends true
      ? true
      : Present<O, 'compute'> extends true
        ? Present<O, 'inverse'> extends true
          ? false
          : true
        : D extends { readonly: true }
          ? true
          : false;
};

/** Rejects option keys that the builder doesn't know (`requird: true`). */
type Exact<O, Allowed> = { readonly [K in Exclude<keyof O, keyof Allowed>]: never };
/** `depends` / `inverse` / `store` only make sense with `compute`. */
type ComputeRules<O> = O extends { compute: Defined }
  ? unknown
  : { readonly depends?: never; readonly inverse?: never; readonly store?: never };
/** A required many2one can't be set to null on delete. */
type OnDeleteRules<O> = O extends { required: true }
  ? { readonly ondelete?: 'restrict' | 'cascade' }
  : unknown;

type SequenceOption = {
  readonly sequence?:
    | string
    | {
        readonly code: string;
        /** Must agree with the definition when given. */
        readonly gapless?: boolean;
        /** `create` (default) fills the number on creation; `manual` stores '/' until assignNumber() (RFC 0012 §7.4). */
        readonly on?: 'create' | 'manual';
        /** The field whose value picks the period (and the placeholders); defaults to the environment's today. */
        readonly dateField?: string;
      };
};
type CharOpts = CharOptions & SequenceOption;

// ------------------------------------------------------------------------------------------------ validation

/** SQL-level names (columns, relation tables): snake_case. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Field keys in TypeScript: camelCase (RFC 0001 §7.5); the model maps them to snake_case columns. */
const FIELD_KEY = /^[a-z][a-zA-Z0-9]*$/;
const MODEL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const created = new WeakSet<object>();

/** True when `value` is a field descriptor produced by `f.*`. */
export function isField(value: unknown): value is Field {
  return typeof value === 'object' && value !== null && created.has(value);
}

function assertModelName(name: string, what: string): void {
  if (typeof name !== 'string' || !MODEL_NAME.test(name)) {
    throw new InvalidFieldError(
      `${JSON.stringify(name)} is not a valid model name for ${what}.`,
      "Model names are dotted lower-case identifiers such as 'res.partner' or 'sale.order.line'.",
    );
  }
}

function assertIdentifier(name: string, what: string): void {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new InvalidFieldError(
      `${JSON.stringify(name)} is not a valid ${what}.`,
      'Use lower-case snake_case (a-z, 0-9, _), starting with a letter or underscore.',
    );
  }
}

function assertHook(where: string, name: string, fn: unknown): void {
  if (fn !== undefined && typeof fn !== 'function') {
    throw new InvalidFieldError(
      `${where}: ${name} is not a function.`,
      `Pass ${name}: (records) => { ... }.`,
    );
  }
}

function assertFieldKey(name: string, what: string): void {
  if (typeof name !== 'string' || !FIELD_KEY.test(name)) {
    throw new InvalidFieldError(
      `${JSON.stringify(name)} is not a valid ${what}.`,
      "Refer to the sibling field by its TypeScript key in camelCase, e.g. 'currency' or 'weightUom'.",
    );
  }
}

function assertPositiveInt(value: unknown, what: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new InvalidFieldError(
      `${what} must be a positive integer, got ${JSON.stringify(value)}.`,
      `Set ${what} to 1 or more.`,
    );
  }
}

function assertDecimalDefault(value: unknown, kind: string): void {
  if (value === undefined || typeof value === 'function') return;
  try {
    toDecimal(value as never);
  } catch (e) {
    const hint = e instanceof ShutroError ? e.hint : 'Use a decimal string or a Decimal.';
    throw new InvalidFieldError(`The default of this ${kind} field is not an exact decimal.`, hint);
  }
}

interface Normalized {
  readonly search: SearchFn | undefined;
  readonly companyDependent: boolean;
  readonly label: string | undefined;
  readonly help: string | undefined;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly store: boolean;
  readonly computed: boolean;
  readonly compute: ComputeFn | string | undefined;
  readonly inverse: InverseFn | undefined;
  readonly depends: readonly string[];
  readonly default: unknown;
  readonly index: IndexKind | undefined;
  readonly copy: boolean;
  readonly tracking: boolean;
  readonly column: string | undefined;
  readonly groups: FieldGroups;
  readonly deprecated: string | undefined;
  readonly sequence: SequenceFieldOptions | undefined;
  readonly translate: boolean;
  readonly encrypted: boolean;
}

interface Defaults {
  readonly required?: boolean;
  readonly readonly?: boolean;
  readonly default?: unknown;
  /** x2many relations are never columns. */
  readonly storable?: boolean;
}

/** Options as builders pass them: every key optional and possibly `undefined`. */
type LooseOptions = {
  readonly [K in keyof (CommonOptions<unknown> &
    SequenceOption & { translate?: boolean; encrypted?: boolean })]?:
    | (CommonOptions<unknown> & SequenceOption & { translate?: boolean; encrypted?: boolean })[K]
    | undefined;
};

function normalize(options: LooseOptions, defaults: Defaults = {}): Normalized {
  const storable = defaults.storable ?? true;
  if (!storable && options.store !== undefined) {
    throw new InvalidFieldError(
      'A one2many or many2many field cannot be stored.',
      'Remove `store`: x2many relations are read through the inverse field or the junction table.',
    );
  }
  const compute = options.compute;
  if (
    compute !== undefined &&
    (typeof compute === 'string' ? compute.trim() === '' : typeof compute !== 'function')
  ) {
    throw new InvalidFieldError(
      '`compute` must be a function or the name of a model method.',
      "Pass compute(records) { ... } or compute: 'computeAmounts'.",
    );
  }
  if (compute === undefined && (options.depends !== undefined || options.inverse !== undefined)) {
    throw new InvalidFieldError(
      '`depends` and `inverse` need a `compute`.',
      'Add the compute function, or remove depends/inverse.',
    );
  }
  if (options.column !== undefined) assertIdentifier(options.column, 'column name');
  const sequence =
    options.sequence === undefined
      ? undefined
      : typeof options.sequence === 'string'
        ? {
            code: options.sequence,
            gapless: undefined,
            on: 'create' as const,
            dateField: undefined,
          }
        : {
            code: options.sequence.code,
            gapless: options.sequence.gapless,
            on: options.sequence.on ?? ('create' as const),
            dateField: options.sequence.dateField,
          };
  if (sequence !== undefined && sequence.on !== 'create' && sequence.on !== 'manual') {
    throw new InvalidFieldError(
      `sequence.on ${JSON.stringify(sequence.on)} is unknown.`,
      "Use on: 'create' (default) or on: 'manual'.",
    );
  }
  if (sequence?.dateField !== undefined) assertFieldKey(sequence.dateField, 'sequence.dateField');
  if (sequence !== undefined && sequence.code.trim() === '') {
    throw new InvalidFieldError(
      'A sequence needs a code.',
      "Pass sequence: 'sale.order' or { code: 'account.move', gapless: true }.",
    );
  }
  const computed = compute !== undefined;
  if (
    options.search !== undefined &&
    (!computed || options.store === true || typeof options.search !== 'function')
  )
    throw new InvalidFieldError(
      '`search` applies to non-stored computed fields.',
      'Stored fields are searched directly; give non-stored computes search(operator, value) => domain.',
    );
  if (
    options.companyDependent === true &&
    (options.required === true ||
      computed ||
      options.translate === true ||
      options.encrypted === true ||
      sequence !== undefined)
  )
    throw new InvalidFieldError(
      'A company-dependent field cannot be required, computed, translated, encrypted or numbered.',
      'Give it a default instead of required; companies without a value read the default.',
    );
  return {
    label: options.label,
    help: options.help,
    required: options.required ?? defaults.required ?? false,
    readonly:
      options.readonly ??
      (sequence !== undefined ||
        (computed && options.inverse === undefined) ||
        (defaults.readonly ?? false)),
    store: computed ? (options.store ?? false) : storable,
    computed,
    compute,
    inverse: options.inverse,
    depends: Object.freeze([...(options.depends ?? [])]),
    default: options.default === undefined ? defaults.default : options.default,
    index: options.index,
    copy: options.copy ?? true,
    tracking: options.tracking ?? false,
    column: options.column,
    groups: normalizeFieldGroups(options.groups),
    deprecated: options.deprecated,
    sequence,
    translate: options.translate ?? false,
    encrypted: options.encrypted ?? false,
    companyDependent: options.companyDependent ?? false,
    search: options.search,
  };
}

const COMPANY_DEPENDENT_KINDS = new Set([
  'char',
  'text',
  'html',
  'integer',
  'float',
  'decimal',
  'boolean',
  'date',
  'selection',
  'many2one',
]);

function make<F extends object>(input: F): F & { readonly valueType: string } {
  const d = input as F & {
    kind?: string;
    pgType?: string;
    companyDependent?: boolean;
    valueType?: string;
  };
  let descriptor: F = input;
  if (d.valueType === undefined && d.pgType !== undefined) {
    if (d.companyDependent === true && !COMPANY_DEPENDENT_KINDS.has(d.kind ?? ''))
      throw new InvalidFieldError(
        `A ${d.kind} field cannot be company-dependent.`,
        'Company-dependent fields are char, text, html, integer, float, decimal, boolean, date, selection or many2one.',
      );
    descriptor = {
      ...input,
      valueType: d.kind === 'many2one' ? 'bigint' : d.pgType,
      pgType: d.companyDependent === true ? 'jsonb' : d.pgType,
    };
  }
  const frozen = Object.freeze(descriptor);
  created.add(frozen);
  return frozen as F & { readonly valueType: string };
}

function textLike<K extends 'char' | 'text' | 'html'>(
  kind: K,
  options: TextOptions & SequenceOption,
  pgType: string,
): FieldBase<K, string, string, FieldFlags> {
  const base = normalize(options);
  if (base.translate && base.encrypted)
    throw new InvalidFieldError('A field cannot be both translate and encrypted.', 'Pick one.');
  return make({
    kind,
    pgType: base.translate ? 'jsonb' : base.encrypted ? 'text' : pgType,
    ...base,
  });
}

// -------------------------------------------------------------------------------------------------- builders

/** The field builders. See each method for its options; every descriptor is frozen metadata. */
export const f = {
  /** Short text. `size` gives `varchar(size)`, otherwise `text`. */
  char<const O extends CharOpts = NoOptions>(
    options?: O & Exact<O, CharOpts> & ComputeRules<O>,
  ): CharField<FlagsOf<O>, TextWrite<O>> {
    const opts: CharOpts = options ?? {};
    if (opts.size !== undefined) assertPositiveInt(opts.size, 'size');
    const base = textLike('char', opts, opts.size === undefined ? 'text' : `varchar(${opts.size})`);
    return make({ ...base, size: opts.size }) as CharField<FlagsOf<O>, TextWrite<O>>;
  },

  /** Long text. */
  text<const O extends TextOptions = NoOptions>(
    options?: O & Exact<O, TextOptions> & ComputeRules<O>,
  ): ScalarField<'text', string, TextWrite<O>, FlagsOf<O>> {
    return textLike('text', options ?? {}, 'text') as ScalarField<
      'text',
      string,
      TextWrite<O>,
      FlagsOf<O>
    >;
  },

  /** HTML, sanitized on write unless `sanitize: false`. */
  html<const O extends HtmlOptions = NoOptions>(
    options?: O & Exact<O, HtmlOptions> & ComputeRules<O>,
  ): ScalarField<'html', string, TextWrite<O>, FlagsOf<O>> & { readonly sanitize: boolean } {
    const opts: HtmlOptions = options ?? {};
    const base = textLike('html', opts, 'text');
    return make({ ...base, sanitize: opts.sanitize ?? true }) as ScalarField<
      'html',
      string,
      TextWrite<O>,
      FlagsOf<O>
    > & { readonly sanitize: boolean };
  },

  /** Never nullable; defaults to `false`. */
  boolean<const O extends CommonOptions<boolean> = NoOptions>(
    options?: O & Exact<O, CommonOptions<boolean>> & ComputeRules<O>,
  ): ScalarField<'boolean', boolean, boolean, FlagsOf<O, { required: true; hasDefault: true }>> {
    const base = normalize(options ?? {}, { required: true, default: false });
    return make({ kind: 'boolean', pgType: 'boolean', ...base, required: true }) as ScalarField<
      'boolean',
      boolean,
      boolean,
      FlagsOf<O, { required: true; hasDefault: true }>
    >;
  },

  /** 32-bit integer. For counts and sequences, never for money or quantities. */
  integer<const O extends CommonOptions<number> = NoOptions>(
    options?: O & Exact<O, CommonOptions<number>> & ComputeRules<O>,
  ): ScalarField<'integer', number, number, FlagsOf<O>> {
    return make({ kind: 'integer', pgType: 'integer', ...normalize(options ?? {}) }) as ScalarField<
      'integer',
      number,
      number,
      FlagsOf<O>
    >;
  },

  /** 64-bit integer. Read as a safe `number` (the driver rejects larger values); write `bigint` or `number`. */
  bigint<const O extends CommonOptions<bigint | number> = NoOptions>(
    options?: O & Exact<O, CommonOptions<bigint | number>> & ComputeRules<O>,
  ): ScalarField<'bigint', number, bigint | number, FlagsOf<O>> {
    return make({ kind: 'bigint', pgType: 'bigint', ...normalize(options ?? {}) }) as ScalarField<
      'bigint',
      number,
      bigint | number,
      FlagsOf<O>
    >;
  },

  /** Binary floating point. **Discouraged** for business values: use `decimal`, `monetary` or `quantity`. */
  float<const O extends CommonOptions<number> = NoOptions>(
    options?: O & Exact<O, CommonOptions<number>> & ComputeRules<O>,
  ): FloatField<FlagsOf<O>> {
    return make({
      kind: 'float',
      pgType: 'double precision',
      ...normalize(options ?? {}),
      discouraged:
        'float is binary floating point. Use decimal, monetary or quantity for business values (Decimal in code, numeric in PostgreSQL).',
    }) as FloatField<FlagsOf<O>>;
  },

  /** Exact decimal: `numeric(precision, scale)`, or `numeric` with a named precision resolved by the registry. */
  decimal<const O extends DecimalOptions>(
    options: O & Exact<O, DecimalOptions> & ComputeRules<O>,
  ): DecimalField<FlagsOf<O>> {
    const { scale, precision } = options;
    if (typeof scale === 'number') {
      if (!Number.isInteger(scale) || scale < 0) {
        throw new InvalidFieldError(
          `scale must be a non-negative integer or a named precision, got ${JSON.stringify(scale)}.`,
          "Use e.g. scale: 2, or scale: 'product.price'.",
        );
      }
      if (precision !== undefined && (!Number.isInteger(precision) || precision <= scale)) {
        throw new InvalidFieldError(
          `precision (${String(precision)}) must be an integer greater than scale (${scale}).`,
          'Precision is the total number of digits, scale the digits after the point.',
        );
      }
    } else if (typeof scale !== 'string' || scale.trim() === '') {
      throw new InvalidFieldError(
        'A named precision must be a non-empty string.',
        "Use e.g. scale: 'product.price', declared by a module's `precisions`.",
      );
    }
    assertDecimalDefault(options.default, 'decimal');
    const pgType = typeof scale === 'number' ? `numeric(${precision ?? 32}, ${scale})` : 'numeric';
    return make({
      kind: 'decimal',
      pgType,
      ...normalize(options),
      scale,
      precision,
    }) as DecimalField<FlagsOf<O>>;
  },

  /** An amount in the currency of the sibling `currency` field (read as `Money`, RFC 0006). */
  monetary<const O extends MonetaryOptions>(
    options: O & Exact<O, MonetaryOptions> & ComputeRules<O>,
  ): MonetaryField<O['currency'], FlagsOf<O>> {
    assertFieldKey(options.currency, 'currency field name');
    assertDecimalDefault(options.default, 'monetary');
    return make({
      kind: 'monetary',
      pgType: 'numeric',
      ...normalize(options),
      currencyField: options.currency,
    }) as MonetaryField<O['currency'], FlagsOf<O>>;
  },

  /** A quantity in the unit of the sibling `uom` field (read as `Quantity`). */
  quantity<const O extends QuantityOptions>(
    options: O & Exact<O, QuantityOptions> & ComputeRules<O>,
  ): QuantityField<O['uom'], FlagsOf<O>> {
    assertFieldKey(options.uom, 'uom field name');
    assertDecimalDefault(options.default, 'quantity');
    return make({
      kind: 'quantity',
      pgType: 'numeric',
      ...normalize(options),
      uomField: options.uom,
      scale: options.scale,
    }) as QuantityField<O['uom'], FlagsOf<O>>;
  },

  /** A calendar date (`'YYYY-MM-DD'`), never a JS `Date` (RFC 0001 W7). */
  date<const O extends CommonOptions<string> = NoOptions>(
    options?: O & Exact<O, CommonOptions<string>> & ComputeRules<O>,
  ): ScalarField<'date', string, string, FlagsOf<O>> {
    return make({ kind: 'date', pgType: 'date', ...normalize(options ?? {}) }) as ScalarField<
      'date',
      string,
      string,
      FlagsOf<O>
    >;
  },

  /** An instant (`timestamptz`), always UTC in storage. */
  datetime<const O extends CommonOptions<Date> = NoOptions>(
    options?: O & Exact<O, CommonOptions<Date>> & ComputeRules<O>,
  ): ScalarField<'datetime', Date, Date, FlagsOf<O>> {
    return make({
      kind: 'datetime',
      pgType: 'timestamptz',
      ...normalize(options ?? {}),
    }) as ScalarField<'datetime', Date, Date, FlagsOf<O>>;
  },

  /**
   * A closed set of values. The map form gives labels and a typed union; the function form is dynamic (`string`).
   * @example f.selection({ consu: 'Goods', service: 'Service' }, { required: true, default: 'consu' })
   */
  selection: (<
    const S extends Record<string, string>,
    const O extends SelectionOptions<keyof S & string> = NoOptions,
  >(
    values: S | (() => readonly string[]),
    options?: O & Exact<O, SelectionOptions<keyof S & string>> & ComputeRules<O>,
  ): SelectionField<keyof S & string, FlagsOf<O>> => {
    let selection: SelectionField<string, FieldFlags>['selection'];
    if (typeof values === 'function') {
      selection = values;
    } else {
      const entries = Object.entries(values);
      if (entries.length === 0)
        throw new InvalidFieldError(
          'A selection needs at least one value.',
          "Pass a map such as { draft: 'Draft', done: 'Done' }.",
        );
      for (const [key] of entries) assertIdentifier(key, 'selection value');
      selection = Object.freeze(entries.map(([k, v]) => Object.freeze([k, v] as const)));
    }
    const opts: SelectionOptions<string> = options ?? {};
    return make({
      kind: 'selection',
      pgType: 'text',
      ...normalize(opts),
      selection,
      extensible: opts.extensible ?? false,
    }) as SelectionField<keyof S & string, FlagsOf<O>>;
  }) as {
    <
      const S extends Record<string, string>,
      const O extends SelectionOptions<keyof S & string> = NoOptions,
    >(
      values: S,
      options?: O & Exact<O, SelectionOptions<keyof S & string>> & ComputeRules<O>,
    ): SelectionField<keyof S & string, FlagsOf<O>>;
    <const O extends SelectionOptions<string> = NoOptions>(
      values: () => readonly string[],
      options?: O & Exact<O, SelectionOptions<string>> & ComputeRules<O>,
    ): SelectionField<string, FlagsOf<O>>;
  },

  /**
   * A selection with declared transitions (RFC 0001 §7.3). Readonly: values change only through transitions.
   * @example f.state({ states: { draft: 'Quotation', sale: 'Sales Order' }, initial: 'draft', transitions: { confirm: { from: ['draft'], to: 'sale' } } })
   */
  state<
    const S extends Record<string, string | StateSpec>,
    const T extends Record<string, Transition<keyof S & string>>,
  >(
    options: StateOptions<S, T>,
  ): StateField<
    keyof S & string,
    T,
    {
      required: true;
      readonly: true;
      computed: false;
      inverse: false;
      hasDefault: true;
      sequence: false;
    }
  > {
    const states = Object.entries(options.states);
    if (states.length === 0)
      throw new InvalidFieldError(
        'A state field needs at least one state.',
        'Pass states: { draft: "Draft", ... }.',
      );
    const names = new Set<string>();
    const stateHooks: Record<string, StateHooks> = {};
    for (const [key, spec] of states) {
      assertIdentifier(key, 'state name');
      names.add(key);
      if (typeof spec !== 'string') {
        if (typeof spec?.label !== 'string')
          throw new InvalidFieldError(
            `State '${key}' has no label.`,
            "Use 'Label' or { label: 'Label', onEnter, onExit }.",
          );
        assertHook(`State '${key}'`, 'onEnter', spec.onEnter);
        assertHook(`State '${key}'`, 'onExit', spec.onExit);
        if (spec.onEnter !== undefined || spec.onExit !== undefined)
          stateHooks[key] = {
            ...(spec.onEnter === undefined ? {} : { onEnter: spec.onEnter }),
            ...(spec.onExit === undefined ? {} : { onExit: spec.onExit }),
          };
      }
    }
    if (!names.has(options.initial)) {
      throw new InvalidFieldError(
        `The initial state ${JSON.stringify(options.initial)} is not one of the states.`,
        `Use one of: ${[...names].join(', ')}.`,
      );
    }
    for (const [name, t] of Object.entries<Transition<string>>(options.transitions)) {
      assertIdentifier(name, 'transition name');
      if (!Array.isArray(t.from) || t.from.length === 0) {
        throw new InvalidFieldError(
          `Transition '${name}' has no source states.`,
          "Give at least one state in `from`, e.g. { from: ['draft'], to: 'sale' }.",
        );
      }
      for (const s of [...t.from, t.to]) {
        if (!names.has(s))
          throw new InvalidFieldError(
            `Transition '${name}' refers to unknown state ${JSON.stringify(s)}.`,
            `Use one of: ${[...names].join(', ')}.`,
          );
      }
      assertHook(`Transition '${name}'`, 'guard', t.guard);
      assertHook(`Transition '${name}'`, 'before', t.before);
      assertHook(`Transition '${name}'`, 'after', t.after);
      if (t.message !== undefined && typeof t.message !== 'string')
        throw new InvalidFieldError(
          `Transition '${name}': message is not a string.`,
          'Give the message shown when the guard rejects records.',
        );
    }
    const base = normalize(
      {
        label: options.label,
        help: options.help,
        tracking: options.tracking ?? true, // state changes are audited by default (RFC 0013)
        default: options.initial,
      },
      { required: true, readonly: true },
    );
    return make({
      kind: 'state',
      pgType: 'text',
      ...base,
      selection: Object.freeze(
        states.map(([k, v]) => Object.freeze([k, typeof v === 'string' ? v : v.label] as const)),
      ),
      initial: options.initial,
      transitions: Object.freeze(options.transitions),
      stateHooks: Object.freeze(stateHooks),
      extensible: options.extensible ?? false,
    }) as StateField<
      keyof S & string,
      T,
      {
        required: true;
        readonly: true;
        computed: false;
        inverse: false;
        hasDefault: true;
        sequence: false;
      }
    >;
  },

  /** JSONB. Give the value type explicitly for now: `f.json<MyShape>()`. Standard Schema validation comes with constraints. */
  json<V = unknown, const O extends JsonOptions<V> = NoOptions>(
    options?: O & Exact<O, JsonOptions<V>> & ComputeRules<O>,
  ): JsonField<V, FlagsOf<O>> {
    return make({ kind: 'json', pgType: 'jsonb', ...normalize(options ?? {}) }) as JsonField<
      V,
      FlagsOf<O>
    >;
  },

  /** Bytes. Never prefetched. */
  binary<const O extends BinaryOptions = NoOptions>(
    options?: O & Exact<O, BinaryOptions> & ComputeRules<O>,
  ): BinaryField<FlagsOf<O>> {
    return make({
      kind: 'binary',
      pgType: 'bytea',
      ...normalize(options ?? {}),
      prefetch: false as const,
    }) as BinaryField<FlagsOf<O>>;
  },

  /** A reference to one record of `target` (column `<name>_id`, `ON DELETE RESTRICT` by default). */
  many2one<T extends string, const O extends Many2oneOptions<T> = NoOptions>(
    target: T,
    options?: O & Exact<O, Many2oneOptions<T>> & ComputeRules<O> & OnDeleteRules<O>,
  ): Many2oneField<T, FlagsOf<O>> {
    assertModelName(target, 'many2one');
    const opts: Many2oneOptions<T> = options ?? {};
    const ondelete = opts.ondelete ?? 'restrict';
    if (opts.foreignKey === false && opts.ondelete !== undefined) {
      throw new InvalidFieldError(
        'A many2one with foreignKey: false cannot set ondelete: nothing in the database enforces it.',
        'Remove ondelete, or keep the foreign key.',
      );
    }
    if (opts.required === true && ondelete === 'set null') {
      throw new InvalidFieldError(
        "A required many2one cannot use ondelete: 'set null'.",
        "Use 'restrict' (default) or 'cascade', or make the field optional.",
      );
    }
    return make({
      kind: 'many2one',
      pgType: 'bigint',
      ...normalize(opts),
      target,
      ondelete,
      checkCompany: opts.checkCompany ?? false,
      foreignKey: opts.foreignKey !== false,
    }) as Many2oneField<T, FlagsOf<O>>;
  },

  /** The records of `target` whose `inverse` many2one points here. */
  one2many<T extends string, const O extends X2ManyOptions<T> = NoOptions>(
    target: T,
    inverse: string,
    options?: O & Exact<O, X2ManyOptions<T>> & ComputeRules<O>,
  ): One2manyField<T, FlagsOf<O, { required: true; hasDefault: true }>> {
    assertModelName(target, 'one2many');
    assertFieldKey(inverse, 'inverse field name');
    return make({
      kind: 'one2many',
      pgType: '',
      ...normalize(options ?? {}, { storable: false, required: true }),
      target,
      inverseField: inverse,
    }) as One2manyField<T, FlagsOf<O, { required: true; hasDefault: true }>>;
  },

  /** A set of `target` records through a junction table. */
  many2many<T extends string, const O extends Many2manyOptions<T> = NoOptions>(
    target: T,
    options?: O & Exact<O, Many2manyOptions<T>> & ComputeRules<O>,
  ): Many2manyField<T, FlagsOf<O, { required: true; hasDefault: true }>> {
    assertModelName(target, 'many2many');
    const opts: Many2manyOptions<T> = options ?? {};
    if (opts.relation !== undefined) assertIdentifier(opts.relation, 'relation table name');
    return make({
      kind: 'many2many',
      pgType: '',
      ...normalize(opts, { storable: false, required: true }),
      target,
      relation: opts.relation,
    }) as Many2manyField<T, FlagsOf<O, { required: true; hasDefault: true }>>;
  },
};

/** The type of the `f` builders. */
export type FieldBuilders = typeof f;

// ------------------------------------------------------------------------------------- model-internal helpers

/** The implicit `id` field: `bigint GENERATED ALWAYS AS IDENTITY`, read as a branded number. */
export interface IdField<N extends string>
  extends FieldBase<
    'bigint',
    Id<N>,
    never,
    {
      required: true;
      readonly: true;
      computed: false;
      inverse: false;
      hasDefault: false;
      sequence: false;
    }
  > {
  readonly identity: true;
}

/** @internal Used by `defineModel` for the implicit `id` field. */
export function implicitIdField<N extends string>(model: N): IdField<N> {
  void model;
  const base = normalize({ required: true, readonly: true, label: 'ID', copy: false });
  return make({ kind: 'bigint', pgType: 'bigint', ...base, identity: true as const }) as IdField<N>;
}

/** @internal Returns the same descriptor with `label` filled in when it was missing. */
export function withDefaultLabel<F extends Field>(field: F, label: string): F {
  if (field.label !== undefined) return field;
  return make({ ...field, label });
}

/** Attributes an extension may change on an existing field (RFC 0002 §7.5 S2–S4). */
export interface FieldOverrideChanges {
  readonly label?: string;
  readonly help?: string;
  readonly default?: unknown;
  readonly index?: IndexKind;
  readonly tracking?: boolean;
  readonly copy?: boolean;
  readonly groups?: FieldGroups;
  readonly required?: boolean;
  /** Replaces the selection list (used by `selectionAdd` after validation). */
  readonly selection?: readonly (readonly [string, string])[];
  /** State additions (RFC 0010 §7.4). */
  readonly transitions?: Readonly<Record<string, Transition<string>>>;
  readonly stateHooks?: Readonly<Record<string, StateHooks>>;
}

/**
 * @internal The child's copy of a parent field under delegation (`delegates`): a non-stored related field through
 * the delegate many2one, writable unless the parent field is readonly.
 */
export function delegatedField<F extends Field>(field: F, path: string): F {
  const r = field.readonly ? related(path) : related(path, { writable: true });
  return make({
    ...(field as object),
    computed: true,
    store: false,
    compute: r.compute,
    inverse: 'inverse' in r ? r.inverse : undefined,
    depends: r.depends,
    readonly: field.readonly,
    required: false,
    default: undefined,
    sequence: undefined,
    index: undefined,
    column: undefined,
    tracking: false,
    delegated: path.slice(0, path.indexOf('.')),
  }) as unknown as F;
}

/** @internal Returns a new descriptor with `changes` applied; the registry validates them first. */
export function overrideField<F extends Field>(field: F, changes: FieldOverrideChanges): F {
  const next: Record<string, unknown> = { ...(field as object) };
  for (const [key, value] of Object.entries(changes)) if (value !== undefined) next[key] = value;
  return make(next) as F;
}
