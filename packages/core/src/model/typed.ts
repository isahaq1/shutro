/**
 * Typed definition callbacks (feedback #1, #2). `defineModel` cannot type its own callbacks against the schema it is
 * part of (the schema is inferred from the definitions, TS7022). The generated per-module view (`shutro generate`,
 * RFC 0002 §7.7) is a declared interface, so callbacks typed against it break the cycle:
 *
 * ```ts
 * // modules/sale/.shutro/bindings.ts (generated) exports these helpers bound to the module's view.
 * import { compute, defineModel, f } from './.shutro/bindings.ts';
 *
 * amountTotal: f.monetary({
 *   currency: 'currency',
 *   store: true,
 *   ...compute('sale.order', 'amountTotal', ['lines.subtotal', 'taxRate'], (orders) => {
 *     for (const o of orders) o.amountTotal = o.lines.sum('subtotal', o.currency).times(o.taxRate.plus(1));
 *   }),
 * }),
 * ```
 *
 * At runtime the helpers return their callbacks unchanged; only the types differ.
 */
import { type DataRecord, override, record, ref } from '../data/data.js';
import type { Env } from '../env/env.js';
import type {
  ComputedKeys,
  ComputeSet,
  CreateValues,
  DefaultLoaded,
  Draft,
  Merge,
  ModelName,
  RecordSet,
  RelKeys,
  Target,
  WriteValues,
} from '../recordset/types.js';
import type { ComputeFn } from './field.js';
import type { Id } from './id.js';
import type { OnchangeFn } from './model.js';

type NoRels = Record<never, never>;

/** The loaded shape one `depends` path guarantees: `'lines.subtotal'` loads `lines` with `subtotal`. */
export type PathLoaded<
  S,
  M extends ModelName<S>,
  P extends string,
> = P extends `${infer H}.${infer R}`
  ? H extends RelKeys<S, M>
    ? {
        readonly s: 'id';
        readonly r: { readonly [K in H]: PathLoaded<S, Target<S, M, K> & ModelName<S>, R> };
      }
    : { readonly s: 'id'; readonly r: NoRels }
  : P extends RelKeys<S, M>
    ? {
        readonly s: 'id';
        readonly r: { readonly [K in P]: DefaultLoaded<S, Target<S, M, K> & ModelName<S>> };
      }
    : { readonly s: P | 'id'; readonly r: NoRels };

/** The records' loaded shape from their `depends` paths: the defaults plus every path. */
export type LoadedFrom<
  S,
  M extends ModelName<S>,
  D extends readonly string[],
  Acc = DefaultLoaded<S, M>,
> = D extends readonly [infer H extends string, ...infer T extends readonly string[]]
  ? LoadedFrom<S, M, T, Merge<Acc, PathLoaded<S, M, H>>>
  : Acc;

type NoMethods = Record<never, never>;

/**
 * `S` with every model's methods left out. The generated view takes methods from the module's own type, so callback
 * records that carried methods would make each definition depend on itself (TS7022). Recordsets in callbacks
 * therefore have fields and the recordset API but not the model's methods; `method()` bodies have them.
 */
export type PlainView<S> = {
  readonly [M in keyof S]: Omit<S[M], 'methods'> & { readonly methods: NoMethods };
};

type Records<S, M extends ModelName<S>, L = DefaultLoaded<S, M>> = RecordSet<S, M, L>;

/** The helpers `definitions<View>()` returns; generated bindings export them bound to the module's view. */
export interface DefinitionHelpers<S, P = PlainView<S>> {
  /**
   * A compute: the records are loaded along `depends`, and only the `assigns` fields are writable (other computed
   * fields read with their read type). Spread the result into the field options.
   */
  compute<
    const M extends ModelName<S> & ModelName<P>,
    const A extends ComputedKeys<P, M>,
    const D extends readonly string[],
  >(
    model: M,
    assigns: A | readonly A[],
    depends: D,
    fn: (records: ComputeSet<P, M, LoadedFrom<P, M, D>, A>) => void | Promise<void>,
  ): { readonly depends: D; readonly compute: ComputeFn };
  /** A constraint check: returns the failing records. Spread the result into the constraint, next to `message`. */
  check<const M extends ModelName<S> & ModelName<P>, const D extends readonly string[]>(
    model: M,
    depends: D,
    fn: (records: Records<P, M, LoadedFrom<P, M, D>>) => unknown,
  ): { readonly depends: D; readonly check: (records: never) => unknown };
  /** An onchange handler with a typed draft. */
  onchange<const M extends ModelName<S> & ModelName<P>>(
    model: M,
    fn: (draft: Draft<P, M>, env: Env<P>) => void | Promise<void>,
  ): OnchangeFn;
  /** A records callback: transition guards and events, constraint messages. */
  records<const M extends ModelName<S> & ModelName<P>>(
    model: M,
    fn: (records: Records<P, M>) => unknown,
  ): (records: never) => unknown;
  /** A data record the module ships (RFC 0017), typed like a create. */
  record<const M extends ModelName<S> & ModelName<P>>(
    model: M,
    name: string,
    values: CreateValues<P, M>,
    options?: { readonly noupdate?: boolean },
  ): DataRecord;
  /** Updates a dependency's data record (`'base.main_company'`), typed like a write. */
  override<const M extends ModelName<S> & ModelName<P>>(
    model: M,
    id: string,
    values: WriteValues<P, M>,
  ): DataRecord;
  /** A reference to a data record: an id of `model` in data values. */
  ref<const M extends ModelName<S>>(model: M, id: string): Id<M>;
  /**
   * A model method: `this` is the recordset it is called on, with the model's methods. Annotate the return type
   * (TypeScript must not infer it from the body, which would need the methods' own types).
   */
  method<const M extends ModelName<S>, A extends unknown[], R>(
    model: M,
    fn: (this: Records<S, M>, ...args: A) => R,
  ): (this: unknown, ...args: A) => R;
  /**
   * A model method that runs with extra grants (RFC 0014 §7.9): what it touches beyond the caller's rights is
   * declared here, and each call is audited (`elevate`). `reason` defaults to `'<model>.<method>'`.
   *
   * ```ts
   * createInvoices: method('sale.order', { elevate: ['sale.order.line:read'] }, async function (): Promise<...> { ... }),
   * ```
   */
  method<const M extends ModelName<S>, A extends unknown[], R>(
    model: M,
    options: { readonly elevate: readonly string[]; readonly reason?: string },
    fn: (this: Records<S, M>, ...args: A) => Promise<R>,
  ): (this: unknown, ...args: A) => Promise<R>;
}

/** Helpers that type definition callbacks against a schema view (normally the generated one). */
export function definitions<S>(): DefinitionHelpers<S> {
  return {
    compute: (_model, _assigns, depends, fn) => ({ depends, compute: fn as unknown as ComputeFn }),
    check: (_model, depends, fn) => ({
      depends,
      check: fn as unknown as (records: never) => unknown,
    }),
    onchange: (_model, fn) => fn as unknown as OnchangeFn,
    record: (model, name, values, options) =>
      record(model, name, values as Readonly<Record<string, unknown>>, options),
    override: (model, id, values) =>
      override(model, id, values as Readonly<Record<string, unknown>>),
    ref: (model, id) => ref(model, id),
    records: (_model, fn) => fn as unknown as (records: never) => unknown,
    method: ((model: string, second: unknown, third?: unknown) => {
      if (typeof second === 'function') return second;
      const { elevate, reason } = second as { elevate: readonly string[]; reason?: string };
      const fn = third as (this: unknown, ...args: unknown[]) => Promise<unknown>;
      return async function (this: unknown, ...args: unknown[]): Promise<unknown> {
        const records = this as { readonly env: Env<S>; readonly ids: readonly number[] };
        return records.env.withGrants(
          { grants: elevate, reason: reason ?? `${model}.${fn.name || 'method'}` },
          (env) =>
            fn.call(
              (env as unknown as Env<Record<string, unknown>>).model(model).browse(records.ids),
              ...args,
            ),
        );
      };
    }) as DefinitionHelpers<S>['method'],
  };
}
