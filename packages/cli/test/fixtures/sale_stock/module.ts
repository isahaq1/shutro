import { defineModule, extendModel, f } from '@shutro/core';
import { sale } from '../sale/module.js';
import { stock } from '../stock/module.js';

export const SaleOrderStock = extendModel('sale.order', {
  fields: {
    warehouse: f.many2one('stock.warehouse', { required: true, default: () => 1 as never }),
  },
  methods: {
    async createPickings(): Promise<number> {
      return 0;
    },
  },
});

export const saleStock = defineModule({
  name: 'sale_stock',
  version: '1.0.0',
  depends: [sale, stock],
  models: [],
  extensions: [SaleOrderStock],
});
