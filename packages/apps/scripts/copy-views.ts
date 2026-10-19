/**
 * `tsc` emits the generated bindings but not the `schema.d.ts` views they import types from: copy them next to the
 * emitted bindings so the published declarations resolve.
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
for (const module of readdirSync(join(root, 'src'))) {
  const view = join(root, 'src', module, '.shutro', 'schema.d.ts');
  const target = join(root, 'dist', module, '.shutro');
  if (existsSync(view) && existsSync(target)) copyFileSync(view, join(target, 'schema.d.ts'));
}
