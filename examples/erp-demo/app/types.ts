/**
 * The application's schema, for code outside the modules (tests, scripts). Modules type their definition callbacks
 * through their generated bindings (`modules/<name>/.shutro/bindings.ts`, `shutro generate`), with no casts.
 */
import type { Env as CoreEnv } from '@shutro/core';
import type { registry } from './registry.ts';

export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
export type ModelName = keyof S & string;
export type Env = CoreEnv<S>;
