import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type CliIo, runCli } from '../src/index.js';

const configFile = join(import.meta.dirname, 'fixtures', 'shutro.config.ts');

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

describe('shutro', () => {
  test('generate --check passes on current goldens and lists every file', async () => {
    const o = io();
    expect(await runCli(['generate', '--check', '--config', configFile], o)).toBe(0);
    expect(o.out.join('')).toMatch(/unchanged .*schema\.d\.ts/);
    expect(o.out).toHaveLength(12);
    expect(o.err).toEqual([]);
  });

  test('no command prints usage with exit 2; --help exits 0', async () => {
    const o = io();
    expect(await runCli([], o)).toBe(2);
    expect(o.out.join('')).toContain('Usage: shutro');
    expect(await runCli(['--help'], io())).toBe(0);
  });

  test('unknown and unimplemented commands', async () => {
    const o = io();
    expect(await runCli(['bogus'], o)).toBe(2);
    expect(o.err.join('')).toContain("Unknown command 'bogus'");
    expect(await runCli(['migrate'], o)).toBe(2);
    expect(o.err.join('')).toContain('not implemented yet');
  });

  test('a missing config is reported with a hint', async () => {
    const o = io();
    expect(await runCli(['generate', '--config', 'nope.config.ts'], o)).toBe(2);
    expect(o.err.join('')).toContain('Create shutro.config.ts');
  });
});
