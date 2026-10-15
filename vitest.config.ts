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
    include: [
      'packages/*/{src,test}/**/*.test.ts',
      'examples/*/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    passWithNoTests: false,
    // Integration files each start a PostgreSQL container: half the CPUs keeps Docker responsive, and a longer test
    // timeout absorbs a loaded machine (5 s defaults flaked under the full suite).
    maxWorkers: '50%',
    testTimeout: 30_000,
  },
});
