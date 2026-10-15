/**
 * Write-side typing (RFC 0001 §7.3 create/write faces through recordsets). Checked by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import { buildRegistry, type Env, type Id, Money } from '../../src/index.js';
import { sale } from './fixtures.js';

const registry = buildRegistry({ modules: [sale], security: { enforce: false } });
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

declare const partner: Id<'res.partner'>;
declare const bdt: Id<'res.currency'>;
declare const tag: Id<'sale.tag'>;

test('create values follow the create face; company and defaults are optional', () => {
  const ok = async (env: Env<S>): Promise<void> => {
    const orders = await env.model('sale.order').create([
      { name: 'SO1', partner, currency: bdt, dateOrder: new Date() },
      {
        name: 'SO2',
        partner,
        currency: bdt,
        dateOrder: new Date(),
        note: null,
        amountTotal: '0',
        lines: { create: [{ name: 'L' }] },
        tags: { link: [tag] },
      },
    ]);
    expectTypeOf(orders.first().name).toEqualTypeOf<string>();
    await orders.write({
      note: 'x',
      amountTotal: Money.of('1', orders.first().amountTotal.currency),
    });
    expectTypeOf(await orders.unlink()).toEqualTypeOf<void>();
  };
  expectTypeOf(ok).toBeFunction();
});

test('misuse is a compile error', () => {
  const misuse = async (env: Env<S>): Promise<void> => {
    const m = env.model('sale.order');
    // @ts-expect-error partner is required
    await m.create([{ name: 'SO1', currency: bdt, dateOrder: new Date() }]);
    // @ts-expect-error state is set through transitions, never written
    await m.create([{ name: 'SO1', partner, currency: bdt, dateOrder: new Date(), state: 'sale' }]);
    // @ts-expect-error unknown field
    await m.create([{ name: 'SO1', partner, currency: bdt, dateOrder: new Date(), nope: 1 }]);
    // @ts-expect-error a plain number is not a partner id
    await m.create([{ name: 'SO1', partner: 1, currency: bdt, dateOrder: new Date() }]);
    const orders = await m.search({});
    // @ts-expect-error createdAt is readonly
    await orders.write({ createdAt: new Date() });
    // @ts-expect-error a required field can't be set to null
    await orders.write({ partner: null });
    // @ts-expect-error binary floats can't be written to monetary fields
    await orders.write({ amountTotal: 1.5 });
  };
  expectTypeOf(misuse).toBeFunction();
});
