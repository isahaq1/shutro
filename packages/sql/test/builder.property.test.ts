/**
 * fast-check properties for the query builder: values only ever travel as parameters, in order.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  type ColumnRef,
  createQueryBuilder,
  type Expression,
  type ExpressionBuilder,
} from '../src/index.js';

interface Db {
  t: { id: number; name: string; amount: string; flag: boolean };
}
const qb = createQueryBuilder<Db>();

const MARK = 'Ʃ';
const payload = fc
  .tuple(
    fc.constantFrom("'; DROP TABLE t; --", '$1', '"', '\\', '/*', '*/', '\n', ''),
    fc.string({ maxLength: 12 }),
  )
  .map(([a, b]) => `${a}${MARK}${b}`);

type Eb = ExpressionBuilder<Db, { x: 't' }, ColumnRef<Db, { x: 't' }>>;

interface Tree {
  build(eb: Eb): Expression<boolean>;
  readonly values: readonly unknown[];
}

const tree: fc.Arbitrary<Tree> = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: 'small' },
    payload.map((v): Tree => ({ build: (eb) => eb('x.name', '=', v), values: [v] })),
    fc.integer().map((v): Tree => ({ build: (eb) => eb('x.id', '>', v), values: [v] })),
    fc
      .array(payload, { minLength: 1, maxLength: 4 })
      .map((vs): Tree => ({ build: (eb) => eb('x.name', 'in', vs), values: [vs] })),
    payload.map((v): Tree => ({ build: (eb) => eb('x.name', 'ilike', v), values: [v] })),
    fc.constant<Tree>({ build: (eb) => eb('x.flag', 'is', null), values: [] }),
    tie('tree').map((t): Tree => ({ build: (eb) => eb.not(t.build(eb)), values: t.values })),
    fc.array(tie('tree'), { minLength: 1, maxLength: 4 }).map(
      (ts): Tree => ({
        build: (eb) => eb.and(ts.map((t) => t.build(eb))),
        values: ts.flatMap((t) => t.values),
      }),
    ),
    fc.array(tie('tree'), { minLength: 1, maxLength: 4 }).map(
      (ts): Tree => ({
        build: (eb) => eb.or(ts.map((t) => t.build(eb))),
        values: ts.flatMap((t) => t.values),
      }),
    ),
  ),
})).tree;

describe('builder properties', () => {
  test('where trees: params are exactly the values in order and never appear in the text', () => {
    fc.assert(
      fc.property(tree, (t) => {
        const { text, params } = qb
          .selectFrom('t as x')
          .select(['x.id'])
          .where((eb) => t.build(eb))
          .compile();
        expect(params).toEqual(t.values);
        expect(text).not.toContain(MARK);
        const found = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        expect(found).toEqual(params.map((_, i) => i + 1));
      }),
    );
  });

  test('insert rows: every value is a parameter, missing keys are DEFAULT', () => {
    const row = fc.record(
      { name: payload, amount: fc.option(payload, { nil: undefined }), flag: fc.boolean() },
      { requiredKeys: ['name', 'flag'] },
    );
    fc.assert(
      fc.property(fc.array(row, { minLength: 1, maxLength: 6 }), (rows) => {
        const { text, params } = qb.insertInto('t').values(rows).compile();
        // Columns are ordered by first appearance across rows; a row without a column gets DEFAULT.
        const columns: string[] = [];
        for (const r of rows)
          for (const [k, v] of Object.entries(r))
            if (v !== undefined && !columns.includes(k)) columns.push(k);
        const cell = (r: (typeof rows)[number], c: string): unknown =>
          (r as Record<string, unknown>)[c];
        const expected = rows.flatMap((r) =>
          columns.map((c) => cell(r, c)).filter((v) => v !== undefined),
        );
        const defaults = rows.reduce(
          (n, r) => n + columns.filter((c) => cell(r, c) === undefined).length,
          0,
        );
        expect(params).toEqual(expected);
        expect(text).not.toContain(MARK);
        expect((text.match(/DEFAULT/g) ?? []).length).toBe(defaults);
      }),
    );
  });
});
