/**
 * Type-level guarantees, checked by `pnpm typecheck` (the expectTypeOf calls are no-ops at runtime).
 */
import { expectTypeOf, test } from 'vitest';
import { type CompiledSql, compile, type SqlFragment, type SqlNode, sql } from '../src/index.js';

test('public API types', () => {
  expectTypeOf(sql`SELECT ${1}`).toEqualTypeOf<SqlFragment>();
  expectTypeOf(compile(sql`x`)).toEqualTypeOf<CompiledSql>();
  expectTypeOf<CompiledSql['params']>().toEqualTypeOf<readonly unknown[]>();
  expectTypeOf<CompiledSql['text']>().toEqualTypeOf<string>();
  expectTypeOf(sql.id('a', 'b')).toEqualTypeOf<SqlFragment>();
  expectTypeOf(sql.empty).toEqualTypeOf<SqlFragment>();
  expectTypeOf<SqlNode['kind']>().toEqualTypeOf<'text' | 'param' | 'ident' | 'seq'>();
});

test('misuse is a compile error', () => {
  // Type-checked only, never called: each line would also throw at runtime.
  const misuse = (): void => {
    // @ts-expect-error identifiers are strings
    sql.id(1);
    // @ts-expect-error join takes fragments, not strings
    sql.join(['a', 'b']);
    // @ts-expect-error a cast type is required
    sql.param(1);
    // @ts-expect-error compile takes a fragment, not a string
    compile('SELECT 1');
    // @ts-expect-error compiled output is read-only
    compile(sql`x`).params.push(1);
  };
  expectTypeOf(misuse).toBeFunction();
});
