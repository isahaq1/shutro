/**
 * base (required): users, companies, currencies with dated rates, and the two base security groups. Every app
 * depends on it.
 */
import { defineGroup } from '@shutro/core';
import { icons } from '../icons.js';
import { defineModel, defineModule, f, record } from './.shutro/bindings.js';

export const ResUsers = defineModel('res.users', {
  label: 'User',
  archivable: true,
  access: { 'base.user': ['read'] }, // administrators need no grant
  fields: {
    login: f.char({ required: true, index: 'unique' }),
    name: f.char({ required: true }),
    email: f.char(),
  },
});

export const ResCurrency = defineModel('res.currency', {
  label: 'Currency',
  access: { 'base.user': ['read'] },
  order: ['name'],
  fields: {
    name: f.char({ required: true, size: 3, index: 'unique' }),
    symbol: f.char({ size: 8 }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
    decimalPlaces: f.integer({ default: 2 }),
  },
});

export const ResCurrencyRate = defineModel('res.currency.rate', {
  label: 'Exchange rate',
  access: { 'base.user': ['read'] },
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
  label: 'Company',
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    email: f.char(),
    phone: f.char(),
    /** VAT / tax identification number. */
    taxId: f.char(),
  },
});

const currency = (code: string, symbol: string, decimalPlaces = 2) =>
  record('res.currency', `currency_${code.toLowerCase()}`, {
    name: code,
    symbol,
    decimalPlaces,
    rounding: decimalPlaces === 0 ? '1' : '0.01',
  });

export const base = defineModule({
  name: 'base',
  version: '1.0.0',
  label: 'Base',
  required: true,
  icon: icons.base,
  glyph: '🧩',
  summary: 'Users, companies and currencies',
  groups: [
    defineGroup({ code: 'base.user', label: 'Internal user' }),
    defineGroup({
      code: 'base.admin',
      label: 'Administrator',
      implies: ['base.user'],
      administrator: true, // can do everything, in every app, without grants
    }),
  ],
  models: [ResUsers, ResCurrency, ResCurrencyRate, ResCompany],
  data: [
    currency('USD', '$'),
    currency('EUR', '€'),
    currency('GBP', '£'),
    currency('BDT', '৳'),
    currency('INR', '₹'),
    currency('JPY', '¥', 0),
  ],
});
