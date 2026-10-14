/**
 * Property tests (fast-check) for the compiler: values only ever travel as parameters, and numbering is exact.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { compile, type SqlFragment, sql } from '../src/index.js';

/** Characters that never appear in template text or identifiers below, so finding one in `text` means a leak. */
const MARK = 'Ʃ';
const payload = fc
  .tuple(
    fc.constantFrom("'; DROP TABLE t; --", '$1', '$$', '"', '\\', "E'\\x41'", '/*', '*/', '\n', ''),
    fc.string({ maxLength: 20 }),
  )
  .map(([attack, noise]) => `${attack}${MARK}${noise}`);

const value = fc.oneof(
  payload,
  fc.integer(),
  fc.bigInt(),
  fc.boolean(),
  fc.constant(null),
  fc.array(payload, { maxLength: 4 }),
);
const ident = fc.stringMatching(/^[a-z_][a-z0-9_]{0,20}$/);

interface Tree {
  readonly fragment: SqlFragment;
  /** Values in the order they must appear as $1..$n. */
  readonly values: readonly unknown[];
}

const tree: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small' },
    value.map((v) => ({ fragment: sql`v = ${v}`, values: [v] })),
    ident.map((name) => ({ fragment: sql`${sql.id(name)}`, values: [] })),
    fc
      .tuple(value, fc.constantFrom('numeric', 'text', 'bigint'))
      .map(([v, t]) => ({ fragment: sql.param(v, t), values: [v] })),
    fc.array(tie('tree'), { maxLength: 5 }).map((children) => ({
      fragment: sql`(${sql.join(
        children.map((c) => c.fragment),
        sql` AND `,
      )})`,
      values: children.flatMap((c) => c.values),
    })),
  ),
})).tree;

describe('compile properties', () => {
  test('parameters are exactly the interpolated values, in order', () => {
    fc.assert(
      fc.property(tree, ({ fragment, values }) => {
        expect(compile(fragment).params).toEqual(values);
      }),
    );
  });

  test('placeholders are $1..$n, each once, in increasing order', () => {
    fc.assert(
      fc.property(tree, ({ fragment, values }) => {
        const found = [...compile(fragment).text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        expect(found).toEqual(values.map((_, i) => i + 1));
      }),
    );
  });

  test('no value ever appears in the SQL text (injection oracle)', () => {
    fc.assert(
      fc.property(tree, ({ fragment }) => {
        expect(compile(fragment).text).not.toContain(MARK);
      }),
    );
  });

  test('compiling is deterministic', () => {
    fc.assert(
      fc.property(tree, ({ fragment }) => {
        expect(compile(fragment)).toEqual(compile(fragment));
      }),
    );
  });
});
