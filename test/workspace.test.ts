import { describe, expect, it } from 'vitest';

const packages = [
  'audit',
  'cli',
  'core',
  'driver-pg',
  'i18n',
  'migrate',
  'security',
  'sequence',
  'sql',
  'testing',
] as const;

describe('workspace', () => {
  it.each(packages)(
    '@shutro/%s resolves through its package exports',
    async (name) => {
      const mod: unknown = await import(`@shutro/${name}`);
      expect(mod).toBeTypeOf('object');
    },
    // @shutro/testing imports Testcontainers, which can take many seconds while other suites start containers.
    60_000,
  );
});
