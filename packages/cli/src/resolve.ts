/**
 * Loading TypeScript module sources (feedback #16), and module packages named in the config.
 *
 * Node runs `.ts` files by stripping types, but the `nodenext` convention writes imports between them as `./sale.js`.
 * The resolve hook retries a missing relative `.js` specifier imported from a `.ts` file as `.ts`, so both spellings
 * work without a loader.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './errors.js';

let registered = false;

/** Registers the `.js` → `.ts` fallback once per process. */
export function allowJsSpecifiersForTs(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        const fromTs = context.parentURL?.endsWith('.ts') === true;
        const missing = (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND';
        if (relative && fromTs && missing && specifier.endsWith('.js'))
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        throw error;
      }
    },
  });
}

/** True for `@scope/name[/sub]` and `name[/sub]`: not a relative or absolute path. */
export function isPackageSpecifier(spec: string): boolean {
  return !spec.startsWith('.') && !spec.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(spec);
}

/** When the CLI itself runs from TypeScript sources (the workspace), workspace packages resolve to sources too. */
const FROM_SOURCE = import.meta.url.endsWith('.ts');

function pick(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const conditions = entry as Record<string, unknown>;
  for (const condition of [...(FROM_SOURCE ? ['@shutro/source'] : []), 'import', 'default']) {
    const found = pick(conditions[condition]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function entryIn(packageJson: string, subpath: string): string | undefined {
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8')) as {
    exports?: unknown;
    main?: string;
  };
  const root = dirname(realpathSync(packageJson));
  const exportsField = pkg.exports;
  const isMap =
    typeof exportsField === 'object' &&
    exportsField !== null &&
    Object.keys(exportsField).some((k) => k.startsWith('.'));
  const target =
    exportsField === undefined
      ? subpath === '.'
        ? (pkg.main ?? 'index.js')
        : subpath
      : isMap
        ? pick((exportsField as Record<string, unknown>)[subpath])
        : subpath === '.'
          ? pick(exportsField)
          : undefined;
  return target === undefined ? undefined : resolve(root, target);
}

/**
 * The entry file of a module package (`'@acme/erp-modules'`, `'@acme/erp/sale'`), looked up in the `node_modules`
 * above `fromDir`, then in those above the CLI itself (a globally installed CLI).
 *
 * @throws {ConfigError} when the package or its entry cannot be found.
 */
export function resolvePackageEntry(specifier: string, fromDir: string): string {
  const parts = specifier.split('/');
  const scoped = specifier.startsWith('@');
  const name = parts.slice(0, scoped ? 2 : 1).join('/');
  const subpath = ['.', ...parts.slice(scoped ? 2 : 1)].join('/');
  const starts = [fromDir, dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      const packageJson = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(packageJson)) {
        const entry = entryIn(packageJson, subpath);
        if (entry !== undefined && existsSync(entry)) return entry;
      }
      if (dirname(dir) === dir) break;
    }
  }
  throw new ConfigError(
    `The module package '${specifier}' cannot be found from ${fromDir}.`,
    `Install it (npm install ${name}), or list module files instead.`,
  );
}
