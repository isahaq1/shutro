/**
 * Variant `flat`: RFC 0004 §11 Q1 fallback. Only the recordset's own loaded fields are tracked.
 * Records reached through a loaded relation are fully accessible (runtime-checked).
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

/** `s` = loaded field keys, `r` = keys of loaded relations (their contents are not tracked). */
export interface Loaded {
  readonly s: string;
  readonly r: string;
}

export type DefaultLoaded<S, M extends ModelName<S>> = {
  readonly s: Defaults<S, M>;
  readonly r: never;
};

/** Same spec syntax as `full`, so usage code is identical. Nested specs are accepted but not tracked. */
export type LoadSpec<S, M extends ModelName<S>> = {
  readonly [K in RelKeys<S, M>]?: true | readonly ScalarKeys<S, Target<S, M, K>>[] | object;
} & { readonly '*'?: true };

type ToLoaded<S, M extends ModelName<S>, X> = {
  readonly s: '*' extends keyof X ? Defaults<S, M> : never;
  readonly r: keyof X & RelKeys<S, M>;
};

type Merge<A extends Loaded, B extends Loaded> = {
  readonly s: A['s'] | B['s'];
  readonly r: A['r'] | B['r'];
};

export interface IdOnly<M extends string> {
  readonly id: Id<M>;
  readonly model: M;
}

export interface PendingSet<S, M extends ModelName<S>> {
  readonly model: M;
  load<const X extends LoadSpec<S, M>>(
    spec: X,
  ): Promise<RecordSet<S, M, Merge<DefaultLoaded<S, M>, ToLoaded<S, M, X>>>>;
  ids(): Promise<readonly Id<M>[]>;
}

/** Untracked access: every field is available, relations stay untracked. */
type LooseValue<S, F> =
  F extends Scalar<infer V, infer R>
    ? Req<V, R>
    : F extends Many2one<infer T extends ModelName<S>, infer R>
      ? Req<LooseRec<S, T>, R>
      : F extends X2many<infer T extends ModelName<S>>
        ? LooseSet<S, T>
        : never;

export type LooseRec<S, M extends ModelName<S>> = LooseSet<S, M> & {
  readonly [K in keyof Fields<S, M>]: LooseValue<S, Fields<S, M>[K]>;
};

export interface LooseSet<S, M extends ModelName<S>> {
  readonly model: M;
  readonly length: number;
  [Symbol.iterator](): Iterator<LooseRec<S, M>>;
}

type FieldValue<S, M extends ModelName<S>, K extends string, F, L extends Loaded> =
  F extends Scalar<infer V, infer R>
    ? K extends L['s']
      ? Req<V, R>
      : NotLoaded<M, K>
    : F extends Many2one<infer T extends ModelName<S>, infer R>
      ? K extends L['r']
        ? Req<LooseRec<S, T>, R>
        : K extends L['s']
          ? Req<IdOnly<T>, R>
          : NotLoaded<M, K>
      : F extends X2many<infer T extends ModelName<S>>
        ? K extends L['r']
          ? LooseSet<S, T>
          : PendingSet<S, T>
        : never;

export type Rec<S, M extends ModelName<S>, L extends Loaded> = RecordSet<S, M, L> & {
  readonly [K in keyof Fields<S, M> & string]: FieldValue<S, M, K, Fields<S, M>[K], L>;
};

export interface RecordSet<S, M extends ModelName<S>, L extends Loaded> {
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
