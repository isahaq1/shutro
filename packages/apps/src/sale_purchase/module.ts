/**
 * sale_purchase (glue, installed with Sales and Purchase): buy what a sales order sells, from one vendor, linked back
 * to the order.
 */
import type { Id } from '@shutro/core';
import { icons } from '../icons.js';
import { purchase } from '../purchase/module.js';
import { sale } from '../sale/module.js';
import { compute, defineModule, extendModel, f, method } from './.shutro/bindings.js';

export const PurchaseOrderSale = extendModel('purchase.order', {
  fields: { saleOrder: f.many2one('sale.order', { ondelete: 'set null' }) },
});

export const SaleOrderPurchases = extendModel('sale.order', {
  access: { 'purchase.user': ['read'] },
  fields: {
    purchaseOrders: f.one2many('purchase.order', 'saleOrder'),
    purchaseCount: f.integer({
      ...compute('sale.order', 'purchaseCount', ['purchaseOrders'], (orders) => {
        for (const o of orders) o.purchaseCount = o.purchaseOrders.length;
      }),
    }),
  },
  methods: {
    /**
     * Requests for quotation to `vendor` for the goods of confirmed orders (one per order, at the products' cost).
     * Returns the purchase order ids.
     */
    createPurchaseOrders: method(
      'sale.order',
      { elevate: ['sale.order.line:read', 'product.product:read'], reason: 'buy what was sold' },
      async function (options: {
        readonly vendor: Id<'res.partner'>;
      }): Promise<readonly Id<'purchase.order'>[]> {
        // The lines' defaults (name, quantity, …) plus the product fields the purchase needs.
        const orders = await this.load({
          lines: { product: ['kind', 'standardPrice', 'purchaseTax'] },
        });
        const notConfirmed = orders.filter((o) => o.state !== 'sale' && o.state !== 'done');
        if (!notConfirmed.isEmpty())
          throw new Error(
            `Only confirmed orders can be purchased for (${notConfirmed.map((o) => o.name).join(', ')}).`,
          );
        const { env } = orders;
        const created = await env.model('purchase.order').create(
          orders.map((o) => ({
            partner: options.vendor,
            currency: o.currency.id,
            company: o.company.id,
            saleOrder: o.id,
            origin: o.name,
            lines: {
              create: [...o.lines]
                .filter((l) => l.product.kind === 'consu')
                .map((l) => ({
                  product: l.product.id,
                  name: l.name,
                  quantity: l.quantity,
                  priceUnit: l.product.standardPrice,
                  tax: l.product.purchaseTax === null ? null : l.product.purchaseTax.id,
                })),
            },
          })),
        );
        return created.ids;
      },
    ),
  },
});

export const salePurchase = defineModule({
  name: 'sale_purchase',
  version: '1.0.0',
  label: 'Sales purchasing',
  autoInstall: true,
  icon: icons.link,
  glyph: '🔗',
  summary: 'Purchase what sales orders sell',
  depends: [sale, purchase],
  models: [],
  extensions: [PurchaseOrderSale, SaleOrderPurchases],
});
