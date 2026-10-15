/**
 * `shutro init`: a minimal project — config, a `base` module with users, currencies and companies, an empty
 * migrations directory. Refuses to overwrite existing files.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';
import { CLI_PACKAGE, CORE_PACKAGE } from './packages.js';

const FILES: Readonly<Record<string, string>> = {
  'shutro.config.ts': `import { defineConfig } from '${CLI_PACKAGE}';

export default defineConfig({
  modules: ['./modules/base/module.ts'],
  app: './app',
  migrations: './migrations',
});
`,
  'modules/base/module.ts': `import { defineGroup, defineModel, defineModule, f } from '${CORE_PACKAGE}';

export const ResUsers = defineModel('res.users', {
  access: { 'base.user': ['read'] }, // administrators need no grant
  fields: { login: f.char({ required: true, index: 'unique' }), name: f.char({ required: true }) },
});

export const ResCurrency = defineModel('res.currency', {
  access: { 'base.user': ['read'] }, // administrators need no grant
  fields: {
    name: f.char({ required: true, size: 3, index: 'unique' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
    decimalPlaces: f.integer({ default: 2 }),
  },
});

export const ResCompany = defineModel('res.company', {
  access: { 'base.user': ['read'] }, // administrators need no grant
  fields: { name: f.char({ required: true }), currency: f.many2one('res.currency', { required: true }) },
});

export const base = defineModule({
  name: 'base',
  version: '0.1.0',
  groups: [
    defineGroup({ code: 'base.user', label: 'User' }),
    defineGroup({ code: 'base.admin', label: 'Administrator', implies: ['base.user'], administrator: true }),
  ],
  models: [ResUsers, ResCurrency, ResCompany],
});
`,
  'migrations/.gitkeep': '',
};

/** Writes the starter files under `dir` and returns their paths. @throws {CliError} if any exists. */
export function initProject(dir: string): string[] {
  const existing = Object.keys(FILES).filter((f) => existsSync(join(dir, f)));
  if (existing.length > 0) {
    throw new CliError(
      `${existing.join(', ')} already exist(s) in ${dir}.`,
      'shutro init never overwrites files: run it in an empty directory, or remove them first.',
    );
  }
  const written: string[] = [];
  for (const [file, content] of Object.entries(FILES)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}
