/**
 * The untyped face of the ORM the server drives. Model names arrive in URLs, so they are only known at runtime; the
 * ORM still validates every name, field, value and permission, exactly as for typed code.
 */
import type { Env, Perm } from '@shutro/core';

/** A recordset of a model known at runtime. */
export interface DynamicRecords extends Iterable<DynamicRecords> {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec?: readonly string[] | Readonly<Record<string, unknown>>): Promise<DynamicRecords>;
  read(keys: readonly string[]): Record<string, unknown>[];
  write(
    values: Readonly<Record<string, unknown>>,
    options?: { readonly expect?: Readonly<Record<string, unknown>> },
  ): Promise<void>;
  unlink(): Promise<void>;
  trail(options?: {
    readonly limit?: number;
    readonly before?: number;
  }): Promise<readonly unknown[]>;
  transitions(): readonly string[];
}

/** `env.model(name)` of a model known at runtime. */
export interface DynamicModel {
  create(rows: readonly Readonly<Record<string, unknown>>[]): Promise<DynamicRecords>;
  search(query: {
    readonly where?: unknown;
    readonly order?: readonly string[];
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<DynamicRecords>;
  browse(ids: readonly number[]): DynamicRecords;
  onchange(input: {
    readonly id?: number;
    readonly values: Readonly<Record<string, unknown>>;
    readonly changed: readonly string[];
  }): Promise<{ values: Record<string, unknown>; warnings: readonly string[]; children: unknown }>;
  aggregate(query: {
    readonly where?: unknown;
    readonly groupBy?: readonly string[];
    readonly measures: Readonly<Record<string, unknown>>;
    readonly order?: readonly string[];
    readonly limit?: number;
  }): Promise<Record<string, unknown>[]>;
}

/** The environment of a request, untyped over model names. */
export interface DynamicEnv {
  readonly uid: number;
  readonly companyId: number;
  readonly companyIds: readonly number[];
  readonly lang: string;
  readonly tz: string;
  readonly administrator: boolean;
  readonly groups: ReadonlySet<string>;
  model(name: string): DynamicModel;
  readonly access: {
    can(model: string, perm: Perm): boolean;
    canField(model: string, field: string, kind: 'read' | 'write'): boolean;
    has(permission: string): boolean;
  };
  flush(): Promise<void>;
}

/** The one place the typed environment is seen untyped (see the module comment). */
export function dynamic(env: Env): DynamicEnv {
  return env as unknown as DynamicEnv;
}

/** A transition method of a recordset: `records[name]()`. */
export function callTransition(records: DynamicRecords, name: string): Promise<unknown> {
  const fn = (records as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new TypeError(`'${name}' is not callable`);
  return (fn as () => Promise<unknown>).call(records);
}
