/**
 * Security fixtures (RFC 0014): groups with inheritance, default-deny ACL, record rules with placeholders, field
 * groups, an encrypted field, and a line model without rules (to test bypass through relations).
 */
import {
  buildRegistry,
  defineGroup,
  defineModel,
  defineModule,
  type Env,
  f,
  type Id,
} from '../../src/index.js';

export const Users = defineModel('res.users', {
  access: { 'base.user': ['read'] },
  fields: { login: f.char({ required: true }) },
});
export const Currency = defineModel('res.currency', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
export const Company = defineModel('res.company', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
export const Partner = defineModel('res.partner', {
  access: {
    'base.user': ['read', 'create', 'write'],
    'hr.manager': ['read', 'write', 'create', 'unlink'],
  },
  tracking: ['ssn'],
  fields: {
    name: f.char({ required: true }),
    secret: f.char({ groups: ['hr.manager'] }),
    ssn: f.char({ encrypted: true, groups: { read: ['hr.manager'], write: ['hr.manager'] } }),
  },
});
export const base = defineModule({
  name: 'base',
  groups: [
    defineGroup({ code: 'base.user', label: 'User' }),
    defineGroup({ code: 'hr.manager', label: 'HR manager', implies: ['base.user'] }),
  ],
  models: [Users, Currency, Company, Partner],
});

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  access: {
    'sale.user': ['read', 'write', 'create'],
    'sale.manager': ['read', 'write', 'create', 'unlink', 'export'],
  },
  rules: {
    own: {
      groups: ['sale.user'],
      perms: ['read', 'write', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
    all: { groups: ['sale.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
    company: {
      groups: 'global',
      perms: ['read', 'write', 'create', 'unlink'],
      domain: { company: { in: { $env: 'companyIds' } } },
    },
  },
  fields: {
    name: f.char({ required: true }),
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.uid as Id<'res.users'>,
    }),
    partner: f.many2one('res.partner', { required: true }),
    note: f.text(),
    margin: f.decimal({ scale: 2, groups: ['sale.manager'] }),
    lines: f.one2many('sale.order.line', 'order'),
  },
});
export const SaleOrderLine = defineModel('sale.order.line', {
  access: {
    'sale.user': ['read', 'write', 'create'],
    'sale.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
  },
});
export const sale = defineModule({
  name: 'sale',
  depends: [base],
  groups: [
    defineGroup({ code: 'sale.user', label: 'Sales user', implies: ['base.user'] }),
    defineGroup({ code: 'sale.manager', label: 'Sales manager', implies: ['sale.user'] }),
  ],
  models: [SaleOrder, SaleOrderLine],
});

export const registry = buildRegistry({ modules: [sale] });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
