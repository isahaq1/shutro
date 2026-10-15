/** The committed per-module bindings (`modules/<name>/.shutro/`) match the modules: `shutro generate --check`. */
import { join } from 'node:path';
import { runCli } from '@shutro/cli';
import { expect, test } from 'vitest';

test('generated bindings are current', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ['generate', '--check', '--config', join(import.meta.dirname, '..', 'shutro.config.ts')],
    {
      cwd: join(import.meta.dirname, '..'),
      write: (t) => {
        out.push(t);
      },
      error: (t) => {
        err.push(t);
      },
    },
  );
  expect(err).toEqual([]);
  expect(code, out.join('')).toBe(0);
});
