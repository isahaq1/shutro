/**
 * `shutro migrate status | plan | write | apply` against PostgreSQL, on the fixture module graph.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type CliIo, runCli } from '../src/index.js';

const fixtures = join(import.meta.dirname, 'fixtures');
let pg: StartedPostgres;
let dir: string;
let configFile: string;

function io(): CliIo & { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: fixtures,
    env: { SHUTRO_DATABASE_URL: pg.url },
    out,
    err,
    write: (t) => {
      out.push(t);
    },
    error: (t) => {
      err.push(t);
    },
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  dir = mkdtempSync(join(tmpdir(), 'shutro-cli-migrate-'));
  configFile = join(fixtures, 'migrate.config.ts');
  const modules = ['base', 'sale', 'stock', 'sale_stock', 'sale_margin'].map(
    (m) => `'./${m}/module.ts'`,
  );
  writeFileSync(
    configFile,
    `export default { modules: [${modules.join(', ')}], migrations: ${JSON.stringify(dir)} };\n`,
  );
}, 180_000);

afterAll(async () => {
  rmSync(configFile, { force: true });
  rmSync(dir, { recursive: true, force: true });
  await pg?.stop();
});

describe('shutro migrate', () => {
  test('status, plan, write, apply, then the database matches the models', async () => {
    const status = io();
    expect(await runCli(['migrate', 'status', '--config', configFile], status)).toBe(0);
    expect(status.out.join('')).toContain('No migrations yet.');

    const plan = io();
    expect(await runCli(['migrate', 'plan', '--config', configFile], plan)).toBe(0);
    expect(plan.out.join('')).toContain('CREATE TABLE "sale_order"');
    expect(plan.out.join('')).toMatch(/\d+ statement\(s\), 0 destructive/);

    const write = io();
    expect(await runCli(['migrate', 'write', 'init', '--config', configFile], write)).toBe(0);
    expect(readdirSync(dir)).toEqual(['0001_init.sql']);

    const apply = io();
    expect(await runCli(['migrate', 'apply', '--config', configFile], apply)).toBe(0);
    expect(apply.out.join('')).toContain('applied   0001_init');
    expect(apply.out.join('')).toContain('module    sale 1.0.0'.replace('1.0.0', '(new) → 1.0.0'));

    const after = io();
    expect(await runCli(['migrate', 'plan', '--config', configFile], after)).toBe(0);
    expect(after.out.join('')).toContain('The database matches the models.');
    const again = io();
    expect(await runCli(['migrate', 'apply', '--config', configFile], again)).toBe(0);
    expect(again.out.join('')).toContain('Up to date.');
    const nothing = io();
    expect(await runCli(['migrate', 'write', 'noop', '--config', configFile], nothing)).toBe(0);
    expect(nothing.out.join('')).toContain('Nothing to write');
  });

  test('write needs a name; unknown subcommands are usage errors', async () => {
    const o = io();
    expect(await runCli(['migrate', 'write', '--config', configFile], o)).toBe(2);
    expect(await runCli(['migrate', 'explode', '--config', configFile], o)).toBe(2);
    expect(o.err.join('')).toContain("Unknown migrate command 'explode'");
  });
});
