import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AuditRowInput } from '@shutro/audit';
import {
  type Driver,
  type DriverConnection,
  type DriverQuery,
  isRetryable,
  type Row,
} from '@shutro/driver-pg';
import type { KeyRing, Perm, RulePerm } from '@shutro/security';
import { InvalidSequenceError } from '@shutro/sequence';
import { compile, sql as sqlTag } from '@shutro/sql';
import { refId } from '../data/load.js';
import {
  AccessError,
  CompanyNotAllowedError,
  ConcurrentUpdateError,
  FlagNotAllowedError,
  InvalidIdentityError,
  NoEnvironmentError,
  NoRegistryError,
  TransactionScopeError,
} from '../errors.js';
import { type EnqueueOptions, emitEvent, enqueueJob, ensureEventTables } from '../events/events.js';
import {
  type DeliveredEvent,
  type RunningJob,
  subscribe,
  type Worker,
  type WorkerHost,
  work,
} from '../events/workers.js';
import type { Id } from '../model/id.js';
import { createFx, type Fx } from '../money/fx.js';
import { trackElevation, trackSecurityChange, trackSuperuser } from '../recordset/audit.js';
import { invalidateCached } from '../recordset/compute.js';
import {
  companyCurrencyId,
  createRecordCache,
  currencyById,
  flushAll,
  modelRef,
  type RecordCache,
} from '../recordset/recordset.js';
import {
  assertAccess,
  assertPermission,
  canAccess,
  canField,
  hasPermission,
} from '../recordset/security.js';
import { mapConstraintError } from '../recordset/sqlErrors.js';
import type { ListLoaded, ModelName, ModelRef, RecordSet } from '../recordset/types.js';
import type { Registry } from '../registry/registry.js';
import {
  administratorCodes,
  changeStatement,
  closureWith,
  isAdministratorWith,
  loadRuntimeSecurity,
  type RuntimeSecurity,
  SECURITY_CHANNEL,
  type SecurityChange,
  validateChange,
} from '../security/runtime.js';
import {
  assertGrants,
  assertLang,
  assertReason,
  type Identity,
  type ResolvedIdentity,
  resolveIdentity,
  SYSTEM_UID,
} from './identity.js';
import type { Inspector } from './inspector.js';
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
  /** Pending audit rows of this attempt (RFC 0013 §7.2). */
  readonly audit: AuditRowInput[];
  /** Groups the audit rows of this attempt. */
  readonly tx: string;
  /** Next virtual id for drafts (negative, RFC 0009 §7.4). */
  virtual: number;
  readonly uid: number;
  /** Set in `env.asOf` scopes: reads see the models with history as they were then; writes are refused. */
  readonly asOf?: Date;
}

/** Compute-engine state of an attempt (RFC 0008 §7.3, §7.5). */
export interface ComputeState {
  recomputing: boolean;
  /** `model.key` names being computed right now (assignment is allowed for them). */
  readonly computing: Set<string>;
  /** `model.key` → ids computed in the current round: invalidation and re-triggering skip them. */
  readonly protected: Map<string, Set<number>>;
  /** `model.key` → id → the value invalidated by a trigger, for the audit row of the recompute (RFC 0013). */
  readonly previous: Map<string, Map<number, unknown>>;
}

interface Runtime {
  readonly als: AsyncLocalStorage<Scope>;
  readonly onHookError: (error: unknown, phase: 'afterCommit' | 'onRollback') => void;
  readonly registry: Registry | undefined;
  /** Dev-mode query inspector, if any. */
  readonly inspector: Inspector | undefined;
  /** The pool, for autonomous transactions (standard sequences, RFC 0012 §7.2). */
  readonly driver: Driver;
  /** Encryption keys for `encrypted` fields (RFC 0014 §7.6), or none. */
  readonly keys: KeyRing | undefined;
  /** The language translations fall back to (RFC 0011). */
  readonly sourceLang: string;
  /** Runtime security (RFC 0014 §7.10): the loaded overlay, when enabled. */
  readonly security: {
    enabled: boolean;
    current: RuntimeSecurity | undefined;
    loading: Promise<void> | undefined;
  };
}

/** @internal What the recordset runtime needs from an environment. */
export interface ScopeInternals {
  readonly env: Env;
  readonly registry: Registry;
  /** Runtime security additions (RFC 0014 §7.10), when enabled. */
  readonly overlay: RuntimeSecurity | undefined;
  /** The instant of an `env.asOf` scope (RFC 0018 §7.4). */
  readonly asOf: Date | undefined;
  readonly cache: RecordCache;
  readonly uid: number;
  readonly now: Date;
  query<R extends Row>(query: DriverQuery): Promise<readonly R[]>;
  /** `COPY ... FROM STDIN` on the scope's connection (RFC 0015 §7.1); returns the row count. */
  copyIn(query: DriverQuery, lines: Iterable<string>): Promise<number>;
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
  readonly driver: Driver;
  readonly keys: KeyRing | undefined;
  /** Pending audit rows (RFC 0013 §7.2). */
  readonly auditRows: AuditRowInput[];
  readonly tx: string;
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

  /** {@link uid} as a `res.users` id, for many2one defaults: `default: (env) => env.userId`. */
  get userId(): Id<'res.users'> {
    return this.uid as Id<'res.users'>;
  }

  /** {@link companyId} as a `res.company` id. */
  get companyRef(): Id<'res.company'> {
    return this.companyId as Id<'res.company'>;
  }

  /** The language translatable fields fall back to when `lang` has no text (RFC 0011). */
  readonly sourceLang: string;
  readonly tz: string;
  /** Superuser mode: only inside {@link asSuperuser}. */
  readonly su: boolean;
  /**
   * The user is in an administrator group (`defineGroup({ administrator: true })`): every ACL, record rule, field
   * group and permission passes, without grants (RFC 0014 §7.9). Company scoping still applies.
   */
  readonly administrator: boolean;
  /** Reason for a job or superuser scope, when given. */
  readonly reason: string | undefined;
  /** The user's security groups, closed over `implies` (RFC 0014 §7.1). */
  readonly groups: ReadonlySet<string>;
  /** Special permissions of this user on top of the roles (`'account.backdate'`, `'account.move:unlink'`). */
  readonly grants: ReadonlySet<string>;
  /** @internal Encryption keys. */
  readonly keys: KeyRing | undefined;
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
    this.groups =
      runtime.registry === undefined
        ? new Set(identity.groups)
        : closureWith(runtime.registry, runtime.security.current, identity.groups);
    this.administrator =
      runtime.registry !== undefined &&
      isAdministratorWith(runtime.registry, runtime.security.current, this.groups);
    this.grants = new Set(identity.grants);
    this.keys = runtime.keys;
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
      return scopeInternals(
        this as unknown as Env,
        scope,
        registry,
        (q) => this.#query(q),
        runtime.driver,
        runtime.security.current,
      );
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

  /** What this environment may do (RFC 0014): for Kosh menus, export / import buttons and API guards. */
  get access(): {
    can(model: ModelName<S>, perm: Perm): boolean;
    /** @throws {AccessError} */
    check(model: ModelName<S>, perm: Perm): void;
    canField(model: ModelName<S>, field: string, kind: 'read' | 'write'): boolean;
    /** The feature permission `code` (`definePermission`): granted by a group, or administrator. */
    has(code: string): boolean;
    /** @throws {AccessError} unless {@link has}. */
    require(code: string): void;
    /**
     * The group and role codes that make their holder an administrator (an administrator group, or implying one),
     * from code and runtime roles: what sign-in, 2FA policy and "keep one administrator" checks look for.
     */
    administratorGroups(): ReadonlySet<string>;
  } {
    const scope = internalsOf(this as unknown as Env);
    return {
      can: (model, perm) => canAccess(scope, scope.registry.get(model).model, perm),
      check: (model, perm) => assertAccess(scope, scope.registry.get(model).model, perm),
      canField: (model, field, kind) =>
        canField(scope, scope.registry.get(model).model, field, kind),
      has: (code) => hasPermission(scope, code),
      require: (code) => {
        assertPermission(scope, code);
      },
      administratorGroups: () => administratorCodes(scope.registry, scope.overlay),
    };
  }

  /**
   * The record with external id `id` (`'base.main_company'`, RFC 0017), nothing loaded.
   * @throws {UnknownExternalIdError} for an unknown id or a record of another model.
   */
  async ref<M extends ModelName<S>>(
    model: M,
    id: string,
  ): Promise<RecordSet<S, M, ListLoaded<never>>> {
    const resId = await refId(this as unknown as Env, model, id);
    return this.model(model).browse([resId]);
  }

  /** The id of the record with external id `id`. @throws {UnknownExternalIdError} */
  async refId<M extends ModelName<S>>(model: M, id: string): Promise<Id<M>> {
    return refId(this as unknown as Env, model, id);
  }

  /**
   * Runtime security administration (RFC 0014 §7.10): roles, model access, record rules and permission grants, on top
   * of the code's declarations. Administrators (or superuser scopes) only; each change is validated against the
   * registry, audited, and reloaded by every process once committed. Needs `createShutro({ runtimeSecurity: true })`.
   */
  get securityAdmin(): SecurityAdmin {
    const apply = async (change: SecurityChange): Promise<void> => {
      const scope = internalsOf(this as unknown as Env);
      if (!this.#runtime.security.enabled)
        throw new InvalidIdentityError(
          'Runtime security is not enabled.',
          'Pass runtimeSecurity: true to createShutro.',
        );
      if (!this.su && !this.administrator)
        throw new AccessError('security', 'manage', {
          problem: 'only administrators can change roles, access and rules.',
          hint: 'Use an administrator account (defineGroup({ administrator: true })).',
        });
      // Read through this transaction: roles saved earlier in it count.
      const overlay = await loadRuntimeSecurity({
        query: <R extends Row>(q: DriverQuery) => scope.query<R>(q),
      });
      validateChange(scope.registry, overlay, change);
      await scope.query(changeStatement(change));
      await scope.query(compile(sqlTag`SELECT pg_notify(${SECURITY_CHANNEL}, '')`));
      trackSecurityChange(scope, change);
      this.afterCommit(async () => {
        this.#runtime.security.current = await loadRuntimeSecurity(this.#runtime.driver);
      });
    };
    return {
      saveRole: (role) => apply({ kind: 'role', ...role }),
      deleteRole: (code) => apply({ kind: 'deleteRole', code }),
      setAccess: (role, model, perms) => apply({ kind: 'access', role, model, perms }),
      saveRule: (rule) => apply({ kind: 'rule', ...rule }),
      deleteRule: (name) => apply({ kind: 'deleteRule', name }),
      grantPermission: (role, permission) => apply({ kind: 'permission', role, permission }),
      revokePermission: (role, permission) => apply({ kind: 'revokePermission', role, permission }),
      setFieldGroups: (model, field, groups) =>
        apply({
          kind: 'fields',
          model,
          field,
          read: [...(groups.read ?? [])],
          write: [...(groups.write ?? [])],
        }),
    };
  }

  /**
   * Emits a domain event in this transaction (RFC 0018 §7.2): it exists if and only if the transaction commits, and
   * subscribers (`shutro.subscribe`) receive it at least once. Returns the event id.
   */
  async emit(topic: string, payload: unknown): Promise<number> {
    const scope = internalsOf(this as unknown as Env);
    const query = <R extends Row>(q: DriverQuery) => scope.query<R>(q);
    await ensureEventTables(this.#runtime.driver, query);
    return emitEvent(query, this.#actor(), topic, payload);
  }

  /**
   * Enqueues a background job in this transaction (RFC 0018 §7.3), run by `shutro.work` as this user, with
   * retries. With `key`, a job already pending or running under that key makes this a no-op (returns `null`).
   */
  async enqueue(name: string, payload: unknown, options?: EnqueueOptions): Promise<number | null> {
    const scope = internalsOf(this as unknown as Env);
    const query = <R extends Row>(q: DriverQuery) => scope.query<R>(q);
    await ensureEventTables(this.#runtime.driver, query);
    return enqueueJob(query, this.#actor(), name, payload, options);
  }

  #actor(): { uid: number; companyId: number; groups: readonly string[] } {
    return { uid: this.uid, companyId: this.companyId, groups: [...this.groups] };
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
    const auditMark = root.audit.length;
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
        root.audit.length = auditMark; // rows of a rolled-back savepoint never reach the trail
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

  /**
   * Drops clean records from this scope's cache (all models, or one): for long reads in one transaction, such as
   * streaming an export of millions of rows page by page, so memory stays bounded. Records with unsaved changes or
   * pending computes and checks are kept; dropped records are simply loaded again when read.
   */
  releaseCache(model?: string): void {
    const scope = internalsOf(this as unknown as Env);
    const root = this.#scope.root;
    for (const name of model === undefined ? [...root.cache.records.keys()] : [model]) {
      const byId = root.cache.records.get(name);
      if (byId === undefined) continue;
      const pending = (sets: Map<string, Map<string, Set<number>>>) =>
        [...(sets.get(name)?.values() ?? [])].flatMap((set) => [...set]);
      const keep = new Set([
        ...(root.dirty.get(name)?.keys() ?? []),
        ...pending(root.triggers),
        ...pending(root.toCompute),
        ...pending(root.toCheck),
      ]);
      for (const id of [...byId.keys()]) if (!keep.has(id)) scope.forget(name, id);
    }
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
   * Runs `fn` reading the past (RFC 0018 §7.4): models with `history: true` are searched and loaded as they were at
   * `instant` (rules, field groups and company scope apply as now); other models are read as they are now. The
   * environment has its own cache and is read-only: writes are refused.
   *
   * ```ts
   * const atClose = await env.asOf(new Date('2026-09-30T23:59:59Z'), (past) => past.model('account.move').search({ where: { state: 'posted' } }).then((m) => m.read(['name', 'amountTotal'])));
   * ```
   */
  async asOf<T>(instant: Date, fn: (past: Env<S>) => Promise<T>): Promise<T> {
    this.#assertUsable();
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime()))
      throw new InvalidIdentityError(
        'asOf() needs a valid Date.',
        "Pass the instant to read, e.g. new Date('2026-09-30T23:59:59Z').",
      );
    const parent = this.#scope;
    const root: RootScope = {
      ...parent.root,
      top: undefined as unknown as Scope,
      cache: createRecordCache(),
      dirty: new Map(),
      triggers: new Map(),
      toCompute: new Map(),
      toCheck: new Map(),
      audit: [],
      compute: {
        recomputing: false,
        computing: new Set(),
        protected: new Map(),
        previous: new Map(),
      },
      asOf: instant,
    };
    const scope: Scope = { ...parent, root, afterCommit: [], onRollback: [], journal: undefined };
    root.top = scope;
    const past = this.#derive({ readOnly: true }, scope);
    scope.env = past as unknown as Env;
    try {
      return await this.#runtime.als.run(scope, () => fn(past));
    } finally {
      parent.root.queries += root.queries;
    }
  }

  /**
   * Runs `fn` with extra special grants in the same scope (RFC 0014 §7.9): a narrow, audited alternative to
   * {@link asSuperuser} for code that must touch a model or feature its caller cannot. Record rules, field groups
   * and company scoping still apply; only the named grants are added, and only inside `fn`.
   *
   * ```ts
   * await env.withGrants({ grants: ['sale.order.line:read'], reason: 'invoice from orders' }, (e) => ...);
   * ```
   */
  async withGrants<T>(
    options: { readonly grants: readonly string[]; readonly reason: string },
    fn: (env: Env<S>) => Promise<T>,
  ): Promise<T> {
    const reason = assertReason(options.reason);
    const grants = assertGrants(options.grants);
    this.#assertUsable();
    const elevated = this.#derive({
      grants: Object.freeze([...new Set([...this.grants, ...grants])]),
    });
    if (this.#runtime.registry !== undefined)
      trackElevation(internalsOf(elevated as unknown as Env), grants, reason);
    return fn(elevated);
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
    const su = this.#derive({ su: true, reason });
    if (this.#runtime.registry !== undefined)
      trackSuperuser(internalsOf(su as unknown as Env), reason);
    // RLS policies read shutro.su: the setting is scoped to the call (RFC 0014 §7.5).
    const wasSu = this.su || this.administrator; // administrators already pass RLS (shutro.su = 1)
    if (!wasSu) await this.#query(compile(sqlTag`SELECT set_config(${'shutro.su'}, ${'1'}, true)`));
    try {
      return await fn(su);
    } finally {
      if (!wasSu)
        await this.#query(compile(sqlTag`SELECT set_config(${'shutro.su'}, ${'0'}, true)`));
    }
  }

  async #query<R extends Row>(query: DriverQuery): Promise<readonly R[]> {
    this.#scope.root.queries++;
    const inspector = this.#runtime.inspector;
    if (inspector === undefined) return this.#scope.conn.query<R>(query);
    const started = performance.now();
    const base = { sql: query.text, params: query.params, tx: this.#scope.root.tx, uid: this.uid };
    try {
      const rows = await this.#scope.conn.query<R>(query);
      inspector.record({ ...base, ms: performance.now() - started });
      return rows;
    } catch (error) {
      inspector.record({
        ...base,
        ms: performance.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
        groups: [...this.groups],
        grants: [...this.grants],
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
  driver: Driver,
  overlay: RuntimeSecurity | undefined,
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
    overlay,
    asOf: root.asOf,
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
    copyIn: async (q, lines) => {
      root.queries++;
      try {
        return await scope.conn.copyIn(q, lines);
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
    driver,
    keys: env.keys,
    auditRows: root.audit,
    tx: root.tx,
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
  /** Keys for `encrypted` fields (RFC 0014 §7.6): `createKeyRing({ current, keys })`. */
  readonly keys?: KeyRing;
  /** Dev-mode query inspector (`createInspector()`): SQL, timings, N+1 warnings. */
  readonly inspector?: Inspector;
  /**
   * Verifies identities against the application's data (RFC 0014 §7.1, docs/feedback.md #6): returns the user's
   * allowed companies and groups, or `null` for an unknown or disabled user. When set, `run()` refuses companies
   * outside the allowed set and groups the user does not have, and uses the loaded groups when none are given.
   */
  readonly identity?: (uid: number) => Promise<VerifiedIdentity | null>;
  /**
   * Roles, access, record rules and permission grants edited at runtime (RFC 0014 §7.10), on top of the code's
   * declarations. Loaded at the first run and reloaded whenever a change is committed (by any process).
   */
  readonly runtimeSecurity?: boolean;
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

/** Options of {@link Shutro.bootstrap}. */
export interface BootstrapOptions {
  /** Why the system acts (audited), e.g. `'install'`. */
  readonly reason: string;
  /** Current company, once one exists; company-scoped defaults and sequences use it. */
  readonly company?: number;
}

/** `env.securityAdmin` (RFC 0014 §7.10). */
export interface SecurityAdmin {
  /** Creates or updates a runtime role. */
  saveRole(role: {
    readonly code: string;
    readonly label?: string;
    readonly implies?: readonly string[];
    readonly administrator?: boolean;
  }): Promise<void>;
  /** Deletes a runtime role with its access, rules and grants. */
  deleteRole(code: string): Promise<void>;
  /** Sets what `role` may do on `model` (an empty list removes the runtime grant; code grants stay). */
  setAccess(role: string, model: string, perms: readonly Perm[]): Promise<void>;
  /** Creates or updates a record rule for `role` (the domain is compiled when saved). */
  saveRule(rule: {
    readonly name: string;
    readonly role: string;
    readonly model: string;
    readonly perms: readonly RulePerm[];
    readonly domain: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  deleteRule(name: string): Promise<void>;
  /** Grants a feature permission (declared by a module) to `role`. */
  grantPermission(role: string, permission: string): Promise<void>;
  revokePermission(role: string, permission: string): Promise<void>;
  /**
   * Field security at runtime: the roles that may read / write `model.field`, on top of its code groups (writers can
   * read). A field without code groups becomes restricted to these roles; empty lists remove the runtime entry.
   */
  setFieldGroups(
    model: string,
    field: string,
    groups: { readonly read?: readonly string[]; readonly write?: readonly string[] },
  ): Promise<void>;
}

/** What an identity loader returns for a user. */
export interface VerifiedIdentity {
  readonly companies: readonly number[];
  readonly groups: readonly string[];
  /** The user's special permissions (see `Identity.grants`). */
  readonly grants?: readonly string[];
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
  /**
   * Runs `fn` as the system (uid {@link SYSTEM_UID}) in a superuser scope, for installing a database before any
   * user exists (feedback #5): `created_by` / `updated_by` are written as `NULL`, the scope is audited with
   * `reason`, and the identity loader is not consulted. Pass `company` once the first company exists, so
   * company-scoped defaults have a value.
   *
   * ```ts
   * await shutro.bootstrap({ reason: 'install' }, async (env) => {
   *   const [company] = await env.model('res.company').create([{ name: 'Acme', currency: bdt }]);
   *   await env.model('res.users').create([{ login: 'admin', name: 'Administrator' }]);
   * });
   * ```
   */
  bootstrap<T>(options: BootstrapOptions, fn: (env: Env<S>) => Promise<T>): Promise<T>;
  /** The environment of the innermost active scope. @throws {NoEnvironmentError} outside `run()`. */
  currentEnv(): Env<S>;
  /** The registry this instance was created with. */
  readonly registry: Registry | undefined;
  /** The driver this instance was created with. */
  readonly driver: Driver;
  /** Reloads runtime security now (changes are also reloaded automatically after they commit). */
  reloadSecurity(): Promise<void>;
  /**
   * A subscriber of `topic` named `name` (RFC 0018 §7.2): events in order, at least once, the cursor advancing in the
   * handler's transaction. One delivery at a time per name, across processes.
   */
  subscribe(
    name: string,
    topic: string,
    handler: (event: DeliveredEvent, env: Env<S>) => Promise<void>,
    options?: { readonly attempts?: number; readonly pollMs?: number },
  ): Worker;
  /** A job worker for these job names (RFC 0018 §7.3); start any number, in any processes. */
  work(
    handlers: Readonly<
      Record<string, (payload: unknown, env: Env<S>, job: RunningJob) => Promise<void>>
    >,
    options?: { readonly pollMs?: number },
  ): Worker;
}

const defaultBackoff = (attempt: number): number =>
  Math.min(1_000, 25 * 2 ** attempt) * (0.5 + Math.random());

const defaultHookError = (error: unknown, phase: string): void => {
  const message = error instanceof Error ? error.message : String(error);
  process.emitWarning(`Shutro ${phase} hook failed: ${message}`, { code: 'SHUTRO_HOOK_FAILED' });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Standard sequences allocate in a short autonomous transaction on a second connection (RFC 0012 §7.3): with a pool
 * of one, that waits forever for the connection the business transaction holds (feedback #21).
 */
function assertPoolFits<S>(options: ShutroOptions<S>): void {
  if (options.driver.max === undefined || options.driver.max > 1) return;
  const registry = options.registry as Registry | undefined;
  const standard = [...(registry?.sequences.values() ?? [])]
    .filter((d) => !d.gapless)
    .map((d) => d.code);
  if (standard.length === 0) return;
  throw new InvalidSequenceError(
    `Sequence(s) ${standard.join(', ')} need a pool of at least 2 connections; the driver has max: 1.`,
    'Raise the driver max, or declare the sequences gapless: true (allocated inside the business transaction).',
  );
}

function workerHost<S>(shutro: Shutro<S>): WorkerHost {
  return {
    driver: shutro.driver,
    run: (o, fn) => shutro.run(o, fn as never),
    bootstrap: (o, fn) => shutro.bootstrap(o, fn as never),
  };
}

/** Creates a {@link Shutro} instance on a driver (and a registry). */
export function createShutro<S = unknown>(options: ShutroOptions<S>): Shutro<S> {
  const attempts = options.retry?.attempts ?? 5;
  const backoff = options.retry?.backoffMs ?? defaultBackoff;
  assertPoolFits(options);
  const runtime: Runtime = {
    als: new AsyncLocalStorage<Scope>(),
    onHookError: options.onHookError ?? defaultHookError,
    registry: options.registry as Registry | undefined,
    sourceLang: assertLang(options.sourceLang ?? 'en_US'),
    driver: options.driver,
    keys: options.keys,
    inspector: options.inspector,
    security: { enabled: options.runtimeSecurity === true, current: undefined, loading: undefined },
  };
  const NOW = compile(sqlTag`SELECT now() AS now`);
  const reload = async (): Promise<void> => {
    runtime.security.current = await loadRuntimeSecurity(options.driver);
  };
  const ensureSecurity = async (): Promise<void> => {
    if (!runtime.security.enabled || runtime.security.current !== undefined) return;
    runtime.security.loading ??= (async () => {
      await reload();
      // Every process reloads when any of them commits a change.
      await options.driver.listen(SECURITY_CHANNEL, () => {
        reload().catch((error: unknown) => runtime.onHookError(error, 'afterCommit'));
      });
    })();
    await runtime.security.loading;
  };

  return {
    async run<T>(runOptions: RunOptions, fn: (env: Env<S>) => Promise<T>): Promise<T> {
      await ensureSecurity();
      let identity = resolveIdentity(runOptions);
      if (options.identity !== undefined) {
        const verified = await options.identity(identity.uid);
        if (verified === null) {
          throw new InvalidIdentityError(
            `User ${identity.uid} is unknown or disabled.`,
            'The identity loader returned no record for this user: check the session, or reactivate the user.',
          );
        }
        for (const company of identity.companyIds) {
          if (!verified.companies.includes(company))
            throw new CompanyNotAllowedError(company, verified.companies);
        }
        const asked = runOptions.groups;
        if (asked !== undefined) {
          const extra = asked.filter((g) => !verified.groups.includes(g));
          if (extra.length > 0) {
            throw new InvalidIdentityError(
              `User ${identity.uid} is not in group(s) ${extra.join(', ')}.`,
              'Pass only groups the user has (or omit groups to use the loaded ones).',
            );
          }
        }
        const askedGrants = runOptions.grants;
        const extraGrants = (askedGrants ?? []).filter((g) => !(verified.grants ?? []).includes(g));
        if (extraGrants.length > 0) {
          throw new InvalidIdentityError(
            `User ${identity.uid} does not have the grant(s) ${extraGrants.join(', ')}.`,
            'Pass only grants the user has (or omit grants to use the loaded ones).',
          );
        }
        identity = {
          ...identity,
          groups: Object.freeze([...(asked ?? verified.groups)]),
          grants: Object.freeze([...(askedGrants ?? verified.grants ?? [])]),
        };
      }
      return execute(identity, runOptions, fn);
    },

    async bootstrap<T>(
      bootstrapOptions: BootstrapOptions,
      fn: (env: Env<S>) => Promise<T>,
    ): Promise<T> {
      const reason = assertReason(bootstrapOptions.reason);
      const company =
        bootstrapOptions.company === undefined
          ? SYSTEM_UID
          : resolveIdentity({ user: 1, company: bootstrapOptions.company }).companyId;
      const identity: ResolvedIdentity = {
        uid: SYSTEM_UID,
        companyId: company,
        companyIds: Object.freeze([company]),
        lang: 'en_US',
        tz: 'UTC',
        reason,
        groups: Object.freeze([]),
        grants: Object.freeze([]),
      };
      return execute(identity, { user: 1, company: 1 }, (env) => env.asSuperuser({ reason }, fn));
    },

    registry: options.registry as Registry | undefined,
    driver: options.driver,
    reloadSecurity: reload,

    subscribe(name, topic, handler, subscribeOptions) {
      return subscribe(workerHost(this), name, topic, handler as never, subscribeOptions);
    },

    work(handlers, workOptions) {
      return work(workerHost(this), handlers as never, workOptions);
    },

    currentEnv(): Env<S> {
      const scope = runtime.als.getStore();
      if (scope === undefined) throw new NoEnvironmentError();
      return scope.env as Env<S>;
    },
  };

  async function execute<T>(
    identity: ResolvedIdentity,
    runOptions: RunOptions,
    fn: (env: Env<S>) => Promise<T>,
  ): Promise<T> {
    {
      const groups =
        options.registry === undefined
          ? new Set(identity.groups)
          : closureWith(options.registry as Registry, runtime.security.current, identity.groups);
      const administrator =
        options.registry !== undefined &&
        isAdministratorWith(options.registry as Registry, runtime.security.current, groups);
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
                'shutro.company_id': String(identity.companyId),
                'shutro.company_ids': `{${identity.companyIds.join(',')}}`,
                'shutro.groups': [...groups].join(','),
                // Administrators pass every RLS policy, like superuser scopes (RFC 0014 §7.9).
                'shutro.su': administrator ? '1' : '0',
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
                audit: [],
                tx: randomUUID(),
                virtual: -1,
                compute: {
                  recomputing: false,
                  computing: new Set(),
                  protected: new Map(),
                  previous: new Map(),
                },
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
    }
  }
}
