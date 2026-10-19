/**
 * Assembles the single npm package `shutro` from the built workspace packages (run `pnpm build` first):
 *
 *   dist-npm/shutro/dist/<package>/…   one folder per workspace package (testing excluded)
 *
 * Imports between workspace packages (`@shutro/core`, …) are rewritten to relative paths, the CLI's emitted
 * specifiers become `shutro` / `shutro/cli`, and source maps are dropped (they point at sources not shipped).
 *
 * Usage: node scripts/pack-npm.ts [version] (default: the version being released, 0.2.1)
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist-npm', 'shutro');
const PACKAGES = [
  'sql',
  'driver-pg',
  'i18n',
  'security',
  'sequence',
  'audit',
  'core',
  'migrate',
  'apps',
  'cli',
];
const SUBPATHS: Readonly<Record<string, string>> = {
  '.': 'core',
  './sql': 'sql',
  './driver-pg': 'driver-pg',
  './migrate': 'migrate',
  './apps': 'apps',
  './cli': 'cli',
  './security': 'security',
  './audit': 'audit',
  './sequence': 'sequence',
  './i18n': 'i18n',
};
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])@shutro\/([a-z0-9-]+)\2/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function manifest(name: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
}

const version = process.argv[2] ?? '0.2.1';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const dependencies: Record<string, string> = {};
for (const name of PACKAGES) {
  const built = join(ROOT, 'packages', name, 'dist');
  if (!existsSync(join(built, 'index.js')))
    throw new Error(`packages/${name}/dist is missing: run pnpm build first.`);
  cpSync(built, join(OUT, 'dist', name), { recursive: true });
  for (const [dep, range] of Object.entries(manifest(name).dependencies ?? {}))
    if (!dep.startsWith('@shutro/')) dependencies[dep] = range;
}

for (const file of walk(join(OUT, 'dist'))) {
  if (file.endsWith('.map') || file.endsWith('.tsbuildinfo')) {
    rmSync(file);
    continue;
  }
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const text = readFileSync(file, 'utf8')
    .replace(SPECIFIER, (_all, lead: string, quote: string, pkg: string) => {
      if (!PACKAGES.includes(pkg))
        throw new Error(`${file} imports @shutro/${pkg}, which is not bundled.`);
      let path = relative(dirname(file), join(OUT, 'dist', pkg, 'index.js'))
        .split(sep)
        .join('/');
      if (!path.startsWith('.')) path = `./${path}`;
      return `${lead}${quote}${path}${quote}`;
    })
    .replace(/^\/\/# sourceMappingURL=.*$/m, '');
  writeFileSync(file, text);
}

// Generated and starter files import the published package (packages/cli/src/packages.ts).
for (const ext of ['js', 'd.ts']) {
  const file = join(OUT, 'dist', 'cli', `packages.${ext}`);
  const text = readFileSync(file, 'utf8')
    .replace(/(CORE_PACKAGE[^=]*=\s*)'@shutro\/core'/, "$1'shutro'")
    .replace(/(CLI_PACKAGE[^=]*=\s*)'@shutro\/cli'/, "$1'shutro/cli'");
  writeFileSync(file, text);
}

const leftovers = walk(join(OUT, 'dist')).filter((f) =>
  /from\s*['"]@shutro\//.test(readFileSync(f, 'utf8')),
);
if (leftovers.length > 0) throw new Error(`Unrewritten @shutro imports in ${leftovers.join(', ')}`);

const exports: Record<string, { types: string; default: string }> = {};
for (const [subpath, pkg] of Object.entries(SUBPATHS))
  exports[subpath] = { types: `./dist/${pkg}/index.d.ts`, default: `./dist/${pkg}/index.js` };

const pkg = {
  name: 'shutro',
  version,
  description:
    'The ORM built for business software: type-safe, secure-by-default, multi-company, audit-ready PostgreSQL ORM for Node.js and TypeScript.',
  keywords: [
    'orm',
    'postgresql',
    'postgres',
    'typescript',
    'erp',
    'accounting',
    'multi-company',
    'audit',
    'rls',
  ],
  author: { name: 'Isahaq', email: 'hmisahaq01@gmail.com' },
  license: 'MIT',
  homepage: 'https://github.com/isahaq1/shutro#readme',
  repository: { type: 'git', url: 'git+https://github.com/isahaq1/shutro.git' },
  bugs: { url: 'https://github.com/isahaq1/shutro/issues' },
  type: 'module',
  sideEffects: false,
  engines: { node: '>=24' },
  bin: { shutro: './dist/cli/bin.js' },
  exports,
  files: ['dist', 'README.md', 'LICENSE'],
  dependencies: Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  ),
};
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
cpSync(join(ROOT, 'README.md'), join(OUT, 'README.md'));
cpSync(join(ROOT, 'LICENSE'), join(OUT, 'LICENSE'));
process.stdout.write(
  `dist-npm/shutro ${version}: ${PACKAGES.length} packages, deps ${Object.keys(dependencies).join(', ')}\n`,
);
