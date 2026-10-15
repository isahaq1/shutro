import { defineConfig } from '../../src/index.js';

export default defineConfig({
  modules: [
    './base/module.ts',
    './sale/module.ts',
    './stock/module.ts',
    './sale_stock/module.ts',
    './sale_margin/module.ts',
  ],
  app: './app',
});
