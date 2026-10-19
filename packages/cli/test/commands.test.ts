/**
 * `shutro init` and `shutro inspect` (no database).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { type CliIo, initProject, runCli } from '../src/index.js';

const configFile = join(import.meta.dirname, 'fixtures', 'shutro.config.ts');
const scratch = mkdtempSync(join(tmpdir(), 'shutro-init-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function io(): CliIo & { readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: import.meta.dirname,
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

describe('shutro init --minimal', () => {
  test('--minimal writes a config, a base module and a migrations directory, and never overwrites', async () => {
    const o = { ...io(), cwd: scratch };
    expect(await runCli(['init', '--minimal'], o)).toBe(0);
    expect(o.out.join('')).toContain('shutro.config.ts');
    expect(readFileSync(join(scratch, 'shutro.config.ts'), 'utf8')).toContain(
      "modules: ['./modules/base/module.ts']",
    );
    expect(readFileSync(join(scratch, 'modules', 'base', 'module.ts'), 'utf8')).toContain(
      "defineGroup({ code: 'base.admin'",
    );
    expect(() => initProject(scratch)).toThrow(/already exist/);
    const again = { ...io(), cwd: scratch };
    expect(await runCli(['init', '--minimal'], again)).toBe(2);
  });
});

describe('shutro inspect', () => {
  test('the overview lists modules in load order with what they own and extend', async () => {
    const o = io();
    expect(await runCli(['inspect', '--config', configFile], o)).toBe(0);
    const text = o.out.join('');
    expect(text).toMatch(/^5 module\(s\), \d+ model\(s\)/);
    expect(text).toContain('sale_stock 1.0.0  (depends: sale, stock)');
    expect(text).toContain('  extends: sale.order');
  });

  test('a model shows field origins, method chains, computes and access', async () => {
    const o = io();
    expect(await runCli(['inspect', 'sale.order', '--config', configFile], o)).toBe(0);
    const text = o.out.join('');
    expect(text).toContain('owner sale  extended by sale_margin, sale_stock');
    expect(text).toMatch(/warehouse\s+many2one → stock\.warehouse\s+warehouse_id\s+sale_stock/);
    expect(text).toMatch(/margin\s+decimal\s+margin\s+sale_margin\s+.*computed\+stored/);
    expect(text).toContain('confirm: sale → sale_margin(override)');
    expect(text).toMatch(/amountTotal\s+rank 0\s+stored/);
    expect(text).toContain('(none: denied to everyone but superuser scopes)');
  });

  test('an unknown model lists the known ones', async () => {
    const o = io();
    expect(await runCli(['inspect', 'sale.nope', '--config', configFile], o)).toBe(2);
    expect(o.err.join('')).toContain('sale.order');
  });
});
