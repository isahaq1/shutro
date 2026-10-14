/**
 * Type-level guarantees, checked by `pnpm typecheck`.
 */
import { compile, sql } from '@shutro/sql';
import { expectTypeOf, test } from 'vitest';
import {
  createDriver,
  type Driver,
  type DriverConnection,
  type DriverQuery,
} from '../src/index.js';

test('CompiledSql from @shutro/sql is a DriverQuery (structural, no package dependency)', () => {
  expectTypeOf(compile(sql`SELECT 1`)).toMatchTypeOf<DriverQuery>();
});

test('API types', () => {
  const misuse = async (db: Driver, conn: DriverConnection): Promise<void> => {
    expectTypeOf(await db.query<{ id: number }>(compile(sql`x`))).toEqualTypeOf<
      readonly { id: number }[]
    >();
    expectTypeOf(await db.transaction({}, async () => 42)).toEqualTypeOf<number>();
    expectTypeOf(await conn.savepoint(async () => 'x')).toEqualTypeOf<string>();
    // @ts-expect-error raw strings are not queries
    await db.query('SELECT 1');
    // @ts-expect-error isolation levels are a closed set
    await db.transaction({ isolation: 'read uncommitted' }, async () => undefined);
    // @ts-expect-error settings values are strings
    await db.transaction({ settings: { 'shutro.user_id': 42 } }, async () => undefined);
    // @ts-expect-error a URL is required
    createDriver({});
  };
  expectTypeOf(misuse).toBeFunction();
});
