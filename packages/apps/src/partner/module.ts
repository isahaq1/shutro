/**
 * partner: customers, vendors and their contacts, shared across companies unless a company is set.
 */
import { base } from '../base/module.js';
import { icons } from '../icons.js';
import { check, defineModel, defineModule, f } from './.shutro/bindings.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const ResPartner = defineModel('res.partner', {
  archivable: true,
  companyScoped: { required: false },
  order: ['name'],
  access: {
    'base.user': ['read', 'write', 'create'],
    'base.admin': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  tracking: ['name', 'email'],
  fields: {
    name: f.char({ required: true, index: 'trigram' }),
    email: f.char(),
    phone: f.char(),
    street: f.char(),
    city: f.char(),
    country: f.char({ size: 2 }),
    taxId: f.char(),
    isCompany: f.boolean({ default: false }),
    isCustomer: f.boolean({ default: false }),
    isVendor: f.boolean({ default: false }),
    parent: f.many2one('res.partner', { ondelete: 'set null' }),
    contacts: f.one2many('res.partner', 'parent'),
    /** Preferred currency for quotations, orders and invoices. */
    currency: f.many2one('res.currency'),
  },
  constraints: {
    emailFormat: {
      ...check('res.partner', ['email'], (partners) =>
        partners.filter((p) => p.email !== null && !EMAIL.test(p.email)),
      ),
      message: 'An email address must look like name@example.com.',
    },
  },
});

export const partner = defineModule({
  name: 'partner',
  version: '1.0.0',
  label: 'Contacts',
  icon: icons.partner,
  glyph: '👥',
  summary: 'Customers, vendors and contacts',
  depends: [base],
  models: [ResPartner],
});
