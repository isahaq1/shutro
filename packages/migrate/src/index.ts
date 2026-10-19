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
export { normalizeDefault, readLiveSchema } from './catalog.js';
export { diffSchema, type Operation } from './diff.js';
export {
  DestructiveMigrationError,
  MigrationChecksumError,
  MigrationError,
  type MigrationErrorCode,
  MigrationFileError,
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
