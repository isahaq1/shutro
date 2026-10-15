/**
 * Recordset types (RFC 0004 §7.2): the loaded shape `L` of a recordset is tracked in the types, so reading a field
 * that was not loaded is a compile error whose message says which `load()` is missing.
 *
 * Shapes are `{ s: <loaded field keys>; r: { <relation>: <shape> } }` and are read through `infer` helpers
 * (spike 0001, lesson 2).
 */

import type { AuditAction, AuditEntry } from '@shutro/audit';
import type { Translations } from '@shutro/i18n';
import type { Env } from '../env/env.js';
import type { CreateOf, FlagsOfField, ReadValue, WriteOf, WriteType } from '../model/faces.js';
import type { Id, X2ManyCommands } from '../model/id.js';
import type { Decimal } from '../money/decimal.js';
import type { MoneyJson } from '../money/money.js';

/** Model names of a schema view. */
export type ModelName<S> = keyof S & string;
/** Fields of model `M`. */
export type FieldsOf<S, M extends ModelName<S>> = S[M] extends { readonly fields: infer F }
  ? F
  : never;
type KindOf<F> = F extends { readonly kind: infer K extends string } ? K : never;
type TargetOf<F> = F extends { readonly target: infer T extends string } ? T : never;
/** Target model of relation field `K` of `M`. */
export type Target<S, M extends ModelName<S>, K> = K extends keyof FieldsOf<S, M>
  ? TargetOf<FieldsOf<S, M>[K]> & ModelName<S>
  : never;
type IsX2Many<F> = KindOf<F> extends 'one2many' | 'many2many' ? true : false;
type IsRelation<F> = KindOf<F> extends 'many2one' | 'one2many' | 'many2many' ? true : false;
type IsDefault<F> =
  IsX2Many<F> extends true
    ? false
    : KindOf<F> extends 'binary'
      ? false
      : FlagsOfField<F>['computed'] extends true
        ? FlagsOfField<F>['store'] extends true
          ? true
          : false
        : true;
type Keys<S, M extends ModelName<S>> = keyof FieldsOf<S, M> & string;

/** Fields `search()` / `browse().load()` load by default: stored, non-binary, not x2many. */
export type Defaults<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: IsDefault<FieldsOf<S, M>[K]> extends true ? K : never;
}[Keys<S, M>];
/** Relation field keys. */
export type RelKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: IsRelation<FieldsOf<S, M>[K]> extends true ? K : never;
}[Keys<S, M>];
/** Keys that can appear in a list load spec: everything but x2many. */
export type ListKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: IsX2Many<FieldsOf<S, M>[K]> extends true ? never : K;
}[Keys<S, M>];
/** Non-relational keys. */
export type ScalarKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: IsRelation<FieldsOf<S, M>[K]> extends true ? never : K;
}[Keys<S, M>];

// ------------------------------------------------------------------------------------------------- shapes

type NoRels = Record<never, never>;
type SOf<L> = L extends { readonly s: infer X extends string } ? X : never;
type ROf<L> = L extends { readonly r: infer X } ? X : NoRels;
/** What `search()` and `browse().load()` load. */
export type DefaultLoaded<S, M extends ModelName<S>> = {
  readonly s: Defaults<S, M>;
  readonly r: NoRels;
};
/** Exactly the listed keys (plus `id`). */
export type ListLoaded<K extends string> = { readonly s: K | 'id'; readonly r: NoRels };
type Dec = [0, 0, 1, 2, 3];
/** The `load()` argument: relation keys mapped to `true`, a key list, or a nested spec (depth ≤ 4). */
export type LoadSpec<S, M extends ModelName<S>, D extends number = 4> = {
  readonly [K in RelKeys<S, M>]?:
    | true
    | readonly ListKeys<S, Target<S, M, K>>[]
    | (D extends 0 ? never : LoadSpec<S, Target<S, M, K>, Dec[D]>);
};
/** Converts a spec into a loaded shape. A nested object loads the relation's defaults plus its nested relations. */
export type ToLoaded<S, M extends ModelName<S>, X> = X extends true
  ? DefaultLoaded<S, M>
  : X extends readonly (infer K extends string)[]
    ? ListLoaded<K>
    : {
        readonly s: Defaults<S, M>;
        readonly r: { readonly [K in keyof X & RelKeys<S, M>]: ToLoaded<S, Target<S, M, K>, X[K]> };
      };
/** Union of two loaded shapes, recursively. */
export type Merge<A, B> = {
  readonly s: SOf<A> | SOf<B>;
  readonly r: {
    readonly [K in keyof ROf<A> | keyof ROf<B>]: K extends keyof ROf<A>
      ? K extends keyof ROf<B>
        ? Merge<ROf<A>[K], ROf<B>[K]>
        : ROf<A>[K]
      : K extends keyof ROf<B>
        ? ROf<B>[K]
        : never;
  };
};

// ------------------------------------------------------------------------------------------------- values

/** Branded error type: using it where a value is expected shows the fix in the message. */
export interface NotLoaded<M extends string, K extends string> {
  readonly __notLoaded: `${M}.${K} is not loaded: add it to .load({ ... })`;
}
/** A many2one that was not loaded: only its id is known. */
export interface IdOnly<M extends string> {
  readonly id: Id<M>;
  readonly modelName: M;
}
type Req<V, F> = FlagsOfField<F>['required'] extends true ? V : V | null;

type FieldValue<S, M extends ModelName<S>, K extends string, F, L> =
  IsX2Many<F> extends true
    ? K extends keyof ROf<L>
      ? RecordSet<S, Target<S, M, K>, ROf<L>[K]>
      : PendingSet<S, Target<S, M, K>>
    : KindOf<F> extends 'many2one'
      ? K extends keyof ROf<L>
        ? Req<Rec<S, Target<S, M, K>, ROf<L>[K]>, F>
        : K extends SOf<L>
          ? Req<IdOnly<Target<S, M, K>>, F>
          : NotLoaded<M, K>
      : K extends SOf<L>
        ? ReadValue<F>
        : NotLoaded<M, K>;

/** Field access on a single record. */
export type Access<S, M extends ModelName<S>, L> = {
  readonly [K in Keys<S, M>]: FieldValue<S, M, K, FieldsOf<S, M>[K], L>;
};

/** A singleton: a recordset of one plus field access. */
export type Rec<S, M extends ModelName<S>, L> = RecordSet<S, M, L> & Access<S, M, L>;

type PlainValue<S, M extends ModelName<S>, K extends string, F> =
  IsX2Many<F> extends true
    ? readonly Id<Target<S, M, K>>[]
    : KindOf<F> extends 'many2one'
      ? Req<Id<Target<S, M, K>>, F>
      : KindOf<F> extends 'monetary'
        ? Req<MoneyJson, F>
        : KindOf<F> extends 'quantity'
          ? Req<{ readonly value: string; readonly uom: string }, F>
          : KindOf<F> extends 'datetime'
            ? Req<string, F>
            : KindOf<F> extends 'decimal'
              ? Req<string, F>
              : ReadValue<F>;
/** Plain, JSON-serializable rows as `read()` returns them. */
export type PlainRow<S, M extends ModelName<S>, K extends string> = { readonly id: Id<M> } & {
  readonly [X in K]: PlainValue<
    S,
    M,
    X,
    X extends keyof FieldsOf<S, M> ? FieldsOf<S, M>[X] : never
  >;
};

/** Keys readable from a shape: loaded scalars/many2one ids and loaded relations. */
export type LoadedKeys<L> = SOf<L> | (keyof ROf<L> & string);

// ---------------------------------------------------------------------------------------------- recordsets

/** An x2many reached without loading it: navigable, but no synchronous data. */
export interface PendingSet<S, M extends ModelName<S>> {
  readonly modelName: M;
  /** Loads the defaults for every record of the prefetch group. */
  load(): Promise<RecordSet<S, M, DefaultLoaded<S, M>>>;
  load<const K extends readonly ListKeys<S, M>[]>(
    keys: K,
  ): Promise<RecordSet<S, M, ListLoaded<K[number]>>>;
  load<const X extends LoadSpec<S, M>>(
    spec: X,
  ): Promise<RecordSet<S, M, Merge<DefaultLoaded<S, M>, ToLoaded<S, M, X>>>>;
  ids(): Promise<readonly Id<M>[]>;
}

/** An ordered, immutable set of records of one model, bound to an environment (RFC 0004). */
export interface RecordSetApi<S, M extends ModelName<S>, L> {
  readonly env: Env<S>;
  readonly modelName: M;
  readonly ids: readonly Id<M>[];
  readonly length: number;
  [Symbol.iterator](): Iterator<Rec<S, M, L>>;
  /** @throws {SingletonError} when empty */
  first(): Rec<S, M, L>;
  /** @throws {SingletonError} unless exactly one record */
  ensureOne(): Rec<S, M, L>;
  isEmpty(): boolean;
  load(): Promise<RecordSet<S, M, Merge<L, DefaultLoaded<S, M>>>>;
  load<const K extends readonly ListKeys<S, M>[]>(
    keys: K,
  ): Promise<RecordSet<S, M, Merge<L, ListLoaded<K[number]>>>>;
  load<const X extends LoadSpec<S, M>>(
    spec: X,
  ): Promise<RecordSet<S, M, Merge<L, ToLoaded<S, M, X>>>>;
  map<T>(fn: (record: Rec<S, M, L>, index: number) => T): T[];
  filter(fn: (record: Rec<S, M, L>, index: number) => boolean): RecordSet<S, M, L>;
  /** The values of a loaded scalar field, in order. */
  mapped<K extends ScalarKeys<S, M> & SOf<L>>(key: K): ReadValue<FieldsOf<S, M>[K]>[];
  /** Updates the records in the cache now; the database is updated at the next flush point (search, raw SQL, savepoint end, commit). */
  write(values: WriteValues<S, M>): Promise<void>;
  /** Deletes the records now (`ON DELETE` rules apply). */
  unlink(): Promise<void>;
  /** Plain JSON rows (ids for relations, `Money` / `Quantity` as objects, dates as ISO strings). */
  read<const K extends readonly LoadedKeys<L>[]>(keys: K): PlainRow<S, M, K[number]>[];
  /** The audit rows of these records, newest first (RFC 0013 §7.4). */
  trail(options?: {
    readonly field?: Keys<S, M>;
    readonly limit?: number;
    readonly action?: AuditAction;
  }): Promise<readonly AuditEntry[]>;
  /** Numbers these records from their manual sequence (RFC 0012 §7.4); records with a number are refused. */
  assignNumber<K extends SequenceKeys<S, M>>(
    key: K,
    options?: { readonly date?: string },
  ): Promise<void>;
  /** The full translation map of a translatable field (singleton, loaded), or `null` (RFC 0011). */
  translations<K extends TranslatedKeys<S, M>>(key: K): Translations | null;
  /** Transition names the current state allows (singleton with its state loaded; RFC 0010 §7.3). */
  transitions(): readonly string[];
  toJSON(): readonly Id<M>[];
}

/** The model's methods (declared ones and generated transitions), callable on recordsets. */
export type MethodsOf<S, M extends ModelName<S>> = S[M] extends { readonly methods: infer Ms }
  ? Ms
  : NonNullable<unknown>;
/** An ordered, immutable set of records of one model, with the model's methods (RFC 0004, RFC 0010 §7.6). */
export type RecordSet<S, M extends ModelName<S>, L> = RecordSetApi<S, M, L> & MethodsOf<S, M>;

// --------------------------------------------------------------------------------------------------- search

type DomainKeys<S, M extends ModelName<S>> = ListKeys<S, M>;
type DomainOperators<V> = {
  readonly eq?: V | null;
  readonly ne?: V | null;
  readonly lt?: V;
  readonly lte?: V;
  readonly gt?: V;
  readonly gte?: V;
  readonly in?: readonly V[];
  readonly notIn?: readonly V[];
  readonly isNull?: boolean;
  readonly like?: string;
  readonly ilike?: string;
};
type DomainValue<F> =
  WriteType<F> extends never ? unknown : WriteType<F> | DomainOperators<WriteType<F>>;
/** A search filter: field → value (equality) or operators. Keys are ANDed. Relation paths come with the domain compiler. */
export type Domain<S, M extends ModelName<S>> = {
  readonly [K in DomainKeys<S, M>]?: K extends 'id'
    ? Id<M> | DomainOperators<Id<M>>
    : DomainValue<FieldsOf<S, M>[K]>;
} & {
  /** Any of the domains. */
  readonly or?: readonly Domain<S, M>[];
  readonly and?: readonly Domain<S, M>[];
  readonly not?: Domain<S, M>;
};
/** `'field'`, `'field asc'` or `'field desc'` over sortable (non-x2many) fields. */
export type SearchOrder<S, M extends ModelName<S>> =
  | ListKeys<S, M>
  | `${ListKeys<S, M>} asc`
  | `${ListKeys<S, M>} desc`;
/** Argument of `search()`. */
export interface SearchQuery<S, M extends ModelName<S>> {
  readonly where?: Domain<S, M>;
  readonly order?: readonly SearchOrder<S, M>[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Values accepted by `create()`: the create face of the model's fields (x2many fields take commands). */
export type CreateValues<S, M extends ModelName<S>> = CreateOf<FieldsOf<S, M>>;
/** Values accepted by `write()`. */
export type WriteValues<S, M extends ModelName<S>> = WriteOf<FieldsOf<S, M>>;

/** `env.model(name)`: the entry point for a model. */
export interface ModelRef<S, M extends ModelName<S>> {
  readonly modelName: M;
  /** Inserts records (one statement per model) and returns them with their defaults loaded (RFC 0004 §7.6). */
  create(values: readonly CreateValues<S, M>[]): Promise<RecordSet<S, M, DefaultLoaded<S, M>>>;
  search(query?: SearchQuery<S, M>): Promise<RecordSet<S, M, DefaultLoaded<S, M>>>;
  /** A lazy recordset of these ids. Nothing is fetched until `load()`. */
  browse(ids: readonly number[]): PendingSet<S, M>;
  /** Form assist on an in-memory draft: derived values and warnings, nothing written (RFC 0009 §7.4). */
  onchange(input: OnchangeInput<S, M>): Promise<OnchangeResult<S, M>>;
}

// ------------------------------------------------------------------------------------------------ computes

/** Keys of sequence-numbered fields. */
export type SequenceKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: FlagsOfField<FieldsOf<S, M>[K]>['sequence'] extends true ? K : never;
}[Keys<S, M>];

/** Keys of translatable text fields (their write type accepts a translation map). */
export type TranslatedKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: Translations extends WriteType<FieldsOf<S, M>[K]> ? K : never;
}[Keys<S, M>];

/** Keys of computed fields. */
export type ComputedKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: FlagsOfField<FieldsOf<S, M>[K]>['computed'] extends true ? K : never;
}[Keys<S, M>];
/** A record inside a compute: computed keys are assignable (RFC 0008 §7.7). */
export type ComputeRec<S, M extends ModelName<S>, L> = Omit<Rec<S, M, L>, ComputedKeys<S, M>> & {
  -readonly [K in ComputedKeys<S, M>]:
    | FieldValue<S, M, K, FieldsOf<S, M>[K], L>
    | WriteType<FieldsOf<S, M>[K]>;
};
/** A recordset inside a compute: iteration yields {@link ComputeRec}. */
export type ComputeSet<S, M extends ModelName<S>, L> = Omit<
  RecordSet<S, M, L>,
  typeof Symbol.iterator | 'first' | 'ensureOne'
> & {
  [Symbol.iterator](): Iterator<ComputeRec<S, M, L>>;
  first(): ComputeRec<S, M, L>;
  ensureOne(): ComputeRec<S, M, L>;
};

// ------------------------------------------------------------------------------------------------- onchange

/** Many2one keys. */
export type Many2oneKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: KindOf<FieldsOf<S, M>[K]> extends 'many2one' ? K : never;
}[Keys<S, M>];
/** x2many keys. */
export type X2ManyKeys<S, M extends ModelName<S>> = {
  [K in Keys<S, M>]: IsX2Many<FieldsOf<S, M>[K]> extends true ? K : never;
}[Keys<S, M>];

/** What a draft holds for a field: an id for many2one, commands for x2many, a Decimal for amounts, read values otherwise. */
export type DraftValue<S, M extends ModelName<S>, K extends Keys<S, M>> =
  IsX2Many<FieldsOf<S, M>[K]> extends true
    ? X2ManyCommands<Target<S, M, K>> | undefined
    : KindOf<FieldsOf<S, M>[K]> extends 'many2one'
      ? Id<Target<S, M, K>> | null
      : KindOf<FieldsOf<S, M>[K]> extends 'monetary' | 'quantity'
        ? Decimal | null
        : ReadValue<FieldsOf<S, M>[K]> | null;

/** The draft an onchange handler receives (RFC 0009 §7.3). */
export interface Draft<S, M extends ModelName<S>> {
  readonly id: Id<M> | null;
  readonly env: Env<S>;
  get<K extends Keys<S, M>>(key: K): DraftValue<S, M, K>;
  /** Normalized like a write; `null` is always accepted in a draft. Marks the key changed (its handler runs next). */
  set<K extends Keys<S, M>>(key: K, value: WriteType<FieldsOf<S, M>[K]> | null): void;
  /** The related record of a many2one, loaded with its defaults, or null. */
  record<K extends Many2oneKeys<S, M>>(
    key: K,
  ): Promise<Rec<S, Target<S, M, K>, DefaultLoaded<S, Target<S, M, K>>> | null>;
  warn(message: string): void;
}

/** The input of `env.model(M).onchange()`. */
export interface OnchangeInput<S, M extends ModelName<S>> {
  /** An existing record: its values are the base of the draft. */
  readonly id?: Id<M> | undefined;
  /** The form's values (x2many as commands; `create` rows become virtual children). */
  readonly values: { readonly [K in Keys<S, M>]?: WriteType<FieldsOf<S, M>[K]> | null };
  /** Fields whose handlers run, in order. */
  readonly changed: readonly Keys<S, M>[];
}

/** The output of `env.model(M).onchange()`. */
export interface OnchangeResult<S, M extends ModelName<S>> {
  /** Scalar and many2one fields whose plain value differs from the input. */
  readonly values: Partial<PlainRow<S, M, Exclude<ScalarKeys<S, M> | Many2oneKeys<S, M>, 'id'>>>;
  readonly warnings: readonly string[];
  /** Plain rows of the virtual children created by `create` commands, per x2many field. */
  readonly children: { readonly [K in X2ManyKeys<S, M>]?: readonly Record<string, unknown>[] };
}
