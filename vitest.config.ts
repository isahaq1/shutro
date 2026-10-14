import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. Workspace packages resolve to their TypeScript sources through the
 * `@shutro/source` export condition, so tests never need a prior build.
 */
export default defineConfig({
  resolve: {
    conditions: ['@shutro/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@shutro/source'],
    },
  },
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
