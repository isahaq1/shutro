/**
 * The three faces of a fields record (RFC 0001 §7.3):
 * - `ReadOf`: what a record exposes. `T` when required, else `T | null`. Null is the only empty value.
 * - `CreateOf`: what `create()` accepts. Readonly and computed fields are absent; required fields without a
 *   default are mandatory; everything else is optional.
 * - `WriteOf`: what `write()` accepts. Same exclusions, all optional.
 */
import type { FieldFlags, FieldTypes } from './field.js';

type TypesOf<F> = F extends { readonly '~types'?: infer T } ? NonNullable<T> : never;
type Flags<F> = TypesOf<F> extends FieldTypes<unknown, unknown, infer Fl> ? Fl : FieldFlags;
type Read<F> = TypesOf<F> extends FieldTypes<infer R, unknown, FieldFlags> ? R : never;
type Write<F> = TypesOf<F> extends FieldTypes<unknown, infer W, FieldFlags> ? W : never;

type Required<F> = Flags<F>['required'] extends true ? true : false;
type Writable<F> = Flags<F>['readonly'] extends true ? false : true;
type Mandatory<F> =
  Required<F> extends true
    ? Flags<F>['hasDefault'] extends true
      ? false
      : Flags<F>['sequence'] extends true
        ? false
        : true
    : false;

type WriteValue<F> = Required<F> extends true ? Write<F> : Write<F> | null;

/** Flattens an intersection into one object type (readable hovers and exact `toEqualTypeOf`). */
type Simplify<T> = { [K in keyof T]: T[K] } & NonNullable<unknown>;

/** The read face of a fields record. */
export type ReadOf<Fs> = {
  readonly [K in keyof Fs]: Required<Fs[K]> extends true ? Read<Fs[K]> : Read<Fs[K]> | null;
};

/** The create face of a fields record. */
export type CreateOf<Fs> = Simplify<
  {
    readonly [K in keyof Fs as Writable<Fs[K]> extends true
      ? Mandatory<Fs[K]> extends true
        ? K
        : never
      : never]: WriteValue<Fs[K]>;
  } & {
    readonly [K in keyof Fs as Writable<Fs[K]> extends true
      ? Mandatory<Fs[K]> extends true
        ? never
        : K
      : never]?: WriteValue<Fs[K]>;
  }
>;

/** The write face of a fields record. */
export type WriteOf<Fs> = {
  readonly [K in keyof Fs as Writable<Fs[K]> extends true ? K : never]?: WriteValue<Fs[K]>;
};
