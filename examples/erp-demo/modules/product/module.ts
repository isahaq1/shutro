/**
 * product: units of measure, taxes and products (translated names, numbered codes).
 */
import { defineModel, defineModule, defineSequence, f } from '@shutro/core';
import { sql } from '@shutro/sql';
import { base } from '../base/module.ts';

const manage = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const UomUom = defineModel('uom.uom', {
  access: { 'base.user': ['read'], 'base.admin': manage },
  fields: {
    name: f.char({ required: true, translate: true }),
    category: f.char({ required: true }),
    ratio: f.decimal({ scale: 6, required: true, default: '1' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});

/** Taxes are master data here (Odoo keeps them in account); both sale and invoice lines use them. */
export const AccountTax = defineModel('account.tax', {
  access: { 'base.user': ['read'], 'base.admin': manage },
  fields: {
    name: f.char({ required: true, translate: true }),
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
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ required: true, readonly: true, sequence: 'product.product', index: 'unique' }),
    kind: f.selection({ consu: 'Goods', service: 'Service' }, { default: 'consu' }),
    listPrice: f.decimal({ scale: 2, required: true, default: '0' }),
    uom: f.many2one('uom.uom', { required: true }),
    tax: f.many2one('account.tax'),
    description: f.text({ translate: true }),
  },
});

export const product = defineModule({
  name: 'product',
  version: '1.0.0',
  depends: [base],
  sequences: [
    defineSequence({ code: 'product.product', prefix: 'P', padding: 5, perCompany: false }),
  ],
  models: [UomUom, AccountTax, ProductProduct],
});
