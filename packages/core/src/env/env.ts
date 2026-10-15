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
import { createFx, type Fx } from '../money/fx.js';
import { invalidateCached } from '../recordset/compute.js';
import {
  companyCurrencyId,
  createRecordCache,
  currencyById,
  flushAll,
  modelRef,
  type RecordCache,
} from '../recordset/recordset.js';
import { mapConstraintError } from '../recordset/sqlErrors.js';
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

/** An undo record for savepoint rollback (RFC 0004 §7.6). */
export type JournalEntry =
  | {
      readonly kind: 'value';
      readonly model: string;
      readonly id: number;
      readonly key: string;
      readonly had: boolean;
      readonly prev: unknown;
      readonly wasDirty: boolean;
    }
  | { readonly kind: 'created'; readonly model: string; readonly id: number }
  | {
      readonly kind: 'deleted';
      readonly model: string;
      readonly id: number;
      readonly values: Map<string, unknown>;
      readonly dirty: Set<string> | undefined;
    };

/** A transaction or savepoint. */
interface Scope {
  readonly root: RootScope;
  readonly parent: Scope | undefined;
  readonly conn: DriverConnection;
  status: 'open' | 'committed' | 'rolled-back';
  env: Env;
  readonly afterCommit: Hook[];
  readonly onRollback: Hook[];
  /** Cache changes made in this savepoint, for undo; `undefined` for the root transaction. */
  readonly journal: JournalEntry[] | undefined;
}

interface RootScope {
  /** The innermost open scope: the only one whose env may run statements. */
  top: Scope;
  readonly attempt: number;
  readonly now: Date;
  queries: number;
  /** Identity map and value-object caches (RFC 0004 §7.4), shared by the savepoints of this attempt. */
  readonly cache: RecordCache;
  /** Unit of work: model → id → dirty field keys. */
  readonly dirty: Map<string, Map<number, Set<string>>>;
  /** Raw compute triggers: model → key → changed ids (RFC 0008 §7.2). */
  readonly triggers: Map<string, Map<string, Set<number>>>;
  /** Records marked for computation directly (new records): model → key → ids. */
  readonly toCompute: Map<string, Map<string, Set<number>>>;
  /** Records to check: model → constraint key → ids (RFC 0009 §7.1). */
  readonly toCheck: Map<string, Map<string, Set<number>>>;
  readonly compute: ComputeState;
  /** Next virtual id for drafts (negative, RFC 0009 §7.4). */
  virtual: number;
  readonly uid: number;
}

/** Compute-engine state of an attempt (RFC 0008 §7.3, §7.5). */
export interface ComputeState {
  recomputing: boolean;
  /** `model.key` names being computed right now (assignment is allowed for them). */
  readonly computing: Set<string>;
  /** `model.key` → ids computed in the current round: invalidation and re-triggering skip them. */
  readonly protected: Map<string, Set<number>>;
}

interface Runtime {
  readonly als: AsyncLocalStorage<Scope>;
  readonly onHookError: (error: unknown, phase: 'afterCommit' | 'onRollback') => void;
  readonly registry: Registry | undefined;
  /** The language translations fall back to (RFC 0011). */
  readonly sourceLang: string;
}

/** @internal What the recordset runtime needs from an environment. */
export interface ScopeInternals {
  readonly env: Env;
  readonly registry: Registry;
  readonly cache: RecordCache;
  readonly uid: number;
  readonly now: Date;
  query<R extends Row>(query: DriverQuery): Promise<readonly R[]>;
  /** Records an undo entry when a savepoint is active. */
  journal(entry: JournalEntry): void;
  markDirty(model: string, id: number, key: string): void;
  isDirty(model: string, id: number, key: string): boolean;
  dirtyFields(model: string, id: number): Set<string> | undefined;
  dirtyModels(): string[];
  /** Removes and returns the dirty map of a model. */
  takeDirty(model: string): Map<number, Set<string>> | undefined;
  /** Drops a record from the cache and the unit of work. */
  forget(model: string, id: number): void;
  cachedValues(model: string): Iterable<Map<string, unknown>>;
  readonly sourceLang: string;
  flush(model?: string): Promise<void>;
  /** Records that `(model, key)` changed for `ids` and invalidates cached dependents (RFC 0008 §7.2). */
  trigger(model: string, key: string, ids: readonly number[]): void;
  /** Marks `ids` for computation of the stored computed field `key` (new records). */
  markToCompute(model: string, key: string, ids: readonly number[]): void;
  takeTriggers(): Map<string, Map<string, Set<number>>>;
  takeToCompute(): Map<string, Map<string, Set<number>>>;
  hasPending(): boolean;
  takeToCheck(): Map<string, Map<string, Set<number>>>;
  hasChecks(): boolean;
  /** A fresh negative id for a draft record (RFC 0009 §7.4). */
  nextVirtualId(): number;
  readonly compute: ComputeState;
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
  /** The language translatable fields fall back to when `lang` has no text (RFC 0011). */
  readonly sourceLang: string;
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
    this.sourceLang = runtime.sourceLang;
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
      return scopeInternals(this as unknown as Env, scope, registry, (q) => this.#query(q));
    });
    Object.freeze(this);
  }

  /** An empty recordset of `name`: `search()` / `browse()` / `create()` start here (RFC 0004). */
  model<M extends ModelName<S>>(name: M): ModelRef<S, M> {
    if (this.#runtime.registry === undefined) throw new NoRegistryError();
    this.#assertUsable();
    // The runtime is untyped over S; widening here is safe because it never reads S.
    return modelRef(this as unknown as Env, name) as unknown as ModelRef<S, M>;
  }

  /** Dated, per-company currency conversion (RFC 0006 §7.6). Needs a `res.currency.rate` model. */
  get fx(): Fx {
    const scope = internalsOf(this as unknown as Env);
    return createFx({
      internals: scope,
      currency: (id) => currencyById(scope, id),
      companyCurrency: async (company) =>
        currencyById(scope, await companyCurrencyId(scope, company)),
    });
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

  /** Writes every pending change of the unit of work to the database now (RFC 0004 §7.6). */
  async flush(): Promise<void> {
    if (this.#runtime.registry === undefined) return;
    await flushAll(internalsOf(this as unknown as Env));
  }

  /** Statistics of the current attempt (query counts for N+1 assertions, RFC 0004 §7.9). */
  stats(): ScopeStats {
    return { queries: this.#scope.root.queries };
  }

  /**
   * Raw SQL in this transaction (RFC 0005 §7.8): values become parameters, identifiers go through `sql.id()`.
   * Pending writes are flushed first. Rejects with {@link TransactionScopeError} when the scope has ended or
   * another scope is active.
   */
  sql<R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly R[]> {
    return (async () => {
      this.#assertUsable();
      await this.flush();
      return this.#query<R>(compile(sqlTag(strings, ...values)));
    })();
  }

  /**
   * Runs `fn` in a savepoint: its database work and its cache changes are undone if it throws, kept otherwise.
   * Pending writes are flushed before the savepoint is released.
   */
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
          journal: [],
        };
        scope.env = this.#derive({}, scope) as unknown as Env;
        child = scope;
        root.top = scope;
        return this.#runtime.als.run(scope, async () => {
          const value = await fn(scope.env as Env<S>);
          await scope.env.flush();
          return value;
        });
      });
      if (child !== undefined) {
        child.status = 'committed';
        parent.afterCommit.push(...child.afterCommit);
        parent.onRollback.push(...child.onRollback);
        if (parent.journal !== undefined && child.journal !== undefined)
          parent.journal.push(...child.journal);
      }
      return result;
    } catch (error) {
      if (child !== undefined) {
        child.status = 'rolled-back';
        if (child.journal !== undefined) undo(child.journal, root);
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

function scopeInternals(
  env: Env,
  scope: Scope,
  registry: Registry,
  query: <R extends Row>(q: DriverQuery) => Promise<readonly R[]>,
): ScopeInternals {
  const root = scope.root;
  const dirtyOf = (model: string, id: number): Set<string> | undefined =>
    root.dirty.get(model)?.get(id);
  const addIds = (
    sets: Map<string, Map<string, Set<number>>>,
    model: string,
    key: string,
    ids: readonly number[],
  ): void => {
    let byKey = sets.get(model);
    if (byKey === undefined) {
      byKey = new Map();
      sets.set(model, byKey);
    }
    let set = byKey.get(key);
    if (set === undefined) {
      set = new Set();
      byKey.set(key, set);
    }
    for (const id of ids) set.add(id);
  };
  const self: ScopeInternals = {
    env,
    registry,
    cache: root.cache,
    uid: root.uid,
    now: root.now,
    query: async <R extends Row>(q: DriverQuery): Promise<readonly R[]> => {
      try {
        return await query<R>(q);
      } catch (error) {
        throw mapConstraintError(registry, error);
      }
    },
    journal(entry) {
      root.top.journal?.push(entry);
    },
    markDirty(model, id, key) {
      let byId = root.dirty.get(model);
      if (byId === undefined) {
        byId = new Map();
        root.dirty.set(model, byId);
      }
      let fields = byId.get(id);
      if (fields === undefined) {
        fields = new Set();
        byId.set(id, fields);
      }
      fields.add(key);
    },
    isDirty: (model, id, key) => dirtyOf(model, id)?.has(key) ?? false,
    dirtyFields: (model, id) => {
      const fields = dirtyOf(model, id);
      return fields === undefined ? undefined : new Set(fields);
    },
    dirtyModels: () => [...root.dirty.keys()],
    takeDirty(model) {
      const byId = root.dirty.get(model);
      root.dirty.delete(model);
      return byId;
    },
    forget(model, id) {
      root.cache.records.get(model)?.delete(id);
      root.dirty.get(model)?.delete(id);
      for (const sets of [root.triggers, root.toCompute, root.toCheck])
        for (const set of sets.get(model)?.values() ?? []) set.delete(id);
    },
    cachedValues: (model) => root.cache.records.get(model)?.values() ?? [],
    sourceLang: env.sourceLang,
    flush: (model) => flushAll(internalsOf(env), model),
    trigger(model, key, ids) {
      if (ids.length === 0) return;
      addIds(root.triggers, model, key, ids);
      for (const c of registry.compute.constraints(model, key))
        addIds(root.toCheck, model, c.key, ids);
      invalidateCached(self, model, key, ids);
    },
    markToCompute: (model, key, ids) => addIds(root.toCompute, model, key, ids),
    takeTriggers() {
      const taken = new Map(root.triggers);
      root.triggers.clear();
      return taken;
    },
    takeToCompute() {
      const taken = new Map(root.toCompute);
      root.toCompute.clear();
      return taken;
    },
    hasPending: () => root.triggers.size > 0 || root.toCompute.size > 0,
    takeToCheck() {
      const taken = new Map(root.toCheck);
      root.toCheck.clear();
      return taken;
    },
    hasChecks: () => root.toCheck.size > 0,
    nextVirtualId: () => root.virtual--,
    compute: root.compute,
  };
  return self;
}

/** Reverts a rolled-back savepoint's cache changes, newest first. */
function undo(journal: readonly JournalEntry[], root: RootScope): void {
  const valuesOf = (model: string, id: number): Map<string, unknown> => {
    let byId = root.cache.records.get(model);
    if (byId === undefined) {
      byId = new Map();
      root.cache.records.set(model, byId);
    }
    let values = byId.get(id);
    if (values === undefined) {
      values = new Map();
      byId.set(id, values);
    }
    return values;
  };
  const setDirty = (model: string, id: number, key: string, dirty: boolean): void => {
    const byId = root.dirty.get(model);
    if (dirty) {
      if (byId === undefined) root.dirty.set(model, new Map([[id, new Set([key])]]));
      else {
        const fields = byId.get(id);
        if (fields === undefined) byId.set(id, new Set([key]));
        else fields.add(key);
      }
    } else {
      byId?.get(id)?.delete(key);
      if (byId?.get(id)?.size === 0) byId.delete(id);
    }
  };
  for (let i = journal.length - 1; i >= 0; i--) {
    const entry = journal[i];
    if (entry === undefined) continue;
    switch (entry.kind) {
      case 'value': {
        const values = valuesOf(entry.model, entry.id);
        if (entry.had) values.set(entry.key, entry.prev);
        else values.delete(entry.key);
        setDirty(entry.model, entry.id, entry.key, entry.wasDirty);
        break;
      }
      case 'created':
        root.cache.records.get(entry.model)?.delete(entry.id);
        root.dirty.get(entry.model)?.delete(entry.id);
        break;
      case 'deleted': {
        const byId = root.cache.records.get(entry.model) ?? new Map<number, Map<string, unknown>>();
        root.cache.records.set(entry.model, byId);
        byId.set(entry.id, new Map(entry.values));
        if (entry.dirty !== undefined && entry.dirty.size > 0) {
          const dirtyById = root.dirty.get(entry.model) ?? new Map<number, Set<string>>();
          root.dirty.set(entry.model, dirtyById);
          dirtyById.set(entry.id, new Set(entry.dirty));
        }
        break;
      }
    }
  }
}

/** Options of {@link createShutro}. */
export interface ShutroOptions<S> {
  readonly driver: Driver;
  /** The registry built from the application's modules. Without it, `env.model()` is unavailable. */
  readonly registry?: Registry<S>;
  /** The source language of translatable fields: what readers of a language without text see. Default `en_US`. */
  readonly sourceLang?: string;
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
   * `SET LOCAL` settings (`shutro.user_id`, `shutro.company_ids`), `TimeZone = UTC`. Pending writes are flushed
   * before commit. Commits when `fn` resolves, rolls back when it throws. Serialization failures and deadlocks
   * re-run `fn` from scratch with a fresh scope (so `fn` must have no side effects outside the database; use
   * `env.afterCommit`).
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
    sourceLang: assertLang(options.sourceLang ?? 'en_US'),
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
                dirty: new Map(),
                triggers: new Map(),
                toCompute: new Map(),
                toCheck: new Map(),
                virtual: -1,
                compute: { recomputing: false, computing: new Set(), protected: new Map() },
                uid: identity.uid,
              };
              const s: Scope = {
                root,
                parent: undefined,
                conn,
                status: 'open',
                env: undefined as unknown as Env,
                afterCommit: [],
                onRollback: [],
                journal: undefined,
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
              return runtime.als.run(s, async () => {
                const value = await fn(s.env as Env<S>);
                await s.env.flush(); // pre-commit: the unit of work reaches the database
                return value;
              });
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
