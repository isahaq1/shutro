/**
 * The built CLI under plain Node loads TypeScript module sources that import each other with the `nodenext`
 * `./x.js` convention (feedback #16). Vitest resolves `.js` → `.ts` itself, so this spawns `dist/bin.js`.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';

const run = promisify(execFile);
const root = join(import.meta.dirname, '..', '..', '..');
const bin = join(import.meta.dirname, '..', 'dist', 'bin.js');
const dir = mkdtempSync(join(tmpdir(), 'shutro-ts-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('generate loads .ts modules written with ./x.js specifiers', async () => {
  expect(existsSync(bin), 'packages/cli/dist is missing: run pnpm build first').toBe(true);
  mkdirSync(join(dir, 'node_modules', '@shutro'), { recursive: true });
  for (const pkg of ['core', 'cli', 'sql', 'driver-pg'])
    symlinkSync(join(root, 'packages', pkg), join(dir, 'node_modules', '@shutro', pkg), 'junction');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(dir, 'modules', 'base'), { recursive: true });
  mkdirSync(join(dir, 'modules', 'sale'), { recursive: true });
  writeFileSync(
    join(dir, 'modules', 'base', 'module.ts'),
    `import { defineModel, defineModule, f } from '@shutro/core';
export const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
export const base = defineModule({ name: 'base', models: [Users] });
`,
  );
  writeFileSync(
    join(dir, 'modules', 'sale', 'module.ts'),
    `import { defineModel, defineModule, f } from '@shutro/core';
import { base } from '../base/module.js';
export const Order = defineModel('sale.order', { fields: { user: f.many2one('res.users', { required: true }) } });
export const sale = defineModule({ name: 'sale', depends: [base], models: [Order] });
`,
  );
  writeFileSync(
    join(dir, 'shutro.config.ts'),
    `import { defineConfig } from '@shutro/cli';
export default defineConfig({ modules: ['./modules/base/module.ts', './modules/sale/module.ts'] });
`,
  );
  const { stdout } = await run(process.execPath, [bin, 'generate'], { cwd: dir });
  expect(stdout).toMatch(/created .*sale.*schema\.d\.ts/);
  expect(readFileSync(join(dir, 'modules', 'sale', '.shutro', 'schema.d.ts'), 'utf8')).toContain(
    "'sale.order'",
  );
}, 60_000);
