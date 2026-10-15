import { defineModel, defineModule, f } from '@shutro/core';
import { base } from '../base/module.js';

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  fields: {
    name: f.char({ required: true, size: 64 }),
    partner: f.many2one('res.partner', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    state: f.selection(
      { draft: 'Draft', sale: 'Confirmed', cancel: 'Cancelled' },
      { default: 'draft', extensible: true },
    ),
    dateOrder: f.datetime(),
    note: f.text(),
    lines: f.one2many('sale.order.line', 'order'),
    amountTotal: f.monetary({ currency: 'currency', compute: 'computeAmounts', store: true }),
  },
  methods: {
    async confirm(): Promise<void> {},
    computeAmounts(): void {},
  },
});

export const SaleOrderLine = defineModel('sale.order.line', {
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    description: f.char({ required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0' }),
  },
});

export const sale = defineModule({
  name: 'sale',
  version: '1.0.0',
  depends: [base],
  models: [SaleOrder, SaleOrderLine],
});
