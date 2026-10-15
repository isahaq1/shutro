/**
 * partner: customers and suppliers, shared across companies unless a company is set.
 */
import { defineModel, defineModule, f } from '@shutro/core';
import type { Records } from '../../app/types.ts';
import { base } from '../base/module.ts';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const ResPartner = defineModel('res.partner', {
  archivable: true,
  companyScoped: { required: false },
  access: {
    'base.user': ['read', 'write', 'create'],
    'base.admin': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  tracking: ['name', 'email'],
  fields: {
    name: f.char({ required: true, index: 'trigram' }),
    email: f.char(),
    phone: f.char(),
    isCompany: f.boolean({ default: false }),
    parent: f.many2one('res.partner', { ondelete: 'set null' }),
    contacts: f.one2many('res.partner', 'parent'),
    /** The partner's preferred currency for quotations and invoices. */
    currency: f.many2one('res.currency'),
  },
  constraints: {
    emailFormat: {
      depends: ['email'],
      check(records: unknown): unknown {
        return (records as Records<'res.partner'>).filter(
          (p) => p.email !== null && !EMAIL.test(p.email),
        );
      },
      message: 'An email address must look like name@example.com.',
    },
  },
});

export const partner = defineModule({
  name: 'partner',
  version: '1.0.0',
  depends: [base],
  models: [ResPartner],
});
