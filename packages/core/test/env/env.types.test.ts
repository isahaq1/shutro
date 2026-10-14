/**
 * Type-level guarantees for the environment (RFC 0003 §8), checked by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import type { Env, Flags, Shutro } from '../../src/index.js';

test('API types', () => {
  const misuse = async (shutro: Shutro, env: Env): Promise<void> => {
    expectTypeOf(await shutro.run({ user: 1, company: 1 }, async () => 42)).toEqualTypeOf<number>();
    expectTypeOf(await env.sql<{ id: number }>`SELECT 1`).toEqualTypeOf<
      readonly { id: number }[]
    >();
    expectTypeOf(await env.transaction(async () => 'x')).toEqualTypeOf<string>();
    expectTypeOf(
      await env.asSuperuser({ reason: 'r' }, async (su) => su.su),
    ).toEqualTypeOf<boolean>();
    expectTypeOf(env.flags).toEqualTypeOf<Flags>();
    expectTypeOf(env.now()).toEqualTypeOf<Date>();
    expectTypeOf(env.today()).toEqualTypeOf<string>();
    // @ts-expect-error user and company are required
    await shutro.run({}, async () => undefined);
    // @ts-expect-error ids are numbers
    await shutro.run({ user: '1', company: 1 }, async () => undefined);
    // @ts-expect-error retry can only be disabled, not configured per run
    await shutro.run({ user: 1, company: 1, retry: true }, async () => undefined);
    // @ts-expect-error unknown flags are rejected (no magic context keys)
    env.withFlags({ default_type: 'out_invoice' });
    // @ts-expect-error a reason is required
    await env.asSuperuser({}, async () => undefined);
    // @ts-expect-error environments are immutable
    env.companyId = 2;
    // @ts-expect-error there is no sudo(); use asSuperuser
    env.sudo();
  };
  expectTypeOf(misuse).toBeFunction();
});
