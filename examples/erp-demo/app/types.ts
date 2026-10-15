/**
 * Type aliases over the application's schema, for compute / constraint / onchange bodies. Definitions take
 * `unknown` and cast to these (the generated bindings would remove the casts, see docs/feedback.md #1).
 */
import type {
  ComputeSet,
  Draft as CoreDraft,
  Env as CoreEnv,
  DefaultLoaded,
  LoadSpec,
  Merge,
  Money,
  RecordSet,
  ToLoaded,
} from '@shutro/core';
import type { registry } from './registry.ts';

export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
export type ModelName = keyof S & string;
export type Env = CoreEnv<S>;

/** A recordset of `M` with its default fields loaded. */
export type Records<M extends ModelName> = RecordSet<S, M, DefaultLoaded<S, M>>;
/** The records a compute receives: defaults plus `X` (its `depends` paths), computed keys assignable. */
export type ComputeRecords<
  M extends ModelName,
  X extends LoadSpec<S, M> = Record<never, never>,
> = ComputeSet<S, M, Merge<DefaultLoaded<S, M>, ToLoaded<S, M, X>>>;
/** An onchange draft of `M`. */
export type Draft<M extends ModelName> = CoreDraft<S, M>;

/**
 * Inside a compute, computed fields are typed `read | write` so they can be assigned; reading one computed field
 * from another compute needs the read type back (docs/feedback.md #2).
 */
export function readMoney(value: unknown): Money | null {
  return value as Money | null;
}
/** The id of a computed many2one read inside a compute. */
export function readId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : (value as { readonly id: number }).id;
}
