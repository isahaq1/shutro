/**
 * RFC 0002 §7.9: what each module's generated view lets its code see, verified by `pnpm typecheck`.
 */
import type { CreateValues, Decimal, F, Id, ReadOf } from '@shutro/core';
import { expectTypeOf, test } from 'vitest';
import type { SchemaView as AppView } from './fixtures/app/.shutro/schema.js';
import type { Env as SaleEnv, SchemaView as SaleView } from './fixtures/sale/.shutro/bindings.js';
import type { SaleOrder } from './fixtures/sale/module.js';
import type { SchemaView as SaleMarginView } from './fixtures/sale_margin/.shutro/schema.js';
import type { SchemaView as SaleStockView } from './fixtures/sale_stock/.shutro/schema.js';

type SaleOrderFields<V extends { 'sale.order': { fields: unknown } }> = V['sale.order']['fields'];

test('a generated field has exactly the type the builder gave it', () => {
  expectTypeOf<SaleOrderFields<SaleView>['partner']>().toEqualTypeOf<
    typeof SaleOrder.fields.partner
  >();
  expectTypeOf<SaleOrderFields<SaleView>['amountTotal']>().toEqualTypeOf<
    typeof SaleOrder.fields.amountTotal
  >();
  expectTypeOf<SaleOrderFields<SaleView>['state']>().toEqualTypeOf<typeof SaleOrder.fields.state>();
  expectTypeOf<SaleOrderFields<SaleView>['id']>().toEqualTypeOf<typeof SaleOrder.fields.id>();
  expectTypeOf<
    SaleOrderFields<SaleView>['warehouse' & keyof SaleOrderFields<SaleView>]
  >().toBeNever();
});

test('sale_stock sees warehouse but not margin; sale_margin the reverse; the app sees both', () => {
  expectTypeOf<SaleOrderFields<SaleStockView>['warehouse']>().toEqualTypeOf<
    F.Many2one<'stock.warehouse', { readonly required: true; readonly default: true }>
  >();
  expectTypeOf<keyof SaleOrderFields<SaleStockView>>().not.toEqualTypeOf<'margin'>();
  expectTypeOf<'margin'>().not.toMatchTypeOf<keyof SaleOrderFields<SaleStockView>>();
  expectTypeOf<'warehouse'>().not.toMatchTypeOf<keyof SaleOrderFields<SaleMarginView>>();
  expectTypeOf<'margin'>().toMatchTypeOf<keyof SaleOrderFields<SaleMarginView>>();
  expectTypeOf<'margin' | 'warehouse'>().toMatchTypeOf<keyof SaleOrderFields<AppView>>();
  expectTypeOf<'stock.warehouse'>().not.toMatchTypeOf<keyof SaleMarginView>();
});

test('faces and methods follow the view', () => {
  type AppRead = ReadOf<SaleOrderFields<AppView>>;
  expectTypeOf<AppRead['margin']>().toEqualTypeOf<Decimal | null>();
  expectTypeOf<AppRead['warehouse']>().toEqualTypeOf<{ readonly id: Id<'stock.warehouse'> }>();
  // warehouse has a default, so sale's create() values stay valid in an installation with sale_stock (S1).
  expectTypeOf<CreateValues<SaleStockView, 'sale.order'>>().toMatchTypeOf<{
    readonly warehouse?: Id<'stock.warehouse'>;
  }>();
  expectTypeOf<CreateValues<SaleView, 'sale.order'>>().not.toHaveProperty('warehouse');

  type StockMethods = SaleStockView['sale.order']['methods'];
  expectTypeOf<StockMethods['confirm']>().returns.resolves.toBeVoid();
  expectTypeOf<StockMethods['createPickings']>().returns.resolves.toBeNumber();
  expectTypeOf<SaleView['sale.order']['methods']>().not.toHaveProperty('createPickings');
  expectTypeOf<AppView['sale.order']['methods']>().toHaveProperty('computeMargin');
});

test('the bindings alias Env to the view', () => {
  expectTypeOf<Parameters<SaleEnv['model']>[0]>().toEqualTypeOf<keyof SaleView & string>();
});
