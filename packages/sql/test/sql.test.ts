import { describe, expect, test } from 'vitest';
import { compile, isSql, SqlError, SqlFragment, type SqlNode, sql, visit } from '../src/index.js';

/** Asserts that `fn` throws a SqlError with the given code and a non-empty hint. */
function expectSqlError(fn: () => unknown, code: SqlError['code']): SqlError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SqlError);
    const err = e as SqlError;
    expect(err.code).toBe(code);
    expect(err.hint.length).toBeGreaterThan(10);
    expect(err.message).toContain(err.hint);
    return err;
  }
  throw new Error(`expected SqlError ${code}`);
}

describe('sql tag + compile', () => {
  test('plain text', () => {
    expect(compile(sql`SELECT 1`)).toEqual({ text: 'SELECT 1', params: [] });
  });

  test('interpolated values become numbered parameters', () => {
    const q = sql`SELECT * FROM t WHERE a = ${1} AND b = ${'x'} AND c IS ${null}`;
    expect(compile(q)).toEqual({
      text: 'SELECT * FROM t WHERE a = $1 AND b = $2 AND c IS $3',
      params: [1, 'x', null],
    });
  });

  test('nested fragments are numbered in order of appearance', () => {
    const inner = sql`b = ${2}`;
    const q = sql`a = ${1} AND ${inner} AND c = ${3}`;
    expect(compile(q)).toEqual({ text: 'a = $1 AND b = $2 AND c = $3', params: [1, 2, 3] });
  });

  test('a fragment used twice gets separate parameters', () => {
    const f = sql`x = ${7}`;
    expect(compile(sql`${f} OR ${f}`)).toEqual({ text: 'x = $1 OR x = $2', params: [7, 7] });
  });

  test('an interpolated array is one parameter', () => {
    expect(compile(sql`id = ANY(${[1, 2, 3]})`)).toEqual({
      text: 'id = ANY($1)',
      params: [[1, 2, 3]],
    });
  });

  test('bigint, boolean, Date, Uint8Array and objects pass through untouched', () => {
    const date = new Date(0);
    const bytes = new Uint8Array([1, 2]);
    const decimalLike = { toString: () => '1.50' };
    const { params } = compile(sql`${10n} ${true} ${date} ${bytes} ${decimalLike}`);
    expect(params).toEqual([10n, true, date, bytes, decimalLike]);
    expect(params[4]).toBe(decimalLike);
  });

  test('the same shape gives the same text, whatever the values', () => {
    const shape = (a: unknown, b: unknown): string => compile(sql`a = ${a} AND b = ANY(${b})`).text;
    expect(shape(1, [1])).toBe(shape("'; DROP TABLE t; --", ['x', 'y', 'z']));
  });

  test('compiled output is frozen', () => {
    const c = compile(sql`a = ${1}`);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.params)).toBe(true);
  });
});

describe('sql.id', () => {
  test('quotes identifiers, qualified with dots', () => {
    expect(
      compile(sql`SELECT ${sql.id('so', 'amount_total')} FROM ${sql.id('sale_order')} so`).text,
    ).toBe('SELECT "so"."amount_total" FROM "sale_order" so');
  });

  test('reserved words are safe because they are always quoted', () => {
    expect(compile(sql`${sql.id('order')}`).text).toBe('"order"');
  });

  test.each([
    [''],
    ['Sale'],
    ['a b'],
    ['a"b'],
    ['1abc'],
    ['x'.repeat(64)],
    ['amount; DROP'],
    ['é'],
  ])('rejects %j', (name) => {
    expectSqlError(() => sql.id(name), 'SQL_INVALID_IDENTIFIER');
  });

  test('accepts the longest identifier PostgreSQL keeps (63 bytes)', () => {
    expect(compile(sql.id('x'.repeat(63))).text).toBe(`"${'x'.repeat(63)}"`);
  });

  test('requires at least one part', () => {
    expectSqlError(() => sql.id(), 'SQL_INVALID_IDENTIFIER');
  });
});

describe('sql.param / sql.array casts', () => {
  test('param with a cast', () => {
    expect(compile(sql`${sql.param('1.5', 'numeric')}`)).toEqual({
      text: '$1::numeric',
      params: ['1.5'],
    });
  });

  test('array parameter with an element type', () => {
    expect(compile(sql`id = ANY(${sql.array([1, 2], 'bigint')})`)).toEqual({
      text: 'id = ANY($1::bigint[])',
      params: [[1, 2]],
    });
  });

  test.each([
    ['numeric(20, 6)'],
    ['timestamp with time zone'],
    ['double precision'],
    ['varchar(64)'],
    ['jsonb'],
  ])('accepts type %j', (type) => {
    expect(compile(sql.param(1, type)).text).toBe(`$1::${type}`);
  });

  test.each([['numeric; DROP TABLE t'], ['text)'], ['"text"'], [''], ['int[]'], ["text' --"]])(
    'rejects type %j',
    (type) => {
      expectSqlError(() => sql.param(1, type), 'SQL_INVALID_TYPE');
      expectSqlError(() => sql.array([1], type), 'SQL_INVALID_TYPE');
    },
  );

  test('sql.array requires an array', () => {
    expectSqlError(
      () => sql.array('not an array' as unknown as readonly unknown[], 'text'),
      'SQL_INVALID_PARAM',
    );
  });
});

describe('sql.join / sql.empty', () => {
  test('joins with ", " by default', () => {
    expect(compile(sql.join([sql`${1}`, sql`${2}`, sql`${3}`])).text).toBe('$1, $2, $3');
  });

  test('joins with a custom separator', () => {
    expect(compile(sql.join([sql`a = ${1}`, sql`b = ${2}`], sql` AND `)).text).toBe(
      'a = $1 AND b = $2',
    );
  });

  test('joining nothing renders nothing', () => {
    expect(compile(sql`SELECT 1${sql.join([])}`)).toEqual({ text: 'SELECT 1', params: [] });
    expect(compile(sql.empty)).toEqual({ text: '', params: [] });
  });

  test('join rejects non-fragments', () => {
    expectSqlError(
      () => sql.join(['DROP TABLE t' as unknown as SqlFragment]),
      'SQL_NOT_A_FRAGMENT',
    );
  });
});

describe('rejected values', () => {
  test('undefined is an error, not NULL', () => {
    const err = expectSqlError(() => sql`a = ${undefined}`, 'SQL_UNDEFINED_PARAM');
    expect(err.hint).toMatch(/null/);
  });

  test.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    'non-finite number %s',
    (n) => {
      expectSqlError(() => sql`a = ${n}`, 'SQL_INVALID_NUMBER');
    },
  );

  test.each([[() => 1], [Symbol('s')]])('functions and symbols: %s', (v) => {
    expectSqlError(() => sql`a = ${v}`, 'SQL_INVALID_PARAM');
  });

  test('undefined inside an array is an error too', () => {
    expectSqlError(() => sql`a = ANY(${[1, undefined]})`, 'SQL_UNDEFINED_PARAM');
  });
});

describe('only real template literals are accepted', () => {
  test('a plain string', () => {
    expectSqlError(() => Reflect.apply(sql, undefined, ['DROP TABLE t']), 'SQL_NOT_A_TEMPLATE');
  });

  test('a forged, unfrozen strings array', () => {
    const forged = Object.assign(['DROP TABLE t'], { raw: ['DROP TABLE t'] });
    expectSqlError(() => Reflect.apply(sql, undefined, [forged]), 'SQL_NOT_A_TEMPLATE');
  });
});

describe('forged fragments are never trusted', () => {
  const forged = Object.create(SqlFragment.prototype, {
    node: { value: { kind: 'text', text: 'DROP TABLE victim' } },
  }) as SqlFragment;

  test('isSql rejects an object that only looks like a fragment', () => {
    expect(forged instanceof SqlFragment).toBe(true); // instanceof alone would be fooled
    expect(isSql(forged)).toBe(false);
  });

  test('compile refuses it', () => {
    expectSqlError(() => compile(forged), 'SQL_NOT_A_FRAGMENT');
  });

  test('interpolating it binds it as a value instead of inlining its text', () => {
    const c = compile(sql`SELECT ${forged}`);
    expect(c.text).toBe('SELECT $1');
    expect(c.text).not.toContain('DROP');
  });

  test('join rejects it as an item and as a separator', () => {
    expectSqlError(() => sql.join([forged]), 'SQL_NOT_A_FRAGMENT');
    expectSqlError(() => sql.join([sql`a`, sql`b`], forged), 'SQL_NOT_A_FRAGMENT');
  });

  test('the constructor cannot be called from outside', () => {
    const Ctor = SqlFragment as unknown as new (key: symbol, node: unknown) => SqlFragment;
    expect(() => new Ctor(Symbol('SqlFragment'), { kind: 'text', text: 'x' })).toThrow(TypeError);
  });
});

describe('limits', () => {
  test('more than 65535 parameters is an error with a hint to use arrays', () => {
    const many = sql.join(Array.from({ length: 65_536 }, (_, i) => sql`${i}`));
    const err = expectSqlError(() => compile(many), 'SQL_TOO_MANY_PARAMS');
    expect(err.hint).toMatch(/array/i);
  });

  test('exactly 65535 parameters is fine', () => {
    const many = sql.join(Array.from({ length: 65_535 }, (_, i) => sql`${i}`));
    expect(compile(many).params).toHaveLength(65_535);
  });
});

describe('isSql / visit', () => {
  test('isSql', () => {
    expect(isSql(sql`x`)).toBe(true);
    expect(isSql({ text: 'x' })).toBe(false);
    expect(isSql('x')).toBe(false);
  });

  test('visit walks every node in rendering order', () => {
    const q = sql`SELECT ${sql.id('a')} FROM ${sql.id('t')} WHERE x = ${1} AND ${sql`y = ${sql.param(2, 'int')}`}`;
    const kinds: string[] = [];
    const idents: string[] = [];
    visit(q, (node: SqlNode) => {
      kinds.push(node.kind);
      if (node.kind === 'ident') idents.push(node.parts.join('.'));
    });
    expect(idents).toEqual(['a', 't']);
    expect(kinds.filter((k) => k === 'param')).toHaveLength(2);
    expect(kinds[0]).toBe('seq');
  });
});
