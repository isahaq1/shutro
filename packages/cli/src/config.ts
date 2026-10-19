/**
 * `shutro.config.ts`: the module files of an application and where its application view goes.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from './errors.js';
import { allowJsSpecifiersForTs, isPackageSpecifier, resolvePackageEntry } from './resolve.js';

/** The exported config. Paths are relative to the config file. */
export interface ShutroConfig {
  /**
   * Module files (`./modules/sale/module.ts`, one module each) and module packages (`'@shutro/apps'`, any number of
   * modules each). Every module in the dependency graph must be listed. With `install`, this is the catalog: the
   * modules a database may install.
   */
  readonly modules: readonly string[];
  /**
   * The apps a fresh database installs (RFC 0019 §7.3). Setting it makes the database's installed set authoritative:
   * `shutro apps install | uninstall` change it, and `migrate` works on the installed modules only. Without it, every
   * listed module is part of the application.
   */
  readonly install?: readonly string[];
  /** Days an uninstalled app's data stays in quarantine before it is purged (default 30). */
  readonly retentionDays?: number;
  /** Directory of the application view (`.shutro/` is created inside it). Omit for a module-only package. */
  readonly app?: string;
  /** Directory of the versioned SQL migrations (default `./migrations`). */
  readonly migrations?: string;
  /** PostgreSQL URL for `migrate`, `apps` and `doctor`; `SHUTRO_DATABASE_URL` wins over it. */
  readonly database?: string;
  /** Filled by {@link loadConfig}: resolved entry file → the package specifier it came from. */
  readonly packages?: Readonly<Record<string, string>>;
}

/** Identity helper that types the config file. */
export function defineConfig(config: ShutroConfig): ShutroConfig {
  return config;
}

const isStringList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((m) => typeof m === 'string');

function isConfig(value: unknown): value is ShutroConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const optionalString = (key: string): boolean =>
    c[key] === undefined || typeof c[key] === 'string';
  return (
    isStringList(c['modules']) &&
    (c['install'] === undefined || isStringList(c['install'])) &&
    (c['retentionDays'] === undefined ||
      (typeof c['retentionDays'] === 'number' && c['retentionDays'] >= 0)) &&
    optionalString('app') &&
    optionalString('migrations') &&
    optionalString('database')
  );
}

/** Loads a config file (default export or `config`), resolving its paths against the file's directory. */
export async function loadConfig(file: string): Promise<{ config: ShutroConfig; dir: string }> {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new ConfigError(
      `Config file ${path} does not exist.`,
      'Run "shutro init" to create a project, or create shutro.config.ts with `export default defineConfig({ modules: [...] })`, or pass --config.',
    );
  }
  allowJsSpecifiersForTs();
  let loaded: { default?: unknown; config?: unknown };
  try {
    loaded = (await import(pathToFileURL(path).href)) as typeof loaded;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND')
      throw new ConfigError(
        `${path} imports a package that is not installed (${error instanceof Error ? error.message : String(error)}).`,
        'Install the project dependencies first: npm install (or pnpm install).',
      );
    throw error;
  }
  const config = loaded.default ?? loaded.config;
  if (!isConfig(config)) {
    throw new ConfigError(
      `${path} does not export a config.`,
      'Export `defineConfig({ modules: ["./modules/base/module.ts", ...], app: "./app" })` as default.',
    );
  }
  const dir = resolve(path, '..');
  const packages: Record<string, string> = {};
  const modules = config.modules.map((m) => {
    if (isAbsolute(m)) return m;
    if (!isPackageSpecifier(m)) return resolve(dir, m);
    const entry = resolvePackageEntry(m, dir);
    packages[entry] = m;
    return entry;
  });
  return {
    dir,
    config: {
      modules,
      ...(config.install === undefined ? {} : { install: config.install }),
      ...(config.retentionDays === undefined ? {} : { retentionDays: config.retentionDays }),
      ...(config.app === undefined
        ? {}
        : { app: isAbsolute(config.app) ? config.app : resolve(dir, config.app) }),
      migrations: resolve(dir, config.migrations ?? './migrations'),
      ...(config.database === undefined ? {} : { database: config.database }),
      ...(Object.keys(packages).length === 0 ? {} : { packages }),
    },
  };
}
