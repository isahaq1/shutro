/**
 * The project a command works on: the config, its modules loaded into a registry, and (when needed) a driver.
 */
import { buildRegistry, type ModuleBase, type Registry, toDecimal } from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { loadConfig, type ShutroConfig } from './config.js';
import { CliError, ModuleSourceError } from './errors.js';
import { dependant, loadSources } from './generate/generate.js';

/** A loaded project. */
export interface Project {
  readonly config: ShutroConfig;
  readonly dir: string;
  /** Every listed module, with its dependencies. */
  readonly registry: Registry;
  /** The listed modules. */
  readonly modules: readonly ModuleBase[];
}

/** Loads the config and builds the registry of its modules. */
export async function loadProject(configFile: string): Promise<Project> {
  const { config, dir } = await loadConfig(configFile);
  const sources = await loadSources(config.modules, config.packages);
  const modules = [...sources.values()].map((s) => s.module);
  const registry = buildRegistry({ modules }) as Registry;
  for (const module of registry.modules) {
    if (!sources.has(module.name))
      throw new ModuleSourceError(module.name, dependant(registry, module.name));
  }
  return { config, dir, registry, modules };
}

/** The database URL: `SHUTRO_DATABASE_URL`, else the config's `database`. */
export function databaseUrl(
  config: ShutroConfig,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const url = env['SHUTRO_DATABASE_URL'] ?? config.database;
  if (url === undefined || url === '') {
    throw new CliError(
      'No database is configured.',
      'Set SHUTRO_DATABASE_URL, or database: "postgres://..." in shutro.config.ts.',
    );
  }
  return url;
}

/** Runs `fn` with a driver on the project's database and closes it afterwards. */
export async function withDriver<T>(url: string, fn: (driver: Driver) => Promise<T>): Promise<T> {
  const driver = createDriver({ url, max: 3, parseNumeric: toDecimal });
  try {
    return await fn(driver);
  } finally {
    await driver.end();
  }
}
