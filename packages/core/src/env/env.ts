import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Driver,
  type DriverConnection,
  type DriverQuery,
  isRetryable,
  type Row,
} from '@shutro/driver-pg';
import { compile, sql as sqlTag } from '@shutro/sql';
import {
  CompanyNotAllowedError,
  ConcurrentUpdateError,
  FlagNotAllowedError,
  NoEnvironmentError,
  NoRegistryError,
  TransactionScopeError,
} from '../errors.js';
import { createRecordCache, modelRef, type RecordCache } from '../recordset/recordset.js';
import type { ModelName, ModelRef } from '../recordset/types.js';
import type { Registry } from '../registry/registry.js';
import {
  assertLang,
  assertReason,
  type Identity,
  type ResolvedIdentity,
  resolveIdentity,
} from './identity.js';
import { assertTimeZone, calendarDateIn } from './time.js';

/** Typed context flags (RFC 0003 §7.4). Module-contributed flags arrive with the registry's second half. */
export interface Flags {
  /** Searches hide archived records. Default `true`. */
  readonly activeTest: boolean;
  /** Audit / tracking messages are written. Default `true` (imports may turn it off). */
  readonly tracking: boolean;
  /** Multi-company consistency checks and scoping. Default `true`; only a superuser environment may disable it. */
  readonly checkCompany: boolean;
}

const DEFAULT_FLAGS: Flags = Object.freeze({
  activeTest: true,
  tracking: true,
  checkCompany: true,
});

/** A function registered with {@link Env.afterCommit} or {@link Env.onRollback}. */
export type Hook = () => void | Promise<void>;

/** Options of {@link Shutro.run}: the identity plus per-run transaction settings. */
export interface RunOptions extends Identity {
  /** `BEGIN … READ ONLY`. Reports and replica-safe work. */
  readonly readOnly?: boolean;
  /** `false` disables automatic retries, e.g. for handlers that stream a response (RFC 0003 Q1). */
  readonly retry?: false;
}

/** Query statistics of the current attempt. */
export interface ScopeStats {
  readonly queries: number;
}

/** A transaction or savepoint. */
interface Scope {
  readonly root: RootScope;
  readonly parent: Scope | undefined;
  readonly conn: DriverConnection;
  status: 'open' | 'committed' | 'rolled-back';
  env: Env;
  readonly afterCommit: Hook[];
  readonly onRollback: Hook[];
}

interface RootScope {
  /** The innermost open scope: the only one whose env may run statements. */
  top: Scope;
  readonly attempt: number;
  readonly now: Date;
  queries: number;
  /** Identity map and value-object caches (RFC 0004 §7.4), shared by the savepoints of this attempt. */
  readonly cache: RecordCache;
}

interface Runtime {
  readonly als: AsyncLocalStorage<Scope>;
  readonly onHookError: (error: unknown, phase: 'afterCommit' | 'onRollback') => void;
  readonly registry: Registry | undefined;
}

/** @internal What the recordset runtime needs from an environment. */
export interface ScopeInternals {
  readonly registry: Registry;
  readonly cache: RecordCache;
  query<R extends Row>(query: DriverQuery): Promise<readonly R[]>;
}

const internals = new WeakMap<object, () => ScopeInternals>();

/** @internal */
export function internalsOf(env: Env): ScopeInternals {
  const get = internals.get(env);
  if (get === undefined) throw new NoEnvironmentError();
  return get();
}

async function runHooks(
  hooks: readonly Hook[],
  runtime: Runtime,
  phase: 'afterCommit' | 'onRollback',
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      runtime.onHookError(error, phase);
    }
  }
}

/**
 * The environment (RFC 0003): who is acting, for which company, how, and in which transaction. Immutable; the
 * `with*` methods return derived environments that share the transaction scope. `S` is the schema view of the
 * registry (model name → model), which types `model()`.
 */
export class Env<S = unknown> {
  /** Id of the acting user. */
  readonly uid: number;
  /** Current company id. */
  readonly companyId: number;
  /** Allowed company ids (record-rule scope). */
  readonly companyIds: readonly number[];
  readonly lang: string;
  readonly tz: string;
  /** Superuser mode: only inside {@link asSuperuser}. */
  readonly su: boolean;
  /** Reason for a job or superuser scope, when given. */
  readonly reason: string | undefined;
  readonly flags: Flags;
  /** 1 for the first attempt of `run()`, 2+ for retries after a serialization failure or deadlock. */
  readonly attempt: number;
  readonly readOnly: boolean;

  readonly #scope: Scope;
  readonly #runtime: Runtime;

  /** @internal */
  constructor(
    identity: ResolvedIdentity & {
      readonly su: boolean;
      readonly flags: Flags;
      readonly readOnly: boolean;
    },
    scope: Scope,
    runtime: Runtime,
  ) {
    this.uid = identity.uid;
    this.companyId = identity.companyId;
    this.companyIds = identity.companyIds;
    this.lang = identity.lang;
    this.tz = identity.tz;
    this.su = identity.su;
    this.reason = identity.reason;
    this.flags = identity.flags;
    this.readOnly = identity.readOnly;
    this.attempt = scope.root.attempt;
    this.#scope = scope;
    this.#runtime = runtime;
    internals.set(this, () => {
      this.#assertUsable();
      const registry = runtime.registry;
      if (registry === undefined) throw new NoRegistryError();
      return { registry, cache: scope.root.cache, query: (q) => this.#query(q) };
    });
    Object.freeze(this);
  }

  /** An empty recordset of `name`: `search()` / `browse()` start here (RFC 0004). */
  model<M extends ModelName<S>>(name: M): ModelRef<S, M> {
    if (this.#runtime.registry === undefined) throw new NoRegistryError();
    this.#assertUsable();
    // The runtime is untyped over S; widening here is safe because it never reads S.
    return modelRef(this as unknown as Env, name) as unknown as ModelRef<S, M>;
  }

  /** The transaction timestamp (PostgreSQL `now()`), stable within an attempt. Returns a fresh `Date` each call. */
  now(): Date {
    return new Date(this.#scope.root.now.getTime());
  }

  /** Today's calendar date (`'YYYY-MM-DD'`) in the environment's time zone. */
  today(): string {
    return calendarDateIn(this.#scope.root.now, this.tz);
  }

  /** Today's calendar date in another time zone. */
  todayIn(tz: string): string {
    return calendarDateIn(this.#scope.root.now, tz);
  }

  /** Statistics of the current attempt (query counts for N+1 assertions, RFC 0004 §7.9). */
  stats(): ScopeStats {
    return { queries: this.#scope.root.queries };
  }

  /**
   * Raw SQL in this transaction (RFC 0005 §7.8): values become parameters, identifiers go through `sql.id()`.
   * Rejects with {@link TransactionScopeError} when the scope has ended or another scope is active.
   */
  sql<R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly R[]> {
    return (async () => {
      this.#assertUsable();
      return this.#query<R>(compile(sqlTag(strings, ...values)));
    })();
  }

  /** Runs `fn` in a savepoint: its work (and its hooks) are discarded if it throws, kept otherwise. */
  async transaction<T>(fn: (env: Env<S>) => Promise<T>): Promise<T> {
    this.#assertUsable();
    const parent = this.#scope;
    const root = parent.root;
    let child: Scope | undefined;
    try {
      const result = await parent.conn.savepoint(async (conn) => {
        const scope: Scope = {
          root,
          parent,
          conn,
          status: 'open',
          env: this as unknown as Env,
          afterCommit: [],
          onRollback: [],
        };
        scope.env = this.#derive({}, scope) as unknown as Env;
        child = scope;
        root.top = scope;
        return this.#runtime.als.run(scope, () => fn(scope.env as Env<S>));
      });
      if (child !== undefined) {
        child.status = 'committed';
        parent.afterCommit.push(...child.afterCommit);
        parent.onRollback.push(...child.onRollback);
      }
      return result;
    } catch (error) {
      if (child !== undefined) {
        child.status = 'rolled-back';
        await runHooks(child.onRollback, this.#runtime, 'onRollback');
      }
      throw error;
    } finally {
      root.top = parent;
    }
  }

  /** Registers work to run only after the outermost transaction commits (emails, webhooks, queue messages). */
  afterCommit(hook: Hook): void {
    this.#assertUsable();
    this.#scope.afterCommit.push(hook);
  }

  /** Registers work to run if this scope rolls back (cleanup of external resources). */
  onRollback(hook: Hook): void {
    this.#assertUsable();
    this.#scope.onRollback.push(hook);
  }

  /** The same scope with another current company. Must be allowed unless `su`. @throws {CompanyNotAllowedError} */
  withCompany(company: number): Env<S> {
    if (!this.su && !this.companyIds.includes(company))
      throw new CompanyNotAllowedError(company, this.companyIds);
    const companyIds = this.companyIds.includes(company)
      ? this.companyIds
      : Object.freeze([...this.companyIds, company]);
    return this.#derive({ companyId: company, companyIds });
  }

  /** The same scope with another language. */
  withLang(lang: string): Env<S> {
    return this.#derive({ lang: assertLang(lang) });
  }

  /** The same scope with another time zone. */
  withTz(tz: string): Env<S> {
    assertTimeZone(tz);
    return this.#derive({ tz });
  }

  /** The same scope with some flags changed. `checkCompany: false` needs `su`. @throws {FlagNotAllowedError} */
  withFlags(flags: Partial<Flags>): Env<S> {
    if (flags.checkCompany === false && !this.su) throw new FlagNotAllowedError('checkCompany');
    return this.#derive({ flags: Object.freeze({ ...this.flags, ...flags }) });
  }

  /**
   * Runs `fn` with a superuser environment in the same scope. The elevation never leaks: only `su` and values
   * returned by `fn` leave the callback, and `reason` is recorded for the audit trail (RFC 0003 §7.6).
   */
  async asSuperuser<T>(
    options: { readonly reason: string },
    fn: (su: Env<S>) => Promise<T>,
  ): Promise<T> {
    const reason = assertReason(options.reason);
    this.#assertUsable();
    return fn(this.#derive({ su: true, reason }));
  }

  async #query<R extends Row>(query: DriverQuery): Promise<readonly R[]> {
    this.#scope.root.queries++;
    return this.#scope.conn.query<R>(query);
  }

  #derive(
    changes: Partial<ResolvedIdentity & { su: boolean; flags: Flags; readOnly: boolean }>,
    scope: Scope = this.#scope,
  ): Env<S> {
    return new Env<S>(
      {
        uid: this.uid,
        companyId: this.companyId,
        companyIds: this.companyIds,
        lang: this.lang,
        tz: this.tz,
        reason: this.reason,
        su: this.su,
        flags: this.flags,
        readOnly: this.readOnly,
        ...changes,
      },
      scope,
      this.#runtime,
    );
  }

  #assertUsable(): void {
    const scope = this.#scope;
    if (scope.status !== 'open') {
      throw new TransactionScopeError(
        `This environment belongs to a transaction that already ${scope.status === 'committed' ? 'committed' : 'rolled back'}.`,
        'Do not keep environments or records across requests; start a new shutro.run() and re-browse the records inside it.',
      );
    }
    if (scope.root.top !== scope) {
      throw new TransactionScopeError(
        'A nested transaction (savepoint) is active on this connection.',
        'Use the env passed to env.transaction(fn) inside the callback; the outer env becomes usable again when it ends.',
      );
    }
    const active = this.#runtime.als.getStore();
    if (active !== undefined && active.root !== scope.root) {
      throw new TransactionScopeError(
        'This environment belongs to a different transaction than the one running here.',
        'Pass data, not environments or records, between transactions; re-browse records in the current shutro.run().',
      );
    }
  }
}

/** Options of {@link createShutro}. */
export interface ShutroOptions<S> {
  readonly driver: Driver;
  /** The registry built from the application's modules. Without it, `env.model()` is unavailable. */
  readonly registry?: Registry<S>;
  /** Retry policy for serialization failures and deadlocks. Default: 5 attempts with jittered exponential backoff. */
  readonly retry?: {
    readonly attempts?: number;
    /** Delay before attempt `attempt` (2+), in milliseconds. */
    readonly backoffMs?: (attempt: number) => number;
  };
  /**
   * Called when an `afterCommit` / `onRollback` hook throws (the transaction outcome is already decided, so the
   * error cannot be surfaced to the caller). Defaults to `process.emitWarning`.
   */
  readonly onHookError?: (error: unknown, phase: 'afterCommit' | 'onRollback') => void;
}

/** A Shutro instance: one driver, one registry, one AsyncLocalStorage. No global state (`CLAUDE.md`). */
export interface Shutro<S = unknown> {
  /**
   * Runs `fn` in one transaction with the given identity (RFC 0003 §7.1): `REPEATABLE READ`, identity pushed as
   * `SET LOCAL` settings (`shutro.user_id`, `shutro.company_ids`), `TimeZone = UTC`. Commits when `fn` resolves,
   * rolls back when it throws. Serialization failures and deadlocks re-run `fn` from scratch with a fresh scope
   * (so `fn` must have no side effects outside the database; use `env.afterCommit`).
   *
   * @throws {InvalidIdentityError} before any transaction starts.
   * @throws {ConcurrentUpdateError} when every attempt conflicted.
   */
  run<T>(options: RunOptions, fn: (env: Env<S>) => Promise<T>): Promise<T>;
  /** The environment of the innermost active scope. @throws {NoEnvironmentError} outside `run()`. */
  currentEnv(): Env<S>;
}

const defaultBackoff = (attempt: number): number =>
  Math.min(1_000, 25 * 2 ** attempt) * (0.5 + Math.random());

const defaultHookError = (error: unknown, phase: string): void => {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`Shutro ${phase} hook failed: ${message}`, { code: 'SHUTRO_HOOK_FAILED' });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a {@link Shutro} instance on a driver (and a registry). */
export function createShutro<S = unknown>(options: ShutroOptions<S>): Shutro<S> {
  const attempts = options.retry?.attempts ?? 5;
  const backoff = options.retry?.backoffMs ?? defaultBackoff;
  const runtime: Runtime = {
    als: new AsyncLocalStorage<Scope>(),
    onHookError: options.onHookError ?? defaultHookError,
    registry: options.registry as Registry | undefined,
  };
  const NOW = compile(sqlTag`SELECT now() AS now`);

  return {
    async run<T>(runOptions: RunOptions, fn: (env: Env<S>) => Promise<T>): Promise<T> {
      const identity = resolveIdentity(runOptions);
      const maxAttempts = runOptions.retry === false ? 1 : attempts;
      for (let attempt = 1; ; attempt++) {
        let scope: Scope | undefined;
        try {
          const result = await options.driver.transaction(
            {
              isolation: 'repeatable read',
              readOnly: runOptions.readOnly ?? false,
              settings: {
                'shutro.user_id': String(identity.uid),
                'shutro.company_ids': `{${identity.companyIds.join(',')}}`,
                timezone: 'UTC',
              },
            },
            async (conn) => {
              const [row] = await conn.query<{ now: Date }>(NOW);
              const root: RootScope = {
                top: undefined as unknown as Scope,
                attempt,
                now: row?.now ?? new Date(),
                queries: 0,
                cache: createRecordCache(),
              };
              const s: Scope = {
                root,
                parent: undefined,
                conn,
                status: 'open',
                env: undefined as unknown as Env,
                afterCommit: [],
                onRollback: [],
              };
              root.top = s;
              s.env = new Env<unknown>(
                {
                  ...identity,
                  su: false,
                  flags: DEFAULT_FLAGS,
                  readOnly: runOptions.readOnly ?? false,
                },
                s,
                runtime,
              );
              scope = s;
              return runtime.als.run(s, () => fn(s.env as Env<S>));
            },
          );
          if (scope !== undefined) {
            scope.status = 'committed';
            await runHooks(scope.afterCommit, runtime, 'afterCommit');
          }
          return result;
        } catch (error) {
          if (scope !== undefined) {
            scope.status = 'rolled-back';
            await runHooks(scope.onRollback, runtime, 'onRollback');
          }
          if (!isRetryable(error)) throw error;
          if (attempt >= maxAttempts) {
            if (maxAttempts === 1) throw error;
            throw new ConcurrentUpdateError(attempt, error);
          }
          await sleep(backoff(attempt + 1));
        }
      }
    },

    currentEnv(): Env<S> {
      const scope = runtime.als.getStore();
      if (scope === undefined) throw new NoEnvironmentError();
      return scope.env as Env<S>;
    },
  };
}
