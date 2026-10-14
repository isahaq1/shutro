/**
 * Field descriptors as `shutro generate` would emit them (RFC 0002 §7.7).
 * Shared by every variant of the spike.
 */

/** A scalar column. `R` = required (non-null). */
export interface Scalar<V, R extends boolean = false> {
  readonly kind: 'scalar';
  readonly value: V;
  readonly required: R;
}

/** A many2one, referencing its target by model name (RFC 0001 §5.4). */
export interface Many2one<T extends string, R extends boolean = false> {
  readonly kind: 'm2o';
  readonly target: T;
  readonly required: R;
}

/** A one2many or many2many. */
export interface X2many<T extends string> {
  readonly kind: 'x2m';
  readonly target: T;
}

/** Stand-ins for the RFC 0001 value types. */
export declare class Decimal {
  private readonly brand: 'Decimal';
  plus(other: Decimal): Decimal;
}
export declare class CalendarDate {
  private readonly brand: 'CalendarDate';
  isBefore(other: CalendarDate): boolean;
}

/** Branded id per model (RFC 0001 open question 2, resolved: branded number). */
export type Id<M extends string> = number & { readonly __model: M };

/** Model names of a schema view. */
export type ModelName<S> = keyof S & string;

/** Fields of model `M` in schema `S`. */
export type Fields<S, M extends ModelName<S>> = S[M] extends { readonly fields: infer F }
  ? F
  : never;

/** Generated union of the fields that `search()` loads by default (stored scalars + many2one ids). */
export type Defaults<S, M extends ModelName<S>> = S[M] extends {
  readonly defaults: infer D extends string;
}
  ? D
  : never;

/** Field keys whose descriptor is a relation. */
export type RelKeys<S, M extends ModelName<S>> = {
  [K in keyof Fields<S, M>]: Fields<S, M>[K] extends Many2one<string, boolean> | X2many<string>
    ? K
    : never;
}[keyof Fields<S, M>] &
  string;

/** Field keys whose descriptor is a scalar. */
export type ScalarKeys<S, M extends ModelName<S>> = {
  [K in keyof Fields<S, M>]: Fields<S, M>[K] extends Scalar<unknown, boolean> ? K : never;
}[keyof Fields<S, M>] &
  string;

/** Target model of relation field `K`. */
export type Target<S, M extends ModelName<S>, K> = K extends keyof Fields<S, M>
  ? Fields<S, M>[K] extends { readonly target: infer T extends ModelName<S> }
    ? T
    : never
  : never;

/** Applies nullability. */
export type Req<V, R> = R extends true ? V : V | null;

/** Branded error type: using it where a value is expected shows the fix in the message. */
export interface NotLoaded<M extends string, K extends string> {
  readonly __notLoaded: `${M}.${K} is not loaded: add it to .load({ ... })`;
}
