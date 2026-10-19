/**
 * @packageDocumentation
 * `@shutro/apps`: the official apps (RFC 0019 §7.2). Settings, Accounting, Sales, Purchase and Project, the technical
 * modules they share (base, partner, product), and the glue modules that connect them when both sides are installed.
 *
 * @example
 * ```ts
 * // shutro.config.ts
 * export default defineConfig({ modules: ['@shutro/apps', './modules/my_module/module.ts'], install: DEFAULT_APPS });
 * ```
 */
import type { ModuleBase } from '@shutro/core';
import { account } from './account/module.js';
import { base } from './base/module.js';
import { partner } from './partner/module.js';
import { product } from './product/module.js';
import { project } from './project/module.js';
import { purchase } from './purchase/module.js';
import { purchaseAccount } from './purchase_account/module.js';
import { sale } from './sale/module.js';
import { saleAccount } from './sale_account/module.js';
import { saleProject } from './sale_project/module.js';
import { salePurchase } from './sale_purchase/module.js';
import { settings } from './settings/module.js';

export * from './account/module.js';
export * from './base/module.js';
export { icons } from './icons.js';
export * from './partner/module.js';
export * from './product/module.js';
export * from './project/module.js';
export * from './purchase/module.js';
export * from './purchase_account/module.js';
export * from './sale/module.js';
export * from './sale_account/module.js';
export * from './sale_project/module.js';
export * from './sale_purchase/module.js';
export * from './settings/module.js';

/** Every official module, in dependency order. */
export const officialApps: readonly ModuleBase[] = [
  base,
  settings,
  partner,
  product,
  account,
  sale,
  purchase,
  project,
  saleAccount,
  purchaseAccount,
  saleProject,
  salePurchase,
];

/** The apps a fresh install gets (RFC 0019 R2); dependencies and glue modules follow automatically. */
export const DEFAULT_APPS: readonly string[] = [
  'settings',
  'account',
  'sale',
  'purchase',
  'project',
];
