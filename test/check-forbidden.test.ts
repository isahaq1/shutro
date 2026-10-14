import { describe, expect, test } from 'vitest';
import { findViolations } from '../scripts/check-forbidden.ts';

describe('check-forbidden', () => {
  test('unsafe() and postgres imports are allowed only in driver-pg sources', () => {
    const files = new Map([
      [
        'packages/driver-pg/src/driver.ts',
        "import postgres from 'postgres';\nsql.unsafe(text, params);",
      ],
      ['packages/core/src/env.ts', "const rows = await sql.unsafe('SELECT 1');"],
      ['packages/core/src/other.ts', "import postgres from 'postgres';"],
      ['packages/sql/src/tag.ts', '// mentions unsafe in prose without calling it'],
    ]);
    const found = findViolations(files).map((v) => `${v.file}:${v.line}:${v.rule.name}`);
    expect(found).toEqual([
      'packages/core/src/env.ts:1:no-unsafe',
      'packages/core/src/other.ts:1:no-direct-postgres-import',
    ]);
  });
});
