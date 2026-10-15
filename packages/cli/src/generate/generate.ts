/**
 * `shutro generate`: loads the module files of the config, builds one registry per module (its view) and one for
 * the application, and writes the generated files, or reports which ones are stale (`--check`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildRegistry, isModule, type ModuleBase, type Registry } from '@shutro/core';
import type { ShutroConfig } from '../config.js';
import { ConfigError, ModuleSourceError } from '../errors.js';
import {
  type ModuleSource,
  outDirOf,
  renderAppIndex,
  renderBindings,
  renderSchema,
} from './render.js';

/** Options of {@link generate}. */
export interface GenerateOptions {
  readonly config: ShutroConfig;
  /** Directory the config paths were resolved against. */
  readonly cwd: string;
  /** Report stale files without writing. */
  readonly check?: boolean | undefined;
  /** Mirror the generated tree under this directory instead of next to the sources (tests, previews). */
  readonly outRoot?: string | undefined;
}

/** One generated file and what happened to it. */
export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
  readonly status: 'unchanged' | 'created' | 'updated';
}

/** Result of {@link generate}. */
export interface GenerateResult {
  readonly files: readonly GeneratedFile[];
  /** Files that were (or, with `check`, would be) created or updated. */
  readonly changed: readonly GeneratedFile[];
  /** Module names in load order. */
  readonly modules: readonly string[];
}

async function loadSources(files: readonly string[]): Promise<Map<string, ModuleSource>> {
  const sources = new Map<string, ModuleSource>();
  for (const file of files) {
    if (!existsSync(file)) {
      throw new ConfigError(
        `Module file ${file} does not exist.`,
        'Check `modules` in shutro.config.ts.',
      );
    }
    const ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const found = Object.entries(ns).filter(([, value]) => isModule(value));
    if (found.length !== 1) {
      throw new ConfigError(
        `${file} exports ${found.length} modules; expected exactly one.`,
        'Export one `defineModule(...)` per file (models can live in other files).',
      );
    }
    const [exportName, module] = found[0] as [string, ModuleBase];
    const existing = sources.get(module.name);
    if (existing !== undefined) {
      throw new ConfigError(
        `Module '${module.name}' is exported by both ${existing.file} and ${file}.`,
        'List each module file once.',
      );
    }
    sources.set(module.name, { module, file, exportName });
  }
  return sources;
}

function dependant(registry: Registry, missing: string): string {
  const reaches = (m: ModuleBase): boolean =>
    m.depends.some((d) => d.name === missing || reaches(d));
  return registry.modules.find((m) => reaches(m))?.name ?? missing;
}

/** Generates the per-module views and the application view described by `config`. */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { config, cwd } = options;
  const sources = await loadSources(config.modules);
  const all = buildRegistry({ modules: [...sources.values()].map((s) => s.module) });
  for (const module of all.modules) {
    if (!sources.has(module.name))
      throw new ModuleSourceError(module.name, dependant(all, module.name));
  }

  const rendered: { path: string; content: string }[] = [];
  for (const module of all.modules) {
    const source = sources.get(module.name) as ModuleSource;
    const view = buildRegistry({ modules: [source.module] });
    const outDir = outDirOf(source.file);
    const title = `Schema view of module \`${module.name}\` (RFC 0002 §7.7): the models it owns or depends on, with the extensions it can see.`;
    rendered.push({
      path: join(outDir, 'schema.d.ts'),
      content: renderSchema(view, sources, outDir, title),
    });
    rendered.push({
      path: join(outDir, 'bindings.ts'),
      content: renderBindings(view, module.name),
    });
  }
  if (config.app !== undefined) {
    const outDir = join(config.app, '.shutro');
    const title = `Application view: every installed module (${all.loadOrder.join(', ')}).`;
    rendered.push({
      path: join(outDir, 'schema.d.ts'),
      content: renderSchema(all, sources, outDir, title),
    });
    rendered.push({ path: join(outDir, 'index.ts'), content: renderAppIndex(all) });
  }

  const files: GeneratedFile[] = [];
  for (const { path, content } of rendered) {
    const target =
      options.outRoot === undefined ? path : join(options.outRoot, relative(cwd, path));
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    const status =
      current === undefined ? 'created' : current === content ? 'unchanged' : 'updated';
    if (status !== 'unchanged' && options.check !== true) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    files.push({ path: target, content, status });
  }
  return { files, changed: files.filter((f) => f.status !== 'unchanged'), modules: all.loadOrder };
}
