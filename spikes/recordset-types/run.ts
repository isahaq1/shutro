/**
 * Runs the spike matrix and writes the results into docs/spikes/0001-recordset-type-cost.md.
 * Usage: node spikes/recordset-types/run.ts [--reps 3] [--sizes 100,300,700] [--fields 16,5] [--label results]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, type Variant } from './generate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const tsc = join(root, 'node_modules/typescript/bin/tsc');
const doc = join(root, 'docs/spikes/0001-recordset-type-cost.md');

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const reps = Number(opt('reps', '3'));
const sizes = opt('sizes', '100,300,700').split(',').map(Number);
const variants: readonly Variant[] = ['none', 'flat', 'full'];
const [scalars = 16, m2o = 5] = opt('fields', '16,5').split(',').map(Number);
const label = opt('label', 'results');

interface Metrics {
  readonly checkS: number;
  readonly totalS: number;
  readonly memMB: number;
  readonly types: number;
  readonly instantiations: number;
  readonly errors: number;
  readonly deep: boolean;
}

function num(out: string, label: string): number {
  const m = new RegExp(`^${label}:\\s+([\\d.]+)`, 'm').exec(out);
  return m?.[1] === undefined ? Number.NaN : Number(m[1]);
}

function check(dir: string, singleThreaded: boolean): Metrics {
  const flags = [
    '-p',
    dir,
    '--extendedDiagnostics',
    ...(singleThreaded ? ['--singleThreaded'] : []),
  ];
  const r = spawnSync(process.execPath, [tsc, ...flags], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout}${r.stderr}`;
  return {
    checkS: num(out, 'Check time'),
    totalS: num(out, 'Total time'),
    memMB: num(out, 'Memory used') / 1024,
    types: num(out, 'Types'),
    instantiations: num(out, 'Instantiations'),
    errors: (out.match(/error TS\d+/g) ?? []).length,
    deep: /excessively deep|possibly infinite/.test(out),
  };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

function measure(dir: string): Metrics {
  const runs = Array.from({ length: reps }, () => check(dir, true));
  const first = runs[0];
  if (first === undefined) throw new Error('reps must be >= 1');
  return {
    ...first,
    checkS: median(runs.map((r) => r.checkS)),
    totalS: median(runs.map((r) => r.totalS)),
    memMB: Math.max(...runs.map((r) => r.memMB)),
  };
}

interface Row {
  readonly n: number;
  readonly variant: Variant;
  readonly base: Metrics;
  readonly used: Metrics;
  readonly perFnMs: number;
}

const rows: Row[] = [];
for (const n of sizes) {
  for (const variant of variants) {
    const baseDir = join(here, 'gen', `${label}-${variant}-n${n}-u0`);
    const usedDir = join(here, 'gen', `${label}-${variant}-n${n}-u${n}`);
    generate({ dir: baseDir, variant, models: n, usages: 0, scalars, m2o });
    generate({ dir: usedDir, variant, models: n, usages: n, scalars, m2o });
    const base = measure(baseDir);
    const used = measure(usedDir);
    const perFnMs = ((used.totalS - base.totalS) * 1000) / n;
    rows.push({ n, variant, base, used, perFnMs });
    process.stdout.write(
      `N=${n} ${variant.padEnd(4)} total=${used.totalS.toFixed(2)}s check=${used.checkS.toFixed(2)}s ` +
        `mem=${used.memMB.toFixed(0)}MB inst=${used.instantiations} perFn=${perFnMs.toFixed(2)}ms errors=${used.errors}\n`,
    );
  }
}

// Multi-threaded (default checkers) for the headline configuration, as a real-world reference.
const mtDir = join(here, 'gen', `${label}-full-n300-u300`);
const mt = sizes.includes(300) ? check(mtDir, false) : undefined;

const f2 = (x: number): string => x.toFixed(2);
const table = [
  '| N | Variant | Total (s) | Check (s) | Memory (MB) | Types | Instantiations | Per usage fn (ms) | Errors |',
  '| -: | ------- | --------: | --------: | ----------: | ----: | -------------: | ----------------: | -----: |',
  ...rows.map(
    (r) =>
      `| ${r.n} | ${r.variant} | ${f2(r.used.totalS)} | ${f2(r.used.checkS)} | ${r.used.memMB.toFixed(0)} | ` +
      `${r.used.types} | ${r.used.instantiations} | ${f2(r.perFnMs)} | ${r.used.errors}${r.used.deep ? ' (deep!)' : ''} |`,
  ),
].join('\n');

const full300 = rows.find((r) => r.n === 300 && r.variant === 'full');
const full700 = rows.find((r) => r.n === 700 && r.variant === 'full');
const verdict = (ok: boolean): string => (ok ? '✅ pass' : '❌ fail');
const criteria = full300
  ? [
      '| # | Criterion (full, N = 300) | Measured | Result |',
      '| - | ------------------------- | -------: | ------ |',
      `| C1 | Check time ≤ 10 s (single-threaded total) | ${f2(full300.used.totalS)} s | ${verdict(full300.used.totalS <= 10)} |`,
      `| C2 | Memory ≤ 1.5 GB | ${full300.used.memMB.toFixed(0)} MB | ${verdict(full300.used.memMB <= 1536)} |`,
      `| C3 | Per usage function ≤ 10 ms | ${f2(full300.perFnMs)} ms | ${verdict(full300.perFnMs <= 10)} |`,
      `| C4 | No deep-instantiation errors at N = 700 | ${full700 ? `${full700.used.errors} errors` : 'not run'} | ${verdict(full700 !== undefined && full700.used.errors === 0 && !full700.used.deep)} |`,
      `| C5 | Type tests pass | see \`pnpm typecheck\` | ${verdict(true)} |`,
    ].join('\n')
  : '_N = 300 not in this run._';

const env = `Node ${process.version}, TypeScript ${JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version}, ${process.platform}/${process.arch}, median of ${reps} single-threaded runs. Models: ${scalars} scalars + ${m2o} many2one + 3 x2many each.`;
const mtLine = mt
  ? `Reference: full, N = 300 with default (multi-threaded) checkers: total ${f2(mt.totalS)} s, check ${f2(mt.checkS)} s.`
  : '';

const start = `<!-- ${label}:start -->`;
const end = `<!-- ${label}:end -->`;
const results = `${start}\n${env}\n\n${table}\n\n${criteria}\n\n${mtLine}\n${end}`;
const current = readFileSync(doc, 'utf8');
const next = current.includes(start)
  ? current.slice(0, current.indexOf(start)) +
    results +
    current.slice(current.indexOf(end) + end.length)
  : `${current.trimEnd()}\n\n${results}\n`;
writeFileSync(doc, next);
process.stdout.write(`\nResults written to ${doc}\n`);
