/**
 * App lifecycle (RFC 0019): which modules are installed in a database, and atomic install, uninstall (quarantine or
 * purge), upgrade and purge. Every operation runs in one transaction under an advisory lock, so it fully happens or
 * not at all; plans are the same operation rolled back, so a preview never disagrees with the real run.
 */
import { createHash } from 'node:crypto';
import {
  buildRegistry,
  compareVersions,
  createShutro,
  historyStatements,
  junctionTable,
  loadData,
  type MigrationContext,
  type ModuleBase,
  type Registry,
  type SecurityOptions,
  targetOf,
} from '@shutro/core';
import type { Driver, DriverConnection, DriverQuery, Row } from '@shutro/driver-pg';
import { compile, type SqlFragment, sql } from '@shutro/sql';
import { readLiveSchema } from './catalog.js';
import { diffSchema, type Operation } from './diff.js';
import {
  AppDependentsError,
  AppStateError,
  DestructiveMigrationError,
  UninstallBlockedError,
  UnknownAppError,
} from './errors.js';
import { renderOperation } from './render.js';
import { desiredSchema } from './schema.js';

/** The schema quarantined tables and column stashes move to (RFC 0019 §7.6). */
export const QUARANTINE_SCHEMA = 'shutro_quarantine';
/** `NOTIFY` channel of committed install, uninstall, upgrade and purge operations. */
export const MODULES_CHANNEL = 'shutro_modules';

/** State of a module in a database. `available` modules have never been installed there. */
export type ModuleState = 'installed' | 'quarantined' | 'uninstalled';

/** A row of `shutro_module`. */
export interface ModuleRecord {
  readonly name: string;
  readonly version: string;
  readonly state: ModuleState;
  readonly installedAt: Date;
  readonly updatedAt: Date;
  readonly installedBy: string | null;
  readonly quarantinedAt: Date | null;
}

/** One module of the catalog with its state in the database (RFC 0019 §9). */
export interface AppInfo {
  readonly name: string;
  readonly label: string;
  readonly summary: string;
  readonly category: string;
  readonly icon: string | undefined;
  readonly glyph: string | undefined;
  readonly application: boolean;
  readonly autoInstall: boolean;
  readonly required: boolean;
  /** The version the code ships. */
  readonly version: string;
  /** The version recorded in the database, or `null` when never installed. */
  readonly installedVersion: string | null;
  readonly state: ModuleState | 'available';
  /** True when installed and the code ships a newer version. */
  readonly upgradable: boolean;
  /** Direct dependencies. */
  readonly depends: readonly string[];
  /** Modules of the catalog that depend on this one directly. */
  readonly dependents: readonly string[];
  readonly models: readonly string[];
  /** When the quarantined data is purged (quarantined modules only). */
  readonly purgeAfter: Date | null;
}

/** Why a module is part of a plan. */
export type PlanReason = 'requested' | 'dependency' | 'required' | 'auto' | 'dependent' | 'upgrade';

/** A module in a plan. */
export interface PlannedModule {
  readonly name: string;
  readonly label: string;
  readonly glyph: string | undefined;
  readonly application: boolean;
  readonly version: string;
  readonly reason: PlanReason;
  /** Install: the module's data comes back from quarantine. Upgrade: the recorded version. */
  readonly restore: boolean;
  readonly from: string | null;
}

/** What an install does. */
export interface InstallPlan {
  readonly operation: 'install';
  /** Modules to install, in load order. Empty when everything requested is already installed. */
  readonly modules: readonly PlannedModule[];
  /** DDL the install runs (only what the new modules need: drift of installed modules is left alone). */
  readonly statements: readonly string[];
}

/** Data an uninstall moves (or drops). */
export interface AffectedTable {
  readonly table: string;
  readonly module: string;
  readonly rows: number;
}

/** A column an uninstalled extension added to a model that stays. */
export interface AffectedColumn {
  readonly table: string;
  readonly column: string;
  readonly module: string;
  /** Rows with a value. */
  readonly rows: number;
}

/** What an uninstall does. */
export interface UninstallPlan {
  readonly operation: 'uninstall';
  /** Modules to remove, dependents first. */
  readonly modules: readonly PlannedModule[];
  /** True: tables and columns are dropped. False: they move to quarantine for {@link UninstallPlan.retentionDays}. */
  readonly purge: boolean;
  readonly retentionDays: number;
  readonly tables: readonly AffectedTable[];
  readonly columns: readonly AffectedColumn[];
}

/** What an upgrade does. */
export interface UpgradePlan {
  readonly operation: 'upgrade';
  /** Modules whose code is newer than the database. */
  readonly modules: readonly PlannedModule[];
  readonly statements: readonly string[];
  /** Destructive statements (refused without `allowDestructive`). */
  readonly destructive: readonly string[];
}

/** What a purge does. */
export interface PurgePlan {
  readonly operation: 'purge';
  readonly modules: readonly PlannedModule[];
  readonly tables: readonly string[];
}

/** Any plan. */
export type AppPlan = InstallPlan | UninstallPlan | UpgradePlan | PurgePlan;

/** A unit of work reported while an operation runs. */
export type AppStep = 'blockers' | 'restore' | 'schema' | 'data' | 'hooks' | 'quarantine' | 'drop';

/** Progress of an operation (the CLI's `--json` lines; Kosh's progress bars). */
export type AppEvent =
  | { readonly type: 'plan'; readonly plan: AppPlan }
  | {
      readonly type: 'step';
      readonly step: AppStep;
      readonly status: 'start' | 'done';
      /** The module, or `undefined` for steps over every module (schema). */
      readonly module: string | undefined;
      readonly ms?: number;
      readonly detail?: string | undefined;
    }
  | { readonly type: 'warning'; readonly message: string }
  | { readonly type: 'done'; readonly operation: AppPlan['operation']; readonly ms: number };

/** Options shared by the operations. */
export interface OperationOptions {
  /** Who acts: a login, `'cli'`, … Recorded in `shutro_module_log` and `shutro_module.installed_by`. */
  readonly actor?: string;
  /** Progress events. */
  readonly onEvent?: (event: AppEvent) => void;
}

/** Options of {@link AppManager.install}. */
export interface InstallOptions extends OperationOptions {
  /** Current company for company-scoped defaults of module data, once one exists. */
  readonly company?: number;
}

/** Options of {@link AppManager.uninstall}. */
export interface UninstallOptions extends OperationOptions {
  /** Also remove installed modules that depend on the requested ones (glue modules always follow). */
  readonly cascade?: boolean;
  /** Drop the data instead of quarantining it. */
  readonly purge?: boolean;
}

/** Options of {@link AppManager.upgrade}. */
export interface UpgradeOptions extends OperationOptions {
  /** Run destructive statements (dropped columns, type changes). */
  readonly allowDestructive?: boolean;
  readonly company?: number;
}

/** Options of {@link AppManager.purge}. */
export interface PurgeOptions extends OperationOptions {
  /** Purge these quarantined modules now, whatever their age. Default: those past the retention period. */
  readonly modules?: readonly string[];
}

/** Result of an operation. */
export interface AppResult<P extends AppPlan> {
  readonly plan: P;
  /** The registry of the modules installed afterwards: pass it to `shutro.useRegistry()`. */
  readonly registry: Registry;
  readonly warnings: readonly string[];
  readonly ms: number;
}

/** Options of {@link createAppManager}. */
export interface AppManagerOptions {
  readonly driver: Driver;
  /** Every module the application ships (dependencies are collected): the catalog. */
  readonly modules: readonly ModuleBase[];
  /** Access control of the registries built for the installed set. */
  readonly security?: SecurityOptions;
  /** Days an uninstalled app's data stays in quarantine. Default 30. */
  readonly retentionDays?: number;
}

/** Installs, uninstalls and upgrades the catalog's modules in one database (RFC 0019). */
export interface AppManager {
  /** The catalog: every available module, in load order. */
  readonly catalog: readonly ModuleBase[];
  /** Module rows of the database (empty before the first install). */
  state(): Promise<ReadonlyMap<string, ModuleRecord>>;
  /** Names of the installed modules, in load order. */
  installed(): Promise<readonly string[]>;
  /** The registry of the installed modules. */
  registry(): Promise<Registry>;
  /** Catalog with state (RFC 0019 §9): what an app store lists. */
  list(): Promise<readonly AppInfo[]>;
  /** The install plan, computed by running the install and rolling it back. */
  planInstall(modules: readonly string[]): Promise<InstallPlan>;
  /**
   * Installs `modules` with their dependencies, the required modules and the glue modules that become complete
   * (RFC 0019 §7.5). One transaction: schema, data and state commit together or not at all.
   *
   * @throws {UnknownAppError} {AppStateError}
   */
  install(modules: readonly string[], options?: InstallOptions): Promise<AppResult<InstallPlan>>;
  /** The uninstall plan, including row counts, computed by running it and rolling back. */
  planUninstall(
    modules: readonly string[],
    options?: Pick<UninstallOptions, 'cascade' | 'purge'>,
  ): Promise<UninstallPlan>;
  /**
   * Uninstalls `modules` (RFC 0019 §7.6). By default their tables move to quarantine and come back on reinstall;
   * `purge: true` drops them. Audit rows are never deleted.
   *
   * @throws {AppDependentsError} {UninstallBlockedError} {AppStateError}
   */
  uninstall(
    modules: readonly string[],
    options?: UninstallOptions,
  ): Promise<AppResult<UninstallPlan>>;
  /** The upgrade plan. */
  planUpgrade(modules?: readonly string[]): Promise<UpgradePlan>;
  /**
   * Applies the code's schema to the installed modules, runs the data-migration hooks of modules whose version rose,
   * reloads module data and records the versions. Tables of removed models are never dropped.
   *
   * @throws {DestructiveMigrationError} for destructive statements without `allowDestructive`.
   */
  upgrade(modules?: readonly string[], options?: UpgradeOptions): Promise<AppResult<UpgradePlan>>;
  /** Drops quarantined data past the retention period (or of `modules` now). */
  purge(options?: PurgeOptions): Promise<AppResult<PurgePlan>>;
  /**
   * Keeps a Shutro instance on the installed set: sets its registry now, and again whenever any process commits an
   * operation. Returns a function that stops following.
   */
  attach(shutro: { useRegistry(registry: Registry): void }): Promise<() => Promise<void>>;
}

// ------------------------------------------------------------------------------------------------ storage

interface Queryable {
  query<R extends Row = Row>(query: DriverQuery): Promise<readonly R[]>;
}

const SETUP: readonly SqlFragment[] = [
  sql`CREATE TABLE IF NOT EXISTS "shutro_module" ("name" text PRIMARY KEY, "version" text NOT NULL, "installed_at" timestamp with time zone NOT NULL DEFAULT now(), "updated_at" timestamp with time zone NOT NULL DEFAULT now())`,
  sql`ALTER TABLE "shutro_module" ADD COLUMN IF NOT EXISTS "state" text NOT NULL DEFAULT 'installed' CHECK ("state" IN ('installed', 'quarantined', 'uninstalled'))`,
  sql`ALTER TABLE "shutro_module" ADD COLUMN IF NOT EXISTS "installed_by" text`,
  sql`ALTER TABLE "shutro_module" ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone`,
  sql`CREATE TABLE IF NOT EXISTS "shutro_module_log" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "operation" text NOT NULL, "modules" text[] NOT NULL, "plan" jsonb NOT NULL, "actor" text, "outcome" text NOT NULL, "started_at" timestamp with time zone NOT NULL, "finished_at" timestamp with time zone NOT NULL DEFAULT clock_timestamp())`,
  sql`CREATE SCHEMA IF NOT EXISTS "shutro_quarantine"`,
  sql`CREATE TABLE IF NOT EXISTS "shutro_quarantine"."item" ("module" text NOT NULL, "kind" text NOT NULL CHECK ("kind" IN ('table', 'column')), "table_name" text NOT NULL, "column_name" text, "stash" text, "foreign_keys" jsonb NOT NULL DEFAULT '[]', "quarantined_at" timestamp with time zone NOT NULL DEFAULT now())`,
];

async function setup(conn: Queryable): Promise<void> {
  for (const statement of SETUP) await conn.query(compile(statement));
}

async function readState(q: Queryable): Promise<Map<string, ModuleRecord>> {
  const [present] = await q.query<{ present: boolean }>(
    compile(sql`SELECT to_regclass(${'shutro_module'}) IS NOT NULL AS present`),
  );
  const state = new Map<string, ModuleRecord>();
  if (present?.present !== true) return state;
  // to_jsonb reads databases set up by `migrate apply` before the state columns existed, too.
  const rows = await q.query<{ row: Record<string, unknown> }>(
    compile(sql`SELECT to_jsonb(m) AS row FROM "shutro_module" m ORDER BY m.name`),
  );
  const date = (v: unknown): Date | null => (typeof v === 'string' ? new Date(v) : null);
  for (const { row } of rows) {
    const name = String(row['name']);
    state.set(name, {
      name,
      version: String(row['version']),
      state: (row['state'] as ModuleState | undefined) ?? 'installed',
      installedAt: date(row['installed_at']) ?? new Date(0),
      updatedAt: date(row['updated_at']) ?? new Date(0),
      installedBy: typeof row['installed_by'] === 'string' ? row['installed_by'] : null,
      quarantinedAt: date(row['quarantined_at']),
    });
  }
  return state;
}

/** A driver whose transactions are savepoints of `conn`, so module data loads inside the operation's transaction. */
function pinned(base: Driver, conn: DriverConnection): Driver {
  return {
    ...(base.max === undefined ? {} : { max: base.max }),
    query: <R extends Row = Row>(query: DriverQuery) => conn.query<R>(query),
    async transaction(options, fn) {
      const settings = Object.entries(options.settings ?? {});
      if (settings.length > 0)
        await conn.query(
          compile(
            sql`SELECT ${sql.join(settings.map(([k, v]) => sql`set_config(${k}, ${v}, true)`))}`,
          ),
        );
      return conn.savepoint(fn);
    },
    listen: (channel, onMessage) => base.listen(channel, onMessage),
    end: async () => {},
  };
}

const ON_DELETE: Readonly<Record<string, SqlFragment>> = {
  a: sql`NO ACTION`,
  r: sql`RESTRICT`,
  c: sql`CASCADE`,
  n: sql`SET NULL`,
  d: sql`SET DEFAULT`,
};

/** A foreign key of a quarantined table to a table that stays: dropped while quarantined, re-added on restore. */
interface SavedForeignKey {
  readonly name: string;
  readonly column: string;
  readonly refTable: string;
  readonly refColumn: string;
  readonly onDelete: string;
}

interface QuarantineItem {
  readonly module: string;
  readonly kind: 'table' | 'column';
  readonly table_name: string;
  readonly column_name: string | null;
  readonly stash: string | null;
  readonly foreign_keys: readonly SavedForeignKey[];
}

function stashName(table: string, column: string): string {
  return `c_${createHash('sha256').update(`${table}.${column}`).digest('hex').slice(0, 24)}`;
}

async function exists(q: Queryable, schema: string, table: string): Promise<boolean> {
  const [row] = await q.query<{ present: boolean }>(
    compile(
      sql`SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = ${table} AND c.relkind IN ('r', 'p')) AS present`,
    ),
  );
  return row?.present === true;
}

async function columnExists(q: Queryable, table: string, column: string): Promise<boolean> {
  const [row] = await q.query<{ present: boolean }>(
    compile(
      sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}) AS present`,
    ),
  );
  return row?.present === true;
}

async function count(q: Queryable, table: string, column?: string): Promise<number> {
  const [row] = await q.query<{ n: string | number }>(
    compile(
      column === undefined
        ? sql`SELECT count(*) AS n FROM ${sql.id('public', table)}`
        : sql`SELECT count(${sql.id(column)}) AS n FROM ${sql.id('public', table)}`,
    ),
  );
  return Number(row?.n ?? 0);
}

/** Tables and columns of a registry → the module that contributes them. */
function ownership(registry: Registry): {
  readonly tables: ReadonlyMap<string, string>;
  readonly columns: ReadonlyMap<string, string>;
} {
  const tables = new Map<string, string>();
  const columns = new Map<string, string>();
  for (const registered of registry.models.values()) {
    const { model } = registered;
    tables.set(model.table, registered.module);
    if (model.history) tables.set(`${model.table}_history`.slice(0, 63), registered.module);
    for (const [key, field] of Object.entries(model.fields)) {
      const origin = registered.fieldOrigins[key] ?? registered.module;
      const column = model.columns[key];
      if (column !== undefined) columns.set(`${model.table}.${column}`, origin);
      else if (field.kind === 'many2many') {
        const target = registry.get(targetOf(field) ?? '').model;
        tables.set(junctionTable(model, field, target).table, origin);
      }
    }
  }
  return { tables, columns };
}

const signature = (op: Operation): string => JSON.stringify(op);

/** Operations that exist because of the change from `from` to `to` (drift of `from` is left alone). */
async function causedBy(driver: Driver, from: Registry, to: Registry): Promise<Operation[]> {
  const live = await readLiveSchema(driver);
  const before = new Set(diffSchema(desiredSchema(from), live).map(signature));
  return diffSchema(desiredSchema(to), live).filter((op) => !before.has(signature(op)));
}

async function run(conn: Queryable, statement: string): Promise<void> {
  await conn.query({ text: statement, params: [] });
}

/** Thrown inside a plan's transaction to roll it back with the plan. */
class PlanOnly {
  constructor(readonly plan: AppPlan) {}
}

// ------------------------------------------------------------------------------------------------ manager

/**
 * Creates the app manager of a catalog on a database.
 *
 * @example
 * ```ts
 * const apps = createAppManager({ driver, modules: [...officialApps, myModule] });
 * const { registry } = await apps.install(['purchase'], { actor: 'admin', onEvent: (e) => log(e) });
 * shutro.useRegistry(registry);
 * ```
 * @throws Registry errors of the catalog (every module must build together).
 */
export function createAppManager(options: AppManagerOptions): AppManager {
  const { driver } = options;
  const retentionDays = options.retentionDays ?? 30;
  const security = options.security === undefined ? {} : { security: options.security };
  const full = buildRegistry({ modules: options.modules, ...security });
  const order = full.loadOrder;
  const byName = new Map(full.modules.map((m) => [m.name, m]));
  const get = (name: string): ModuleBase => {
    const module = byName.get(name);
    if (module === undefined) throw new UnknownAppError(name, order);
    return module;
  };
  const closures = new Map<string, Set<string>>();
  const closureOf = (name: string): Set<string> => {
    let found = closures.get(name);
    if (found === undefined) {
      found = new Set([name]);
      for (const dep of get(name).depends) for (const n of closureOf(dep.name)) found.add(n);
      closures.set(name, found);
    }
    return found;
  };
  const sorted = (names: Iterable<string>): string[] => {
    const set = new Set(names);
    return order.filter((n) => set.has(n));
  };
  const registries = new Map<string, Registry>();
  const registryOf = (names: Iterable<string>): Registry => {
    const list = sorted(names);
    const key = list.join(',');
    let registry = registries.get(key);
    if (registry === undefined) {
      registry = buildRegistry({ modules: list.map(get), ...security }) as Registry;
      registries.set(key, registry);
    }
    return registry;
  };
  const installedOf = (state: ReadonlyMap<string, ModuleRecord>): Set<string> =>
    new Set(
      [...state.values()]
        .filter((r) => r.state === 'installed' && byName.has(r.name))
        .map((r) => r.name),
    );
  const required = order.filter((n) => get(n).required);
  const requiredClosure = new Set(required.flatMap((n) => [...closureOf(n)]));
  const planned = (
    name: string,
    reason: PlanReason,
    restore: boolean,
    from: string | null,
  ): PlannedModule => {
    const m = get(name);
    return {
      name,
      label: m.label,
      glyph: m.glyph,
      application: m.application,
      version: m.version,
      reason,
      restore,
      from,
    };
  };

  function resolveInstall(installed: ReadonlySet<string>, requested: readonly string[]) {
    for (const name of requested) get(name);
    const target = new Set(installed);
    const reasons = new Map<string, PlanReason>();
    const add = (name: string, reason: PlanReason): void => {
      for (const dep of sorted(closureOf(name))) {
        if (target.has(dep)) continue;
        target.add(dep);
        reasons.set(dep, dep === name ? reason : 'dependency');
      }
    };
    for (const name of requested) add(name, 'requested');
    for (const name of required) add(name, 'required');
    for (let changed = true; changed; ) {
      changed = false;
      for (const name of order) {
        const m = get(name);
        if (!m.autoInstall || target.has(name)) continue;
        if (m.depends.every((d) => target.has(d.name))) {
          add(name, 'auto');
          changed = true;
        }
      }
    }
    return { target, reasons, toInstall: sorted([...target].filter((n) => !installed.has(n))) };
  }

  function resolveUninstall(
    installed: ReadonlySet<string>,
    requested: readonly string[],
    cascade: boolean,
  ) {
    for (const name of requested) {
      get(name);
      if (!installed.has(name))
        throw new AppStateError(
          `'${name}' is not installed.`,
          'Run "shutro apps list" to see the installed apps.',
        );
      if (requiredClosure.has(name))
        throw new AppStateError(
          `'${name}' cannot be uninstalled: ${get(name).required ? 'it is required' : `the required module(s) ${required.filter((r) => closureOf(r).has(name)).join(', ')} depend on it`}.`,
          'Required modules (base, settings) hold the users, companies and settings every app needs.',
        );
    }
    const removed = new Set(requested);
    const reasons = new Map<string, PlanReason>(requested.map((n) => [n, 'requested']));
    for (let changed = true; changed; ) {
      changed = false;
      for (const name of order) {
        if (!installed.has(name) || removed.has(name)) continue;
        const m = get(name);
        if (!m.depends.some((d) => removed.has(d.name))) continue;
        removed.add(name);
        reasons.set(name, m.autoInstall ? 'auto' : 'dependent');
        changed = true;
      }
    }
    const dependents = sorted([...reasons].filter(([, r]) => r === 'dependent').map(([n]) => n));
    if (dependents.length > 0 && !cascade) throw new AppDependentsError(requested, dependents);
    const blocked = [...removed].filter((n) => requiredClosure.has(n));
    if (blocked.length > 0)
      throw new AppStateError(
        `Uninstalling ${requested.join(', ')} would remove required module(s) ${blocked.join(', ')}.`,
        'Required modules cannot be uninstalled.',
      );
    return { removed: sorted(removed).reverse(), reasons };
  }

  async function log(
    conn: Queryable,
    operation: string,
    modules: readonly string[],
    plan: unknown,
    actor: string | undefined,
    startedAt: Date,
    outcome: string,
  ): Promise<void> {
    await conn.query(
      compile(
        sql`INSERT INTO "shutro_module_log" (operation, modules, plan, actor, outcome, started_at) VALUES (${operation}, ${sql.array(modules, 'text')}, (${sql.param(JSON.stringify(plan), 'text')})::jsonb, ${actor ?? null}, ${outcome}, ${startedAt})`,
      ),
    );
  }

  /**
   * Runs an operation in one transaction under the module lock. `body` returns the plan and the registry after the
   * operation; with `dryRun` it throws {@link PlanOnly} once the plan is known, which rolls everything back.
   */
  async function operate<P extends AppPlan>(
    operation: P['operation'],
    requested: readonly string[],
    opts: OperationOptions,
    dryRun: boolean,
    body: (ctx: {
      readonly conn: DriverConnection;
      readonly pin: Driver;
      readonly state: ReadonlyMap<string, ModuleRecord>;
      readonly emit: (event: AppEvent) => void;
      readonly warn: (message: string) => void;
      /** Called once the plan is final: reports it, and ends a dry run. */
      readonly planned: (plan: P) => void;
    }) => Promise<{ plan: P; registry: Registry }>,
  ): Promise<AppResult<P>> {
    const startedAt = new Date();
    const warnings: string[] = [];
    const emit = (event: AppEvent): void => {
      if (!dryRun) opts.onEvent?.(event);
    };
    try {
      const { plan, registry } = await driver.transaction(
        { isolation: 'read committed' },
        async (conn) => {
          await setup(conn);
          await conn.query(
            compile(sql`SELECT pg_advisory_xact_lock(hashtext(${MODULES_CHANNEL}))`),
          );
          const pin = pinned(driver, conn);
          if (operation !== 'purge') await purgeExpired(conn, pin, [], emit, warnings);
          const state = await readState(conn);
          const out = await body({
            conn,
            pin,
            state,
            emit,
            warn: (message) => {
              warnings.push(message);
              emit({ type: 'warning', message });
            },
            planned: (p) => {
              if (dryRun) throw new PlanOnly(p);
              emit({ type: 'plan', plan: p });
            },
          });
          await log(
            conn,
            operation,
            out.plan.modules.map((m) => m.name),
            out.plan,
            opts.actor,
            startedAt,
            'ok',
          );
          await conn.query(
            compile(
              sql`SELECT pg_notify(${MODULES_CHANNEL}, ${JSON.stringify({ operation, modules: out.plan.modules.map((m) => m.name) })})`,
            ),
          );
          return out;
        },
      );
      const ms = Date.now() - startedAt.getTime();
      emit({ type: 'done', operation, ms });
      return { plan, registry, warnings, ms };
    } catch (error) {
      if (error instanceof PlanOnly)
        return {
          plan: error.plan as P,
          registry: await (async () => registryOf(installedOf(await readState(driver))))(),
          warnings,
          ms: Date.now() - startedAt.getTime(),
        };
      // The operation rolled back; its failure is still part of the log (RFC 0019 R5).
      try {
        await driver.transaction({ isolation: 'read committed' }, async (conn) => {
          await setup(conn);
          const message = error instanceof Error ? error.message : String(error);
          await log(
            conn,
            operation,
            requested,
            { error: message },
            opts.actor,
            startedAt,
            `failed: ${message}`,
          );
        });
      } catch {
        // Logging must not hide the original error.
      }
      throw error;
    }
  }

  async function blockersOf(
    conn: DriverConnection,
    registry: Registry,
    modules: readonly string[],
  ): Promise<void> {
    const ctx: MigrationContext = {
      registry,
      sql: (strings, ...values) => conn.query(compile(sql(strings, ...values))),
    };
    const reasons: Record<string, readonly string[]> = {};
    for (const name of modules) {
      const blockers = get(name).uninstall.blockers;
      if (blockers === undefined) continue;
      const list = await blockers(ctx);
      if (list.length > 0) reasons[name] = list;
    }
    if (Object.keys(reasons).length > 0) throw new UninstallBlockedError(reasons);
  }

  /** Deletes the records a module's data created in tables that stay, then its external ids. */
  async function forgetData(
    conn: DriverConnection,
    module: string,
    warn: (m: string) => void,
  ): Promise<void> {
    if (!(await exists(conn, 'public', 'shutro_external_id'))) return;
    const rows = await conn.query<{ name: string; model: string; res_id: string | number }>(
      compile(
        sql`SELECT name, model, res_id FROM "shutro_external_id" WHERE module = ${module} ORDER BY res_id DESC`,
      ),
    );
    for (const row of rows) {
      const table = full.has(row.model) ? full.get(row.model).model.table : undefined;
      if (table === undefined || !(await exists(conn, 'public', table))) continue;
      try {
        await conn.savepoint((sp) =>
          sp.query(
            compile(sql`DELETE FROM ${sql.id('public', table)} WHERE id = ${Number(row.res_id)}`),
          ),
        );
      } catch {
        warn(
          `Kept ${row.model} ${row.res_id} (${module}.${row.name}): other records still refer to it.`,
        );
      }
    }
    await conn.query(compile(sql`DELETE FROM "shutro_external_id" WHERE module = ${module}`));
  }

  async function purgeModules(
    conn: DriverConnection,
    modules: readonly string[],
    emit: (event: AppEvent) => void,
    warnings: string[],
  ): Promise<string[]> {
    const dropped: string[] = [];
    for (const module of modules) {
      const t0 = Date.now();
      emit({ type: 'step', step: 'drop', status: 'start', module });
      const items = await conn.query<QuarantineItem & Row>(
        compile(sql`SELECT * FROM "shutro_quarantine"."item" WHERE module = ${module}`),
      );
      const names = items.map((i) => (i.kind === 'table' ? i.table_name : (i.stash ?? '')));
      const present: SqlFragment[] = [];
      for (const name of names)
        if (name !== '' && (await exists(conn, QUARANTINE_SCHEMA, name)))
          present.push(sql.id(QUARANTINE_SCHEMA, name));
      if (present.length > 0)
        await conn.query(compile(sql`DROP TABLE ${sql.join(present)} CASCADE`));
      dropped.push(...items.filter((i) => i.kind === 'table').map((i) => i.table_name));
      await forgetData(conn, module, (m) => warnings.push(m));
      await conn.query(
        compile(sql`DELETE FROM "shutro_quarantine"."item" WHERE module = ${module}`),
      );
      await conn.query(
        compile(
          sql`UPDATE "shutro_module" SET state = 'uninstalled', quarantined_at = NULL, updated_at = now() WHERE name = ${module}`,
        ),
      );
      emit({ type: 'step', step: 'drop', status: 'done', module, ms: Date.now() - t0 });
    }
    return dropped;
  }

  async function purgeExpired(
    conn: DriverConnection,
    _pin: Driver,
    now: readonly string[],
    emit: (event: AppEvent) => void,
    warnings: string[],
  ): Promise<string[]> {
    const rows = await conn.query<{ name: string }>(
      compile(
        sql`SELECT name FROM "shutro_module" WHERE state = 'quarantined' AND (quarantined_at < now() - make_interval(days => ${retentionDays}) OR name = ANY(${sql.array(now, 'text')})) ORDER BY name`,
      ),
    );
    const modules = rows.map((r) => r.name);
    await purgeModules(conn, modules, emit, warnings);
    return modules;
  }

  /** Moves a quarantined module's tables back and re-adds their foreign keys. */
  async function restoreTables(
    conn: DriverConnection,
    module: string,
    warn: (m: string) => void,
  ): Promise<void> {
    const items = await conn.query<QuarantineItem & Row>(
      compile(
        sql`SELECT * FROM "shutro_quarantine"."item" WHERE module = ${module} AND kind = 'table'`,
      ),
    );
    for (const item of items) {
      if (!(await exists(conn, QUARANTINE_SCHEMA, item.table_name))) continue;
      if (await exists(conn, 'public', item.table_name))
        throw new AppStateError(
          `Cannot restore ${item.table_name} for '${module}': a table with that name already exists.`,
          `Rename or drop public.${item.table_name}, or purge the quarantine first (shutro apps purge --now ${module}).`,
        );
      await conn.query(
        compile(sql`ALTER TABLE ${sql.id(QUARANTINE_SCHEMA, item.table_name)} SET SCHEMA "public"`),
      );
    }
    for (const item of items) {
      for (const fk of item.foreign_keys) {
        const onDelete = ON_DELETE[fk.onDelete] ?? sql`NO ACTION`;
        await conn.query(
          compile(
            sql`ALTER TABLE ${sql.id('public', item.table_name)} ADD CONSTRAINT ${sql.id(fk.name)} FOREIGN KEY (${sql.id(fk.column)}) REFERENCES ${sql.id('public', fk.refTable)} (${sql.id(fk.refColumn)}) ON DELETE ${onDelete} NOT VALID`,
          ),
        );
        try {
          await conn.savepoint((sp) =>
            sp.query(
              compile(
                sql`ALTER TABLE ${sql.id('public', item.table_name)} VALIDATE CONSTRAINT ${sql.id(fk.name)}`,
              ),
            ),
          );
        } catch {
          warn(
            `${item.table_name}.${fk.column} refers to ${fk.refTable} records deleted while '${module}' was uninstalled; the link is kept unvalidated (NOT VALID). Fix those rows, then VALIDATE CONSTRAINT ${fk.name}.`,
          );
        }
      }
    }
    await conn.query(
      compile(
        sql`DELETE FROM "shutro_quarantine"."item" WHERE module = ${module} AND kind = 'table'`,
      ),
    );
  }

  /** Writes stashed column values back (after the schema step re-added the columns). */
  async function restoreColumns(
    conn: DriverConnection,
    module: string,
    warn: (m: string) => void,
  ): Promise<void> {
    const items = await conn.query<QuarantineItem & Row>(
      compile(
        sql`SELECT * FROM "shutro_quarantine"."item" WHERE module = ${module} AND kind = 'column'`,
      ),
    );
    for (const item of items) {
      const column = item.column_name ?? '';
      const stash = item.stash ?? '';
      if (!(await exists(conn, QUARANTINE_SCHEMA, stash))) continue;
      if (await columnExists(conn, item.table_name, column))
        await conn.query(
          compile(
            sql`UPDATE ${sql.id('public', item.table_name)} AS t SET ${sql.id(column)} = s.value FROM ${sql.id(QUARANTINE_SCHEMA, stash)} AS s WHERE t.id = s.id`,
          ),
        );
      else
        warn(
          `${item.table_name}.${column} no longer exists in '${module}'; its quarantined values were dropped.`,
        );
      await conn.query(compile(sql`DROP TABLE ${sql.id(QUARANTINE_SCHEMA, stash)}`));
    }
    await conn.query(
      compile(
        sql`DELETE FROM "shutro_quarantine"."item" WHERE module = ${module} AND kind = 'column'`,
      ),
    );
  }

  async function runHooks(
    conn: DriverConnection,
    registry: Registry,
    module: string,
    from: string,
  ): Promise<number> {
    const m = get(module);
    const ctx: MigrationContext = {
      registry,
      sql: (strings, ...values) => conn.query(compile(sql(strings, ...values))),
    };
    let ran = 0;
    for (const hook of m.migrations) {
      if (compareVersions(hook.version, from) <= 0 || compareVersions(hook.version, m.version) > 0)
        continue;
      await hook.up(ctx);
      ran++;
    }
    return ran;
  }

  async function install(
    requested: readonly string[],
    opts: InstallOptions,
    dryRun: boolean,
  ): Promise<AppResult<InstallPlan>> {
    return operate<InstallPlan>(
      'install',
      requested,
      opts,
      dryRun,
      async ({ conn, pin, state, emit, warn, planned: report }) => {
        const installed = installedOf(state);
        const { target, reasons, toInstall } = resolveInstall(installed, requested);
        const current = registryOf(installed);
        const next = registryOf(target);
        const restoring = toInstall.filter((n) => state.get(n)?.state === 'quarantined');
        for (const name of restoring) {
          const t0 = Date.now();
          emit({ type: 'step', step: 'restore', status: 'start', module: name });
          await restoreTables(conn, name, warn);
          emit({
            type: 'step',
            step: 'restore',
            status: 'done',
            module: name,
            ms: Date.now() - t0,
          });
        }
        const ops = (await causedBy(pin, current, next)).filter((op) => !op.destructive);
        const plan: InstallPlan = {
          operation: 'install',
          modules: toInstall.map((n) =>
            planned(
              n,
              reasons.get(n) ?? 'requested',
              restoring.includes(n),
              state.get(n)?.version ?? null,
            ),
          ),
          statements: ops.map(renderOperation),
        };
        report(plan);
        if (toInstall.length === 0) return { plan, registry: current };

        const t0 = Date.now();
        emit({ type: 'step', step: 'schema', status: 'start', module: undefined });
        for (const statement of plan.statements) await run(conn, statement);
        for (const statement of historyStatements(next)) await conn.query(statement);
        emit({
          type: 'step',
          step: 'schema',
          status: 'done',
          module: undefined,
          ms: Date.now() - t0,
          detail: `${plan.statements.length} statement(s)`,
        });
        for (const name of restoring) await restoreColumns(conn, name, warn);

        const shutro = createShutro({ driver: pin, registry: next });
        for (const name of toInstall) {
          const t1 = Date.now();
          emit({ type: 'step', step: 'data', status: 'start', module: name });
          const previous = state.get(name);
          if (restoring.includes(name) && previous !== undefined)
            await runHooks(conn, next, name, previous.version);
          const [result] = await loadData(shutro, {
            modules: [name],
            ...(opts.company === undefined ? {} : { company: opts.company }),
          });
          for (const kept of result?.retained ?? []) warn(`Kept ${kept.id}: ${kept.reason}.`);
          const version = get(name).version;
          await conn.query(
            compile(
              sql`INSERT INTO "shutro_module" (name, version, state, installed_by) VALUES (${name}, ${version}, 'installed', ${opts.actor ?? null})
                ON CONFLICT (name) DO UPDATE SET version = EXCLUDED.version, state = 'installed', installed_by = EXCLUDED.installed_by, quarantined_at = NULL, updated_at = now()`,
            ),
          );
          emit({
            type: 'step',
            step: 'data',
            status: 'done',
            module: name,
            ms: Date.now() - t1,
            detail: result === undefined ? undefined : `${result.created.length} record(s)`,
          });
        }
        return { plan, registry: next };
      },
    );
  }

  async function uninstall(
    requested: readonly string[],
    opts: UninstallOptions,
    dryRun: boolean,
  ): Promise<AppResult<UninstallPlan>> {
    const purge = opts.purge === true;
    return operate<UninstallPlan>(
      'uninstall',
      requested,
      opts,
      dryRun,
      async ({ conn, pin, state, emit, planned: report }) => {
        const installed = installedOf(state);
        const { removed, reasons } = resolveUninstall(installed, requested, opts.cascade === true);
        const remaining = [...installed].filter((n) => !removed.includes(n));
        const old = registryOf(installed);
        const next = registryOf(remaining);

        emit({ type: 'step', step: 'blockers', status: 'start', module: undefined });
        await blockersOf(conn, old, removed);
        emit({ type: 'step', step: 'blockers', status: 'done', module: undefined });

        const own = ownership(old);
        const oldSchema = desiredSchema(old);
        const newSchema = desiredSchema(next);
        const tables: AffectedTable[] = [];
        for (const table of Object.keys(oldSchema.tables)) {
          if (table in newSchema.tables || !(await exists(conn, 'public', table))) continue;
          tables.push({
            table,
            module: own.tables.get(table) ?? removed[0] ?? '',
            rows: await count(conn, table),
          });
        }
        const columns: AffectedColumn[] = [];
        for (const [table, spec] of Object.entries(newSchema.tables)) {
          const before = oldSchema.tables[table];
          if (before === undefined) continue;
          for (const column of Object.keys(before.columns)) {
            if (column in spec.columns || !(await columnExists(conn, table, column))) continue;
            columns.push({
              table,
              column,
              module: own.columns.get(`${table}.${column}`) ?? removed[0] ?? '',
              rows: await count(conn, table, column),
            });
          }
        }
        const plan: UninstallPlan = {
          operation: 'uninstall',
          modules: removed.map((n) =>
            planned(n, reasons.get(n) ?? 'requested', false, state.get(n)?.version ?? null),
          ),
          purge,
          retentionDays,
          tables,
          columns,
        };

        // Foreign keys from tables that stay into tables that go must belong to columns that go as well.
        const gone = tables.map((t) => t.table);
        const goneColumns = new Set(columns.map((c) => `${c.table}.${c.column}`));
        const incoming = await conn.query<{
          name: string;
          table: string;
          column: string;
          ref: string;
        }>(
          compile(
            sql`SELECT c.conname AS name, t.relname AS "table", a.attname AS "column", rt.relname AS ref
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
              JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
              WHERE c.contype = 'f' AND n.nspname = 'public' AND rn.nspname = 'public'
                AND rt.relname = ANY(${sql.array(gone, 'text')}) AND NOT (t.relname = ANY(${sql.array(gone, 'text')}))`,
          ),
        );
        const foreign = incoming.filter((r) => !goneColumns.has(`${r.table}.${r.column}`));
        if (foreign.length > 0)
          throw new AppStateError(
            `${foreign.map((r) => `${r.table}.${r.column}`).join(', ')} refer(s) to ${[...new Set(foreign.map((r) => r.ref))].join(', ')}, which the uninstall removes.`,
            'These columns are not declared by the modules being removed (added by hand or by another tool): drop them first.',
          );
        report(plan);

        const live = await readLiveSchema(pin);
        const before = new Set(diffSchema(oldSchema, live).map(signature));
        const t0 = Date.now();
        emit({
          type: 'step',
          step: purge ? 'drop' : 'quarantine',
          status: 'start',
          module: undefined,
        });
        for (const c of columns) {
          if (!purge) {
            const stash = stashName(c.table, c.column);
            await conn.query(
              compile(
                sql`CREATE TABLE ${sql.id(QUARANTINE_SCHEMA, stash)} AS SELECT id, ${sql.id(c.column)} AS value FROM ${sql.id('public', c.table)} WHERE ${sql.id(c.column)} IS NOT NULL`,
              ),
            );
            await conn.query(
              compile(
                sql`INSERT INTO "shutro_quarantine"."item" (module, kind, table_name, column_name, stash) VALUES (${c.module}, 'column', ${c.table}, ${c.column}, ${stash})`,
              ),
            );
          }
          await conn.query(
            compile(sql`ALTER TABLE ${sql.id('public', c.table)} DROP COLUMN ${sql.id(c.column)}`),
          );
        }
        if (purge) {
          if (gone.length > 0)
            await conn.query(
              compile(sql`DROP TABLE ${sql.join(gone.map((t) => sql.id('public', t)))}`),
            );
        } else {
          for (const t of tables) {
            const outgoing = await conn.query<SavedForeignKey & Row>(
              compile(
                sql`SELECT c.conname AS name, a.attname AS "column", rt.relname AS "refTable", ra.attname AS "refColumn", c.confdeltype AS "onDelete"
                  FROM pg_constraint c
                  JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                  JOIN pg_class rt ON rt.oid = c.confrelid
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                  JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
                  WHERE c.contype = 'f' AND n.nspname = 'public' AND t.relname = ${t.table}
                    AND NOT (rt.relname = ANY(${sql.array(gone, 'text')}))`,
              ),
            );
            for (const fk of outgoing)
              await conn.query(
                compile(
                  sql`ALTER TABLE ${sql.id('public', t.table)} DROP CONSTRAINT ${sql.id(fk.name)}`,
                ),
              );
            if (await exists(conn, QUARANTINE_SCHEMA, t.table))
              throw new AppStateError(
                `The quarantine already holds a table named ${t.table}.`,
                `Purge it first: shutro apps purge --now ${t.module}.`,
              );
            await conn.query(
              compile(
                sql`ALTER TABLE ${sql.id('public', t.table)} SET SCHEMA ${sql.id(QUARANTINE_SCHEMA)}`,
              ),
            );
            const saved = outgoing.map((fk) => ({
              name: fk.name,
              column: fk.column,
              refTable: fk.refTable,
              refColumn: fk.refColumn,
              onDelete: fk.onDelete,
            }));
            await conn.query(
              compile(
                sql`INSERT INTO "shutro_quarantine"."item" (module, kind, table_name, foreign_keys) VALUES (${t.module}, 'table', ${t.table}, (${sql.param(JSON.stringify(saved), 'text')})::jsonb)`,
              ),
            );
          }
        }
        // Indexes and constraints the removed extensions put on tables that stay.
        const after = diffSchema(newSchema, await readLiveSchema(pin)).filter(
          (op) =>
            (op.kind === 'dropConstraint' || op.kind === 'dropIndex') && !before.has(signature(op)),
        );
        for (const op of after) await run(conn, renderOperation(op));
        for (const name of removed) {
          if (purge) await forgetData(conn, name, () => {});
          await conn.query(
            compile(
              purge
                ? sql`UPDATE "shutro_module" SET state = 'uninstalled', quarantined_at = NULL, updated_at = now() WHERE name = ${name}`
                : sql`UPDATE "shutro_module" SET state = 'quarantined', quarantined_at = now(), updated_at = now() WHERE name = ${name}`,
            ),
          );
        }
        emit({
          type: 'step',
          step: purge ? 'drop' : 'quarantine',
          status: 'done',
          module: undefined,
          ms: Date.now() - t0,
          detail: `${tables.length} table(s), ${columns.length} column(s)`,
        });
        return { plan, registry: next };
      },
    );
  }

  async function upgrade(
    requested: readonly string[] | undefined,
    opts: UpgradeOptions,
    dryRun: boolean,
  ): Promise<AppResult<UpgradePlan>> {
    return operate<UpgradePlan>(
      'upgrade',
      requested ?? [],
      opts,
      dryRun,
      async ({ conn, pin, state, emit, warn, planned: report }) => {
        const installed = installedOf(state);
        for (const name of requested ?? []) {
          get(name);
          if (!installed.has(name))
            throw new AppStateError(
              `'${name}' is not installed.`,
              `Install it: shutro apps install ${name}.`,
            );
        }
        const registry = registryOf(installed);
        const candidates = sorted(requested ?? installed);
        const upgrading = candidates.filter(
          (n) => compareVersions(get(n).version, state.get(n)?.version ?? '0.0.0') > 0,
        );
        const live = await readLiveSchema(pin);
        const ops = diffSchema(desiredSchema(registry), live).filter((op) => {
          if (op.kind !== 'dropTable') return true;
          warn(
            `${op.table} is no longer used by the installed modules; it is kept (drop it in a migration file).`,
          );
          return false;
        });
        const destructive = ops.filter((op) => op.destructive).map(renderOperation);
        const plan: UpgradePlan = {
          operation: 'upgrade',
          modules: upgrading.map((n) =>
            planned(n, 'upgrade', false, state.get(n)?.version ?? null),
          ),
          statements: ops.map(renderOperation),
          destructive,
        };
        report(plan);
        if (destructive.length > 0 && opts.allowDestructive !== true)
          throw new DestructiveMigrationError('the upgrade', destructive);
        const t0 = Date.now();
        emit({ type: 'step', step: 'schema', status: 'start', module: undefined });
        for (const statement of plan.statements) await run(conn, statement);
        for (const statement of historyStatements(registry)) await conn.query(statement);
        emit({
          type: 'step',
          step: 'schema',
          status: 'done',
          module: undefined,
          ms: Date.now() - t0,
        });
        for (const name of upgrading) {
          const t1 = Date.now();
          emit({ type: 'step', step: 'hooks', status: 'start', module: name });
          const ran = await runHooks(conn, registry, name, state.get(name)?.version ?? '0.0.0');
          await conn.query(
            compile(
              sql`UPDATE "shutro_module" SET version = ${get(name).version}, updated_at = now() WHERE name = ${name}`,
            ),
          );
          emit({
            type: 'step',
            step: 'hooks',
            status: 'done',
            module: name,
            ms: Date.now() - t1,
            detail: `${ran} hook(s)`,
          });
        }
        const shutro = createShutro({ driver: pin, registry });
        const t2 = Date.now();
        emit({ type: 'step', step: 'data', status: 'start', module: undefined });
        const results = await loadData(
          shutro,
          opts.company === undefined ? {} : { company: opts.company },
        );
        for (const result of results)
          for (const kept of result.retained) warn(`Kept ${kept.id}: ${kept.reason}.`);
        emit({
          type: 'step',
          step: 'data',
          status: 'done',
          module: undefined,
          ms: Date.now() - t2,
        });
        return { plan, registry };
      },
    );
  }

  return {
    catalog: full.modules,
    state: () => readState(driver),
    async installed() {
      return sorted(installedOf(await readState(driver)));
    },
    async registry() {
      return registryOf(installedOf(await readState(driver)));
    },
    async list() {
      const state = await readState(driver);
      return order.map((name): AppInfo => {
        const m = get(name);
        const row = state.get(name);
        const status = row?.state ?? 'available';
        return {
          name,
          label: m.label,
          summary: m.summary,
          category: m.category,
          icon: m.icon,
          glyph: m.glyph,
          application: m.application,
          autoInstall: m.autoInstall,
          required: m.required,
          version: m.version,
          installedVersion: row?.version ?? null,
          state: status,
          upgradable:
            status === 'installed' && compareVersions(m.version, row?.version ?? m.version) > 0,
          depends: m.depends.map((d) => d.name),
          dependents: order.filter((n) => get(n).depends.some((d) => d.name === name)),
          models: m.models.map((model) => model.name),
          purgeAfter:
            status === 'quarantined' && row?.quarantinedAt != null
              ? new Date(row.quarantinedAt.getTime() + retentionDays * 86_400_000)
              : null,
        };
      });
    },
    planInstall: async (modules) => (await install(modules, {}, true)).plan,
    install: (modules, opts = {}) => install(modules, opts, false),
    planUninstall: async (modules, opts = {}) => (await uninstall(modules, opts, true)).plan,
    uninstall: (modules, opts = {}) => uninstall(modules, opts, false),
    planUpgrade: async (modules) => (await upgrade(modules, {}, true)).plan,
    upgrade: (modules, opts = {}) => upgrade(modules, opts, false),
    purge(opts = {}) {
      return operate<PurgePlan>(
        'purge',
        opts.modules ?? [],
        opts,
        false,
        async ({ conn, pin, state, emit, warn, planned: report }) => {
          for (const name of opts.modules ?? []) {
            get(name);
            if (state.get(name)?.state !== 'quarantined')
              throw new AppStateError(
                `'${name}' is not quarantined.`,
                'Only uninstalled apps whose data is in quarantine can be purged.',
              );
          }
          const due = await conn.query<{ name: string }>(
            compile(
              sql`SELECT name FROM "shutro_module" WHERE state = 'quarantined' AND (quarantined_at < now() - make_interval(days => ${retentionDays}) OR name = ANY(${sql.array(opts.modules ?? [], 'text')})) ORDER BY name`,
            ),
          );
          const tables = await conn.query<{ table_name: string }>(
            compile(
              sql`SELECT table_name FROM "shutro_quarantine"."item" WHERE kind = 'table' AND module = ANY(${sql.array(
                due.map((d) => d.name),
                'text',
              )}) ORDER BY table_name`,
            ),
          );
          const plan: PurgePlan = {
            operation: 'purge',
            modules: due.map((d) =>
              planned(d.name, 'requested', false, state.get(d.name)?.version ?? null),
            ),
            tables: tables.map((t) => t.table_name),
          };
          report(plan);
          const warnings: string[] = [];
          await purgeExpired(conn, pin, opts.modules ?? [], emit, warnings);
          for (const w of warnings) warn(w);
          return { plan, registry: registryOf(installedOf(await readState(conn))) };
        },
      );
    },
    async attach(shutro) {
      const refresh = async (): Promise<void> => {
        shutro.useRegistry(registryOf(installedOf(await readState(driver))));
      };
      await refresh();
      return driver.listen(MODULES_CHANNEL, () => {
        refresh().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.emitWarning(`Shutro could not follow an app change: ${message}`, {
            code: 'SHUTRO_APPS_FOLLOW_FAILED',
          });
        });
      });
    },
  };
}
