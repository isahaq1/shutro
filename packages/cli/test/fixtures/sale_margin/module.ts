import { defineModule, extendModel, f } from '@shutro/core';
import { sale } from '../sale/module.js';

export const SaleOrderMargin = extendModel('sale.order', {
  fields: {
    margin: f.decimal({ scale: 2, compute: 'computeMargin', store: true }),
  },
  methods: {
    computeMargin(): void {},
  },
  overrides: {
    async confirm(next: () => Promise<void>): Promise<void> {
      await next();
    },
  },
});

export const saleMargin = defineModule({
  name: 'sale_margin',
  version: '1.0.0',
  depends: [sale],
  models: [],
  extensions: [SaleOrderMargin],
});
