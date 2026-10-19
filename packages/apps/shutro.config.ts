/**
 * Generates the per-module views of the official apps (`pnpm exec shutro generate` in this directory). The views are
 * committed and shipped, so applications get typed apps without generating someone else's sources (RFC 0002 §11.3).
 */
import { defineConfig } from '@shutro/cli';

export default defineConfig({
  modules: [
    './src/base/module.ts',
    './src/settings/module.ts',
    './src/partner/module.ts',
    './src/product/module.ts',
    './src/account/module.ts',
    './src/sale/module.ts',
    './src/purchase/module.ts',
    './src/project/module.ts',
    './src/sale_account/module.ts',
    './src/purchase_account/module.ts',
    './src/sale_project/module.ts',
    './src/sale_purchase/module.ts',
  ],
});
