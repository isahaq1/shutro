/**
 * RFC 0004 §8: loaded shapes are tracked in the types. Checked by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import {
  buildRegistry,
  type Env,
  type Id,
  type Money,
  type NotLoaded,
  type PendingSet,
  type Quantity,
} from '../../src/index.js';
import { sale } from './fixtures.js';

const registry = buildRegistry({ modules: [sale] });
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

test('the registry type carries every model of the module tree', () => {
  expectTypeOf<keyof S>().toEqualTypeOf<
    | 'res.users'
    | 'res.currency'
    | 'res.company'
    | 'res.partner'
    | 'uom.uom'
    | 'sale.tag'
    | 'sale.order'
    | 'sale.order.line'
  >();
});

test('search gives the default shape; relations are navigable but not loaded', async () => {
  const checks = async (env: Env<S>): Promise<void> => {
    const orders = await env.model('sale.order').search({ where: { state: 'sale' } });
    expectTypeOf(orders.modelName).toEqualTypeOf<'sale.order'>();
    const o = orders.first();
    expectTypeOf(o.id).toEqualTypeOf<Id<'sale.order'>>();
    expectTypeOf(o.name).toEqualTypeOf<string>();
    expectTypeOf(o.note).toEqualTypeOf<string | null>();
    expectTypeOf(o.amountTotal).toEqualTypeOf<Money>();
    expectTypeOf(o.dateOrder).toEqualTypeOf<Date>();
    expectTypeOf(o.validityDate).toEqualTypeOf<string | null>();
    expectTypeOf(o.state).toEqualTypeOf<'draft' | 'sale' | 'cancel'>();
    expectTypeOf(o.partner.id).toEqualTypeOf<Id<'res.partner'>>();
    expectTypeOf(o.partner).not.toHaveProperty('name');
    expectTypeOf(o.lines).toEqualTypeOf<PendingSet<S, 'sale.order.line'>>();
    expectTypeOf(o.attachment).toMatchTypeOf<NotLoaded<'sale.order', 'attachment'>>(); // binary is not a default
    expectTypeOf(o.company.id).toEqualTypeOf<Id<'res.company'>>();
  };
  expectTypeOf(checks).toBeFunction();
});

test('load() widens the shape at every level and merges with earlier loads', async () => {
  const checks = async (env: Env<S>): Promise<void> => {
    const orders = await env.model('sale.order').search({});
    const l1 = await orders.load({ partner: ['name'], lines: { uom: true }, tags: true });
    const o = l1.first();
    expectTypeOf(o.partner.name).toEqualTypeOf<string>();
    expectTypeOf(o.partner.email).toMatchTypeOf<NotLoaded<'res.partner', 'email'>>();
    for (const line of o.lines) {
      expectTypeOf(line.quantity).toEqualTypeOf<Quantity>();
      expectTypeOf(line.subtotal).toEqualTypeOf<Money>();
      const uom = line.uom;
      if (uom !== null) expectTypeOf(uom.name).toEqualTypeOf<string>();
    }
    expectTypeOf(o.tags.mapped('name')).toEqualTypeOf<string[]>();
    const l2 = await l1.load({ partner: { parent: ['name'] } });
    const p = l2.first().partner;
    expectTypeOf(p.name).toEqualTypeOf<string>(); // kept from l1
    const parent = p.parent;
    if (parent !== null) expectTypeOf(parent.name).toEqualTypeOf<string>();
    const lines = await orders.first().lines.load(['subtotal']); // a pending set: only the listed keys
    expectTypeOf(lines.first().subtotal).toEqualTypeOf<Money>();
    expectTypeOf(lines.first().name).toMatchTypeOf<NotLoaded<'sale.order.line', 'name'>>();
  };
  expectTypeOf(checks).toBeFunction();
});

test('misuse is a compile error', () => {
  const misuse = async (env: Env<S>): Promise<void> => {
    // @ts-expect-error unknown model
    env.model('sale.ordr');
    const orders = await env.model('sale.order').search({});
    // @ts-expect-error unknown field in a load spec
    await orders.load({ partnr: true });
    // @ts-expect-error unknown scalar in a nested list
    await orders.load({ partner: ['nam'] });
    // @ts-expect-error scalar fields can't be load-spec keys
    await orders.load({ name: true });
    // @ts-expect-error a many-record set has no field values; iterate or use mapped()
    orders.name;
    // @ts-expect-error x2many is not iterable before loading
    for (const _ of orders.first().lines) {
    }
    // @ts-expect-error where keys are fields
    await env.model('sale.order').search({ where: { nope: 1 } });
    // @ts-expect-error where values match the field type
    await env.model('sale.order').search({ where: { name: 1 } });
    // @ts-expect-error order entries name sortable fields
    await env.model('sale.order').search({ order: ['lines desc'] });
    // @ts-expect-error mapped() takes a scalar field key
    orders.mapped('lines');
  };
  expectTypeOf(misuse).toBeFunction();
});
