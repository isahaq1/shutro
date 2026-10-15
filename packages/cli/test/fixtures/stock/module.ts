import { defineModel, defineModule, f } from '@shutro/core';
import { base } from '../base/module.js';

export const StockWarehouse = defineModel('stock.warehouse', {
  fields: { name: f.char({ required: true }), code: f.char({ required: true, size: 5 }) },
});

export const stock = defineModule({
  name: 'stock',
  version: '1.0.0',
  depends: [base],
  models: [StockWarehouse],
});
