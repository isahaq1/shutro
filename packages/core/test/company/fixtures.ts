/**
 * Multi-company and multi-currency fixtures: company-scoped partners and orders with a checkCompany link, and the
 * `res.currency.rate` model `env.fx` reads.
 */
import { buildRegistry, defineModel, defineModule, f } from '../../src/index.js';

export const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
export const Currency = defineModel('res.currency', {
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
    decimalPlaces: f.integer(),
  },
});
export const Company = defineModel('res.company', {
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
export const CurrencyRate = defineModel('res.currency.rate', {
  fields: {
    currency: f.many2one('res.currency', { required: true, ondelete: 'cascade' }),
    company: f.many2one('res.company'),
    date: f.date({ required: true }),
    /** Units of `currency` per one unit of the company currency (RFC 0006 §7.6). */
    rate: f.decimal({ scale: 14, required: true }),
  },
});
export const Partner = defineModel('res.partner', {
  companyScoped: { required: false },
  fields: { name: f.char({ required: true }) },
});
export const base = defineModule({
  name: 'base',
  models: [Users, Currency, Company, CurrencyRate, Partner],
});

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    currency: f.many2one('res.currency', { required: true }),
    amount: f.monetary({ currency: 'currency', required: true, default: '0' }),
  },
});
export const sale = defineModule({ name: 'sale', depends: [base], models: [SaleOrder] });

export const registry = buildRegistry({ modules: [sale] });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
