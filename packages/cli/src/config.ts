/**
 * `shutro.config.ts`: the module files of an application and where its application view goes.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError } from './errors.js';

/** The exported config. Paths are relative to the config file. */
export interface ShutroConfig {
  /** One module file per module (`modules/sale/module.ts`); every module in the dependency graph must be listed. */
  readonly modules: readonly string[];
  /** Directory of the application view (`.shutro/` is created inside it). Omit for a module-only package. */
  readonly app?: string;
}

/** Identity helper that types the config file. */
export function defineConfig(config: ShutroConfig): ShutroConfig {
  return config;
}

function isConfig(value: unknown): value is ShutroConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as { modules?: unknown; app?: unknown };
  return (
    Array.isArray(c.modules) &&
    c.modules.every((m) => typeof m === 'string') &&
    (c.app === undefined || typeof c.app === 'string')
  );
}

/** Loads a config file (default export or `config`), resolving its paths against the file's directory. */
export async function loadConfig(file: string): Promise<{ config: ShutroConfig; dir: string }> {
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new ConfigError(
      `Config file ${path} does not exist.`,
      'Create shutro.config.ts with `export default defineConfig({ modules: [...] })`, or pass --config.',
    );
  }
  const loaded = (await import(pathToFileURL(path).href)) as {
    default?: unknown;
    config?: unknown;
  };
  const config = loaded.default ?? loaded.config;
  if (!isConfig(config)) {
    throw new ConfigError(
      `${path} does not export a config.`,
      'Export `defineConfig({ modules: ["./modules/base/module.ts", ...], app: "./app" })` as default.',
    );
  }
  const dir = resolve(path, '..');
  return {
    dir,
    config: {
      modules: config.modules.map((m) => (isAbsolute(m) ? m : resolve(dir, m))),
      ...(config.app === undefined
        ? {}
        : { app: isAbsolute(config.app) ? config.app : resolve(dir, config.app) }),
    },
  };
}
