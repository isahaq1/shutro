/**
 * Planning, versioned migration files, the ledger, and module data-migration hooks.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, type MigrationContext, type Registry } from '@shutro/core';
import type { Driver, DriverConnection } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { readLiveSchema } from './catalog.js';
import { diffSchema, type Operation } from './diff.js';
import { DestructiveMigrationError, MigrationChecksumError, MigrationFileError } from './errors.js';
import { renderOperation } from './render.js';
import { desiredSchema } from './schema.js';

/** A planned migration: operations, the destructive subset, and the rendered statements. */
export interface MigrationPlan {
  readonly operations: readonly Operation[];
  readonly destructive: readonly Operation[];
  /** Statements with their destructiveness, in execution order. */
  readonly statements: readonly { readonly sql: string; readonly destructive: boolean }[];
}

/** Compares the registry with the live database and plans the changes. */
export async function planMigration(options: {
  readonly driver: Driver;
  readonly registry: Registry;
  readonly schema?: string;
}): Promise<MigrationPlan> {
  const live = await readLiveSchema(options.driver, options.schema ?? 'public');
  const operations = diffSchema(desiredSchema(options.registry), live);
  return {
    operations,
    destructive: operations.filter((o) => o.destructive),
    statements: operations.map((o) => ({ sql: renderOperation(o), destructive: o.destructive })),
  };
}

const FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const DESTRUCTIVE_MARK = '-- destructive';

/** A migration file on disk. */
export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly path: string;
}

function listFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort()
    .map((f) => {
      const m = FILE.exec(f) as RegExpExecArray;
      return { version: m[1] as string, name: m[2] as string, path: join(dir, f) };
    });
}

/** Writes the plan as the next versioned file (`0001_name.sql`). */
export async function writeMigrationFile(options: {
  readonly dir: string;
  readonly name: string;
  readonly plan: MigrationPlan;
}): Promise<MigrationFile> {
  const { dir, name, plan } = options;
  if (!/^[a-z0-9_]+$/.test(name))
    throw new MigrationFileError(
      `${JSON.stringify(name)} is not a migration name.`,
      'Use lower-case letters, digits and underscores, e.g. "add_sale_margin".',
    );
  mkdirSync(dir, { recursive: true });
  const existing = listFiles(dir);
  const version = String(Number(existing.at(-1)?.version ?? '0') + 1).padStart(4, '0');
  const lines = [
    `-- shutro migration ${version}: ${name} (generated ${new Date().toISOString()})`,
    `-- ${plan.statements.length} statement(s), ${plan.destructive.length} destructive`,
    '',
  ];
  for (const s of plan.statements) {
    if (s.destructive) lines.push(DESTRUCTIVE_MARK);
    lines.push(`${s.sql};`, '');
  }
  const path = join(dir, `${version}_${name}.sql`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { version, name, path };
}

/** Parses a migration file into statements (comments dropped; `-- destructive` marks the next statement). */
export function parseMigrationFile(
  content: string,
): { readonly sql: string; readonly destructive: boolean }[] {
  const statements: { sql: string; destructive: boolean }[] = [];
  let buffer: string[] = [];
  let destructive = false;
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === DESTRUCTIVE_MARK) {
      destructive = true;
      continue;
    }
    if (line.trim().startsWith('--') || line.trim() === '') continue;
    buffer.push(line);
    if (line.endsWith(';')) {
      statements.push({ sql: buffer.join('\n').slice(0, -1), destructive });
      buffer = [];
      destructive = false;
    }
  }
  if (buffer.length > 0) statements.push({ sql: buffer.join('\n'), destructive });
  return statements;
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function ensureLedger(conn: DriverConnection): Promise<void> {
  await conn.query({
    text: 'CREATE TABLE IF NOT EXISTS "shutro_migration" ("version" text PRIMARY KEY, "name" text NOT NULL, "checksum" text NOT NULL, "applied_at" timestamp with time zone NOT NULL DEFAULT now())',
    params: [],
  });
  await conn.query({
    text: 'CREATE TABLE IF NOT EXISTS "shutro_module" ("name" text PRIMARY KEY, "version" text NOT NULL, "installed_at" timestamp with time zone NOT NULL DEFAULT now(), "updated_at" timestamp with time zone NOT NULL DEFAULT now())',
    params: [],
  });
}

/** Applied and pending migrations. */
export interface MigrationStatus {
  readonly applied: readonly {
    readonly version: string;
    readonly name: string;
    readonly appliedAt: Date;
  }[];
  readonly pending: readonly MigrationFile[];
}

/** Reads the ledger and the directory. @throws {MigrationChecksumError} when an applied file was edited. */
export async function migrationStatus(options: {
  readonly driver: Driver;
  readonly dir: string;
}): Promise<MigrationStatus> {
  const files = listFiles(options.dir);
  return options.driver.transaction({ isolation: 'read committed' }, async (conn) => {
    await ensureLedger(conn);
    const rows = await conn.query<{
      version: string;
      name: string;
      checksum: string;
      applied_at: Date;
    }>(
      compile(
        sql`SELECT version, name, checksum, applied_at FROM ${sql.id('shutro_migration')} ORDER BY version`,
      ),
    );
    const byVersion = new Map(rows.map((r) => [r.version, r]));
    for (const file of files) {
      const row = byVersion.get(file.version);
      if (row !== undefined && row.checksum !== checksum(readFileSync(file.path, 'utf8')))
        throw new MigrationChecksumError(file.path);
    }
    return {
      applied: rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at })),
      pending: files.filter((f) => !byVersion.has(f.version)),
    };
  });
}

/** Result of {@link applyMigrations}. */
export interface MigrationResult {
  readonly applied: readonly MigrationFile[];
  /** Modules whose recorded version changed (fresh installs have `from: null`). */
  readonly modules: readonly {
    readonly module: string;
    readonly from: string | null;
    readonly to: string;
  }[];
  /** Data-migration hooks that ran, in order. */
  readonly hooks: readonly { readonly module: string; readonly version: string }[];
}

/**
 * Applies pending migration files in order (each in its own transaction, recorded in `shutro_migration`), then runs
 * the data-migration hooks of upgraded modules and records module versions in `shutro_module`.
 *
 * @throws {DestructiveMigrationError} for a file with destructive statements unless `allowDestructive` is set.
 * @throws {MigrationChecksumError} when an applied file was edited.
 */
export async function applyMigrations(options: {
  readonly driver: Driver;
  readonly dir: string;
  readonly registry: Registry;
  readonly allowDestructive?: boolean;
}): Promise<MigrationResult> {
  const { driver, registry } = options;
  const status = await migrationStatus({ driver, dir: options.dir });
  const applied: MigrationFile[] = [];
  for (const file of status.pending) {
    const content = readFileSync(file.path, 'utf8');
    const statements = parseMigrationFile(content);
    const destructive = statements.filter((s) => s.destructive).map((s) => s.sql);
    if (destructive.length > 0 && options.allowDestructive !== true)
      throw new DestructiveMigrationError(file.path, destructive);
    await driver.transaction({ isolation: 'read committed' }, async (conn) => {
      for (const s of statements) await conn.query({ text: s.sql, params: [] });
      await conn.query(
        compile(
          sql`INSERT INTO ${sql.id('shutro_migration')} (version, name, checksum) VALUES (${file.version}, ${file.name}, ${checksum(content)})`,
        ),
      );
    });
    applied.push(file);
  }

  const modules: { module: string; from: string | null; to: string }[] = [];
  const hooks: { module: string; version: string }[] = [];
  for (const module of registry.modules) {
    await driver.transaction({ isolation: 'read committed' }, async (conn) => {
      await ensureLedger(conn);
      const [row] = await conn.query<{ version: string }>(
        compile(sql`SELECT version FROM ${sql.id('shutro_module')} WHERE name = ${module.name}`),
      );
      if (row === undefined) {
        await conn.query(
          compile(
            sql`INSERT INTO ${sql.id('shutro_module')} (name, version) VALUES (${module.name}, ${module.version})`,
          ),
        );
        modules.push({ module: module.name, from: null, to: module.version });
        return;
      }
      if (compareVersions(row.version, module.version) >= 0) return;
      const ctx: MigrationContext = {
        registry,
        sql: (strings, ...values) => conn.query(compile(sql(strings, ...values))),
      };
      for (const hook of module.migrations) {
        if (
          compareVersions(hook.version, row.version) <= 0 ||
          compareVersions(hook.version, module.version) > 0
        )
          continue;
        await hook.up(ctx);
        hooks.push({ module: module.name, version: hook.version });
      }
      await conn.query(
        compile(
          sql`UPDATE ${sql.id('shutro_module')} SET version = ${module.version}, updated_at = now() WHERE name = ${module.name}`,
        ),
      );
      modules.push({ module: module.name, from: row.version, to: module.version });
    });
  }
  return { applied, modules, hooks };
}
