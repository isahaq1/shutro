/**
 * product: units of measure, taxes and products (translated names, numbered codes). Taxes live here, not in
 * accounting, so Sales and Purchase work without the Accounting app.
 */
import { defineSequence } from '@shutro/core';
import { sql } from '@shutro/sql';
import { base } from '../base/module.js';
import { icons } from '../icons.js';
import { defineModel, defineModule, f, record } from './.shutro/bindings.js';

const manage = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const UomUom = defineModel('uom.uom', {
  access: { 'base.user': ['read'], 'base.admin': manage },
  order: ['category', 'name'],
  fields: {
    name: f.char({ required: true, translate: true }),
    category: f.selection(
      { unit: 'Unit', time: 'Working time', weight: 'Weight', length: 'Length', volume: 'Volume' },
      { required: true, default: 'unit' },
    ),
    /** Units of the category's reference unit per one of this unit. */
    ratio: f.decimal({ scale: 6, required: true, default: '1' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});

export const AccountTax = defineModel('account.tax', {
  archivable: true,
  access: { 'base.user': ['read'], 'base.admin': manage },
  order: ['name'],
  fields: {
    name: f.char({ required: true, translate: true }),
    use: f.selection({ sale: 'Sales', purchase: 'Purchases' }, { required: true, default: 'sale' }),
    /** 0.15 for 15 %. */
    rate: f.decimal({ scale: 4, required: true }),
  },
  // Literal-only fragment: DDL cannot bind parameters.
  sqlConstraints: {
    rateRange: { check: sql`rate >= 0 AND rate <= 1`, message: 'A tax rate is between 0 and 1.' },
  },
});

export const ProductProduct = defineModel('product.product', {
  archivable: true,
  access: { 'base.user': ['read'], 'base.admin': manage },
  order: ['name'],
  tracking: ['listPrice', 'standardPrice'],
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ required: true, readonly: true, sequence: 'product.product', index: 'unique' }),
    kind: f.selection({ consu: 'Goods', service: 'Service' }, { required: true, default: 'consu' }),
    /** Sales price. */
    listPrice: f.decimal({ scale: 2, required: true, default: '0' }),
    /** Cost: the default purchase price. */
    standardPrice: f.decimal({ scale: 2, required: true, default: '0' }),
    uom: f.many2one('uom.uom', { required: true }),
    saleOk: f.boolean({ default: true }),
    purchaseOk: f.boolean({ default: true }),
    /** Default tax on sales. */
    tax: f.many2one('account.tax'),
    /** Default tax on purchases. */
    purchaseTax: f.many2one('account.tax'),
    description: f.text({ translate: true }),
  },
});

export const product = defineModule({
  name: 'product',
  version: '1.0.0',
  label: 'Products',
  icon: icons.product,
  glyph: '📦',
  summary: 'Products, services, units of measure and taxes',
  depends: [base],
  sequences: [
    defineSequence({ code: 'product.product', prefix: 'P', padding: 5, perCompany: false }),
  ],
  models: [UomUom, AccountTax, ProductProduct],
  data: [
    record('uom.uom', 'uom_unit', { name: 'Units', category: 'unit', ratio: '1', rounding: '1' }),
    record('uom.uom', 'uom_dozen', {
      name: 'Dozens',
      category: 'unit',
      ratio: '12',
      rounding: '1',
    }),
    record('uom.uom', 'uom_hour', { name: 'Hours', category: 'time', ratio: '1' }),
    record('uom.uom', 'uom_day', { name: 'Days', category: 'time', ratio: '8' }),
    record('uom.uom', 'uom_kg', { name: 'kg', category: 'weight', ratio: '1' }),
    record('account.tax', 'tax_sale_15', { name: 'VAT 15% (sales)', use: 'sale', rate: '0.15' }),
    record('account.tax', 'tax_purchase_15', {
      name: 'VAT 15% (purchases)',
      use: 'purchase',
      rate: '0.15',
    }),
    record('account.tax', 'tax_exempt', { name: 'Exempt', use: 'sale', rate: '0' }),
  ],
});
