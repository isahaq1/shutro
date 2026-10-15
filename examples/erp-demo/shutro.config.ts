import { defineConfig } from '@shutro/cli';

export default defineConfig({
  modules: [
    './modules/base/module.ts',
    './modules/partner/module.ts',
    './modules/product/module.ts',
    './modules/sale/module.ts',
    './modules/invoice/module.ts',
  ],
  migrations: './migrations',
});
