/**
 * Generates the per-module views of the official apps (`shutro generate` in this directory). The views are committed
 * and shipped, so applications get typed apps without generating someone else's sources (RFC 0002 §11.3).
 *
 * A plain object, not `defineConfig`: importing the CLI here would make the CLI and the apps depend on each other.
 */
export default {
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
};
