/**
 * The project a command works on: the config, its modules loaded into a registry, and (when needed) a driver.
 */
import { buildRegistry, type Registry } from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { loadConfig, type ShutroConfig } from './config.js';
import { CliError, ModuleSourceError } from './errors.js';
import { dependant, loadSources } from './generate/generate.js';

/** A loaded project. */
export interface Project {
  readonly config: ShutroConfig;
  readonly dir: string;
  readonly registry: Registry;
}

/** Loads the config and builds the registry of its modules. */
export async function loadProject(configFile: string): Promise<Project> {
  const { config, dir } = await loadConfig(configFile);
  const sources = await loadSources(config.modules);
  const registry = buildRegistry({
    modules: [...sources.values()].map((s) => s.module),
  }) as Registry;
  for (const module of registry.modules) {
    if (!sources.has(module.name))
      throw new ModuleSourceError(module.name, dependant(registry, module.name));
  }
  return { config, dir, registry };
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
  const driver = createDriver({ url, max: 2 });
  try {
    return await fn(driver);
  } finally {
    await driver.end();
  }
}
