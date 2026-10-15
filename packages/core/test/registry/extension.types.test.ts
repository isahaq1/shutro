/**
 * Extensions reach the registry's schema view: extension fields are typed on the model. Checked by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import {
  buildRegistry,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  type Id,
} from '../../src/index.js';
import { base } from './fixtures.js';

const b = base();
const sale = defineModule({
  name: 'sale',
  depends: [b],
  models: [
    defineModel('sale.order', {
      fields: {
        name: f.char({ required: true }),
        partner: f.many2one('res.partner', { required: true }),
      },
    }),
  ],
});
const stock = defineModule({
  name: 'stock',
  depends: [b],
  models: [defineModel('stock.warehouse', { fields: { name: f.char({ required: true }) } })],
});
const saleStock = defineModule({
  name: 'sale_stock',
  depends: [sale, stock],
  models: [],
  extensions: [
    extendModel('sale.order', {
      fields: { warehouse: f.many2one('stock.warehouse'), deliveryNote: f.text() },
    }),
  ],
});

const registry = buildRegistry({ modules: [saleStock] });
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

test('extension fields are part of the model type', () => {
  const checks = async (env: Env<S>): Promise<void> => {
    const orders = await env
      .model('sale.order')
      .search({ where: { deliveryNote: { isNull: true } } });
    const o = orders.first();
    expectTypeOf(o.name).toEqualTypeOf<string>();
    expectTypeOf(o.deliveryNote).toEqualTypeOf<string | null>();
    expectTypeOf(o.warehouse).toEqualTypeOf<{
      readonly id: Id<'stock.warehouse'>;
      readonly modelName: 'stock.warehouse';
    } | null>();
    const loaded = await orders.load({ warehouse: ['name'] });
    const w = loaded.first().warehouse;
    if (w !== null) expectTypeOf(w.name).toEqualTypeOf<string>();
    await env
      .model('sale.order')
      .create([{ name: 'x', partner: 1 as Id<'res.partner'>, deliveryNote: 'fragile' }]);
  };
  expectTypeOf(checks).toBeFunction();
});
