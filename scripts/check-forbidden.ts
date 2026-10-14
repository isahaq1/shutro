/**
 * Repository rules that Biome can't express (RFC 0007 §7.3). Run by `pnpm lint` and CI:
 *   node scripts/check-forbidden.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Path prefixes (repo-relative, `/`-separated) where the pattern is allowed. */
  readonly allowedIn: readonly string[];
  readonly reason: string;
}

export const RULES: readonly Rule[] = [
  {
    name: 'no-unsafe',
    pattern: /\.unsafe\s*\(/,
    allowedIn: ['packages/driver-pg/src/'],
    reason:
      'postgres.js unsafe() runs raw SQL text; only @shutro/driver-pg may call it. Build queries with sql`...` from @shutro/sql.',
  },
  {
    name: 'no-direct-postgres-import',
    pattern: /from\s+['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)/,
    allowedIn: ['packages/driver-pg/src/'],
    reason:
      'Only @shutro/driver-pg imports postgres.js (RFC 0007 §7.1). Use Driver / DriverConnection instead.',
  },
];

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: Rule;
}

/** Checks the given files (repo-relative path → content). */
export function findViolations(
  files: ReadonlyMap<string, string>,
  rules: readonly Rule[] = RULES,
): Violation[] {
  const out: Violation[] = [];
  for (const [file, content] of files) {
    content.split('\n').forEach((text, i) => {
      for (const rule of rules) {
        if (rule.pattern.test(text) && !rule.allowedIn.some((prefix) => file.startsWith(prefix))) {
          out.push({ file, line: i + 1, rule });
        }
      }
    });
  }
  return out;
}

/** Production sources: `packages/<name>/src/**​/*.ts`. Tests and spikes may use postgres.js directly. */
function collectSources(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts'))
        files.set(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
  };
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // package without src/
    }
  }
  return files;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const violations = findViolations(collectSources(root));
  for (const v of violations) {
    process.stderr.write(`${v.file}:${v.line}  [${v.rule.name}] ${v.rule.reason}\n`);
  }
  if (violations.length > 0) process.exit(1);
  process.stdout.write('check-forbidden: ok\n');
}
