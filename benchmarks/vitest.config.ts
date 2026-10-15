import { defineConfig } from 'vitest/config';

/** Benchmarks run on their own (`pnpm bench`), never as part of `pnpm test`. */
export default defineConfig({
  resolve: { conditions: ['@shutro/source'] },
  ssr: { resolve: { conditions: ['@shutro/source'] } },
  test: {
    include: ['src/**/*.bench.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
