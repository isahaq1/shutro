/**
 * @packageDocumentation
 * `@shutro/migrate`: schema diff against the live database, versioned SQL migrations, and per-module data-migration
 * hooks (`CLAUDE.md` layer 12).
 *
 * @example
 * ```ts
 * const plan = await planMigration({ driver, registry });
 * await writeMigrationFile({ dir: 'migrations', name: 'add_margin', plan });
 * await applyMigrations({ driver, dir: 'migrations', registry });
 * ```
 */
export {
  applyMigrations,
  type MigrationFile,
  type MigrationPlan,
  type MigrationResult,
  type MigrationStatus,
  migrationStatus,
  parseMigrationFile,
  planMigration,
  writeMigrationFile,
} from './apply.js';
export {
  type AffectedColumn,
  type AffectedTable,
  type AppEvent,
  type AppInfo,
  type AppManager,
  type AppManagerOptions,
  type AppPlan,
  type AppResult,
  type AppStep,
  createAppManager,
  type InstallOptions,
  type InstallPlan,
  MODULES_CHANNEL,
  type ModuleRecord,
  type ModuleState,
  type OperationOptions,
  type PlannedModule,
  type PlanReason,
  type PurgeOptions,
  type PurgePlan,
  QUARANTINE_SCHEMA,
  type UninstallOptions,
  type UninstallPlan,
  type UpgradeOptions,
  type UpgradePlan,
} from './apps.js';
export { normalizeDefault, readLiveSchema } from './catalog.js';
export { diffSchema, type Operation } from './diff.js';
export {
  AppDependentsError,
  AppStateError,
  DestructiveMigrationError,
  MigrationChecksumError,
  MigrationError,
  type MigrationErrorCode,
  MigrationFileError,
  UninstallBlockedError,
  UnknownAppError,
} from './errors.js';
export { renderOperation, renderOperations } from './render.js';
export {
  type ColumnSpec,
  canonicalType,
  columnName,
  desiredSchema,
  type ForeignKeySpec,
  type IndexSpec,
  type LiveSchema,
  literalOf,
  type Schema,
  type TableSpec,
} from './schema.js';
