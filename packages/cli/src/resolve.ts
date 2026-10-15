/**
 * Loading TypeScript module sources (feedback #16). Node runs `.ts` files by stripping types, but the `nodenext`
 * convention writes imports between them as `./sale.js`. This resolve hook retries a missing relative `.js`
 * specifier imported from a `.ts` file as `.ts`, so both spellings work without a loader.
 */
import { registerHooks } from 'node:module';

let registered = false;

/** Registers the `.js` → `.ts` fallback once per process. */
export function allowJsSpecifiersForTs(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        const fromTs = context.parentURL?.endsWith('.ts') === true;
        const missing = (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND';
        if (relative && fromTs && missing && specifier.endsWith('.js'))
          return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        throw error;
      }
    },
  });
}
