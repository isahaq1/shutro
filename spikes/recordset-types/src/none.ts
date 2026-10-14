/**
 * Variant `none`: baseline. No load tracking; every field is always accessible (runtime-checked only).
 * Measures what the schema and the recordset API cost without any loaded-shape types.
 */
import type {
  Fields,
  Many2one,
  ModelName,
  RelKeys,
  Req,
  Scalar,
  ScalarKeys,
  Target,
  X2many,
} from './schema.ts';

export type LoadSpec<S, M extends ModelName<S>> = {
  readonly [K in RelKeys<S, M>]?: true | readonly ScalarKeys<S, Target<S, M, K>>[] | object;
} & { readonly '*'?: true };

type Value<S, F> =
  F extends Scalar<infer V, infer R>
    ? Req<V, R>
    : F extends Many2one<infer T extends ModelName<S>, infer R>
      ? Req<Rec<S, T>, R>
      : F extends X2many<infer T extends ModelName<S>>
        ? RecordSet<S, T>
        : never;

export type Rec<S, M extends ModelName<S>> = RecordSet<S, M> & {
  readonly [K in keyof Fields<S, M>]: Value<S, Fields<S, M>[K]>;
};

export interface RecordSet<S, M extends ModelName<S>> {
  readonly model: M;
  readonly length: number;
  [Symbol.iterator](): Iterator<Rec<S, M>>;
  first(): Rec<S, M>;
  load<const X extends LoadSpec<S, M>>(spec: X): Promise<RecordSet<S, M>>;
}

export interface Model<S, M extends ModelName<S>> {
  search(): Promise<RecordSet<S, M>>;
}

export interface Env<S> {
  model<M extends ModelName<S>>(name: M): Model<S, M>;
}
