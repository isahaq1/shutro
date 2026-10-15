import { defineModel, defineModule, f } from '@shutro/core';

export const ResUsers = defineModel('res.users', {
  fields: { login: f.char({ required: true }) },
});
export const ResCurrency = defineModel('res.currency', {
  fields: { name: f.char({ required: true }), decimalPlaces: f.integer({ default: 2 }) },
});
export const ResCompany = defineModel('res.company', {
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
export const ResPartner = defineModel('res.partner', {
  archivable: true,
  fields: {
    name: f.char({ required: true, index: true }),
    email: f.char({ index: 'unique' }),
    kind: f.selection({ person: 'Person', company: 'Company' }, { default: 'person' }),
  },
  methods: {
    greeting(this: { readonly length: number }): string {
      return `Hello ${this.length}`;
    },
  },
});

export const base = defineModule({
  name: 'base',
  version: '1.0.0',
  models: [ResUsers, ResCurrency, ResCompany, ResPartner],
});
