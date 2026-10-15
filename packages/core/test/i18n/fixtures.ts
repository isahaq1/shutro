import { buildRegistry, defineModel, defineModule, f } from '../../src/index.js';

export const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
export const Currency = defineModel('res.currency', {
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
export const Company = defineModel('res.company', {
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
export const base = defineModule({ name: 'base', models: [Users, Currency, Company] });

export const ProductTemplate = defineModel('product.template', {
  order: ['name'],
  fields: {
    name: f.char({ required: true, translate: true }),
    description: f.text({ translate: true }),
    code: f.char(),
    meta: f.json<{ readonly tags: readonly string[] }>(),
  },
});
export const product = defineModule({
  name: 'product',
  depends: [base],
  models: [ProductTemplate],
});

export const registry = buildRegistry({ modules: [product] });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
