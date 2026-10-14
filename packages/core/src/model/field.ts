/**
 * Field builders (`f.*`) and descriptors, RFC 0001 §7.3. A descriptor is frozen runtime metadata (what Kosh and
 * the migrator read) plus phantom types that carry the field's read / create / write faces.
 */
import type { Env } from '../env/env.js';
import { InvalidFieldError, ShutroError } from '../errors.js';
import type { Decimal } from '../money/decimal.js';
import { toDecimal } from '../money/decimal.js';
import type { Money } from '../money/money.js';
import type { Quantity } from '../money/quantity.js';
import type { Id, X2ManyCommands } from './id.js';

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

/** Phantom flags that decide a field's faces (RFC 0001 §7.3). */
export interface FieldFlags {
  readonly required: boolean;
  /** Excluded from create and write: explicit `readonly`, a sequence, a compute without inverse, or a state. */
  readonly readonly: boolean;
  readonly computed: boolean;
  readonly inverse: boolean;
  readonly hasDefault: boolean;
  readonly sequence: boolean;
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
  readonly groups: readonly string[];
  readonly deprecated: string | undefined;
  readonly sequence: { readonly code: string; readonly gapless: boolean } | undefined;
  readonly translate: boolean;
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
  readonly groups?: readonly string[];
  readonly deprecated?: string;
  /** Persist a computed field (recomputed in batches before commit). */
  readonly store?: boolean;
  /** Dotted paths the compute reads. Checked against the schema view (RFC 0002). */
  readonly depends?: readonly string[];
  /** Inline batch function, or the key of a model method shared by several fields. */
  readonly compute?: ComputeFn | string;
  readonly inverse?: InverseFn;
}

/** Options of text-like fields. */
export interface TextOptions extends CommonOptions<string> {
  /** Store per-language values as JSONB (RFC 0001 §7.3). */
  readonly translate?: boolean;
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
/** A state transition. */
export interface Transition<S extends string> {
  readonly from: readonly S[];
  readonly to: S;
}
/** Options of `f.state`. */
export interface StateOptions<
  S extends Record<string, string>,
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
/** `f.char` descriptor. */
export interface CharField<Fl extends FieldFlags> extends FieldBase<'char', string, string, Fl> {
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
export interface MonetaryField<Fl extends FieldFlags>
  extends FieldBase<'monetary', Money, Decimal | string, Fl> {
  readonly currencyField: string;
}
/** `f.quantity` descriptor. */
export interface QuantityField<Fl extends FieldFlags>
  extends FieldBase<'quantity', Quantity, Decimal | string, Fl> {
  readonly uomField: string;
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

/** Derives the phantom flags from a builder's options and its kind defaults. */
export type FlagsOf<
  O,
  D extends { required?: true; readonly?: true; hasDefault?: true } = NoOptions,
> = {
  readonly required: IsTrue<O, 'required'> extends true
    ? true
    : D extends { required: true }
      ? true
      : false;
  readonly computed: Present<O, 'compute'>;
  readonly inverse: Present<O, 'inverse'>;
  readonly sequence: Present<O, 'sequence'>;
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
  readonly sequence?: string | { readonly code: string; readonly gapless?: boolean };
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
  readonly groups: readonly string[];
  readonly deprecated: string | undefined;
  readonly sequence: { readonly code: string; readonly gapless: boolean } | undefined;
  readonly translate: boolean;
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
  readonly [K in keyof (CommonOptions<unknown> & SequenceOption & { translate?: boolean })]?:
    | (CommonOptions<unknown> & SequenceOption & { translate?: boolean })[K]
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
        ? { code: options.sequence, gapless: false }
        : { code: options.sequence.code, gapless: options.sequence.gapless ?? false };
  if (sequence !== undefined && sequence.code.trim() === '') {
    throw new InvalidFieldError(
      'A sequence needs a code.',
      "Pass sequence: 'sale.order' or { code: 'account.move', gapless: true }.",
    );
  }
  const computed = compute !== undefined;
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
    groups: Object.freeze([...(options.groups ?? [])]),
    deprecated: options.deprecated,
    sequence,
    translate: options.translate ?? false,
  };
}

function make<F extends object>(descriptor: F): F {
  const frozen = Object.freeze(descriptor);
  created.add(frozen);
  return frozen;
}

function textLike<K extends 'char' | 'text' | 'html'>(
  kind: K,
  options: TextOptions & SequenceOption,
  pgType: string,
): FieldBase<K, string, string, FieldFlags> {
  const base = normalize(options);
  return make({ kind, pgType: base.translate ? 'jsonb' : pgType, ...base });
}

// -------------------------------------------------------------------------------------------------- builders

/** The field builders. See each method for its options; every descriptor is frozen metadata. */
export const f = {
  /** Short text. `size` gives `varchar(size)`, otherwise `text`. */
  char<const O extends CharOpts = NoOptions>(
    options?: O & Exact<O, CharOpts> & ComputeRules<O>,
  ): CharField<FlagsOf<O>> {
    const opts: CharOpts = options ?? {};
    if (opts.size !== undefined) assertPositiveInt(opts.size, 'size');
    const base = textLike('char', opts, opts.size === undefined ? 'text' : `varchar(${opts.size})`);
    return make({ ...base, size: opts.size }) as CharField<FlagsOf<O>>;
  },

  /** Long text. */
  text<const O extends TextOptions = NoOptions>(
    options?: O & Exact<O, TextOptions> & ComputeRules<O>,
  ): ScalarField<'text', string, string, FlagsOf<O>> {
    return textLike('text', options ?? {}, 'text') as ScalarField<
      'text',
      string,
      string,
      FlagsOf<O>
    >;
  },

  /** HTML, sanitized on write unless `sanitize: false`. */
  html<const O extends HtmlOptions = NoOptions>(
    options?: O & Exact<O, HtmlOptions> & ComputeRules<O>,
  ): ScalarField<'html', string, string, FlagsOf<O>> & { readonly sanitize: boolean } {
    const opts: HtmlOptions = options ?? {};
    const base = textLike('html', opts, 'text');
    return make({ ...base, sanitize: opts.sanitize ?? true }) as ScalarField<
      'html',
      string,
      string,
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

  /** 64-bit integer, read as `bigint`. */
  bigint<const O extends CommonOptions<bigint | number> = NoOptions>(
    options?: O & Exact<O, CommonOptions<bigint | number>> & ComputeRules<O>,
  ): ScalarField<'bigint', bigint, bigint | number, FlagsOf<O>> {
    return make({ kind: 'bigint', pgType: 'bigint', ...normalize(options ?? {}) }) as ScalarField<
      'bigint',
      bigint,
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
  ): MonetaryField<FlagsOf<O>> {
    assertFieldKey(options.currency, 'currency field name');
    assertDecimalDefault(options.default, 'monetary');
    return make({
      kind: 'monetary',
      pgType: 'numeric',
      ...normalize(options),
      currencyField: options.currency,
    }) as MonetaryField<FlagsOf<O>>;
  },

  /** A quantity in the unit of the sibling `uom` field (read as `Quantity`). */
  quantity<const O extends QuantityOptions>(
    options: O & Exact<O, QuantityOptions> & ComputeRules<O>,
  ): QuantityField<FlagsOf<O>> {
    assertFieldKey(options.uom, 'uom field name');
    assertDecimalDefault(options.default, 'quantity');
    return make({
      kind: 'quantity',
      pgType: 'numeric',
      ...normalize(options),
      uomField: options.uom,
      scale: options.scale,
    }) as QuantityField<FlagsOf<O>>;
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
    const S extends Record<string, string>,
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
    for (const [key] of states) {
      assertIdentifier(key, 'state name');
      names.add(key);
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
    }
    const base = normalize(
      {
        label: options.label,
        help: options.help,
        tracking: options.tracking,
        default: options.initial,
      },
      { required: true, readonly: true },
    );
    return make({
      kind: 'state',
      pgType: 'text',
      ...base,
      selection: Object.freeze(states.map(([k, v]) => Object.freeze([k, v] as const))),
      initial: options.initial,
      transitions: Object.freeze(options.transitions),
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
