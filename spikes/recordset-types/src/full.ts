/**
 * Variant `full`: RFC 0004 §7.2. The loaded shape is tracked at every level (depth ≤ 4) and merged
 * across successive `load()` calls.
 *
 * A loaded shape is `{ s: <loaded field keys>; r: { <relation>: <shape> } }`. Shapes are deliberately
 * unconstrained type parameters read through `infer` helpers: a `L extends Loaded` constraint can't be
 * proven for mapped/conditional `Merge` results in generic code, and checking it costs instantiations.
 */
import type {
  Defaults,
  Fields,
  Id,
  Many2one,
  ModelName,
  NotLoaded,
  RelKeys,
  Req,
  Scalar,
  ScalarKeys,
  Target,
  X2many,
} from './schema.ts';

/** No relations loaded. Must have `keyof` = never (an index signature would make every key "loaded"). */
type NoRels = Record<never, never>;

/** Loaded field keys of a shape. */
type SOf<L> = L extends { readonly s: infer X extends string } ? X : never;
/** Loaded relations of a shape. */
type ROf<L> = L extends { readonly r: infer X } ? X : NoRels;

/** What `search()` / `browse()` load. */
export type DefaultLoaded<S, M extends ModelName<S>> = {
  readonly s: Defaults<S, M>;
  readonly r: NoRels;
};

type Dec = [0, 0, 1, 2, 3];

/** The `load()` argument: relation keys mapped to `true`, a scalar list, or a nested spec. */
export type LoadSpec<S, M extends ModelName<S>, D extends number = 4> = {
  readonly [K in RelKeys<S, M>]?:
    | true
    | readonly ScalarKeys<S, Target<S, M, K>>[]
    | (D extends 0 ? never : LoadSpec<S, Target<S, M, K>, Dec[D]>);
} & { readonly '*'?: true };

/** Converts a spec into a loaded shape. */
export type ToLoaded<S, M extends ModelName<S>, X> = X extends true
  ? DefaultLoaded<S, M>
  : X extends readonly (infer K extends string)[]
    ? { readonly s: K; readonly r: NoRels }
    : {
        // A nested object spec loads the relation's default columns too (same query); only arrays narrow.
        readonly s: Defaults<S, M>;
        readonly r: {
          readonly [K in keyof X & RelKeys<S, M>]: ToLoaded<S, Target<S, M, K>, X[K]>;
        };
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

/** A record whose only known field is its id (a many2one that was not loaded). */
export interface IdOnly<M extends string> {
  readonly id: Id<M>;
  readonly model: M;
}

/** An x2many reached without loading it: navigable, but no sync data. */
export interface PendingSet<S, M extends ModelName<S>> {
  readonly model: M;
  load<const X extends LoadSpec<S, M>>(
    spec: X,
  ): Promise<RecordSet<S, M, Merge<DefaultLoaded<S, M>, ToLoaded<S, M, X>>>>;
  ids(): Promise<readonly Id<M>[]>;
}

type FieldValue<S, M extends ModelName<S>, K extends string, F, L> =
  F extends Scalar<infer V, infer R>
    ? K extends SOf<L>
      ? Req<V, R>
      : NotLoaded<M, K>
    : F extends Many2one<infer T extends ModelName<S>, infer R>
      ? K extends keyof ROf<L>
        ? Req<Rec<S, T, ROf<L>[K]>, R>
        : K extends SOf<L>
          ? Req<IdOnly<T>, R>
          : NotLoaded<M, K>
      : F extends X2many<infer T extends ModelName<S>>
        ? K extends keyof ROf<L>
          ? RecordSet<S, T, ROf<L>[K]>
          : PendingSet<S, T>
        : never;

/** Field access on a single record. */
export type Access<S, M extends ModelName<S>, L> = {
  readonly [K in keyof Fields<S, M> & string]: FieldValue<S, M, K, Fields<S, M>[K], L>;
};

/** A singleton: a recordset of one plus field access. */
export type Rec<S, M extends ModelName<S>, L> = RecordSet<S, M, L> & Access<S, M, L>;

export interface RecordSet<S, M extends ModelName<S>, L> {
  readonly model: M;
  readonly length: number;
  [Symbol.iterator](): Iterator<Rec<S, M, L>>;
  first(): Rec<S, M, L>;
  load<const X extends LoadSpec<S, M>>(
    spec: X,
  ): Promise<RecordSet<S, M, Merge<L, ToLoaded<S, M, X>>>>;
}

export interface Model<S, M extends ModelName<S>> {
  search(): Promise<RecordSet<S, M, DefaultLoaded<S, M>>>;
}

export interface Env<S> {
  model<M extends ModelName<S>>(name: M): Model<S, M>;
}
