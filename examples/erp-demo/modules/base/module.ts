/**
 * base: users, companies, currencies with dated rates, and the two base security groups.
 */
import { defineGroup, defineModel, defineModule, f } from '@shutro/core';

const all = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const ResUsers = defineModel('res.users', {
  access: { 'base.user': ['read'], 'base.admin': all },
  fields: {
    login: f.char({ required: true, index: 'unique' }),
    name: f.char({ required: true }),
  },
});

export const ResCurrency = defineModel('res.currency', {
  access: { 'base.user': ['read'], 'base.admin': all },
  fields: {
    name: f.char({ required: true, size: 3, index: 'unique' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
    decimalPlaces: f.integer({ default: 2 }),
  },
});

export const ResCurrencyRate = defineModel('res.currency.rate', {
  access: { 'base.user': ['read'], 'base.admin': all },
  order: ['date desc'],
  fields: {
    currency: f.many2one('res.currency', { required: true, ondelete: 'cascade' }),
    company: f.many2one('res.company'),
    date: f.date({ required: true }),
    /** Units of the currency per one unit of the company currency. */
    rate: f.decimal({ scale: 10, required: true }),
  },
});

export const ResCompany = defineModel('res.company', {
  access: { 'base.user': ['read'], 'base.admin': all },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});

export const base = defineModule({
  name: 'base',
  version: '1.0.0',
  groups: [
    defineGroup({ code: 'base.user', label: 'Internal user' }),
    defineGroup({ code: 'base.admin', label: 'Administrator', implies: ['base.user'] }),
  ],
  models: [ResUsers, ResCurrency, ResCurrencyRate, ResCompany],
});
