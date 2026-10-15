/**
 * Sequences (RFC 0012): a standard yearly order sequence filled at create, and a gapless monthly invoice sequence
 * assigned when the move is posted.
 */
import {
  buildRegistry,
  type DefaultLoaded,
  defineModel,
  defineModule,
  defineSequence,
  f,
  type RecordSet,
} from '../../src/index.js';

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

type Moves = RecordSet<S, 'account.move', DefaultLoaded<S, 'account.move'>>;

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  fields: {
    name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),
    note: f.text(),
  },
});

export const AccountMove = defineModel('account.move', {
  companyScoped: { required: true },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'account.move', gapless: true, on: 'manual', dateField: 'date' },
    }),
    date: f.date({ required: true }),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          async before(records: unknown): Promise<void> {
            await (records as Moves).assignNumber('name');
          },
        },
      },
    }),
  },
});

export const sale = defineModule({
  name: 'sale',
  depends: [base],
  sequences: [defineSequence({ code: 'sale.order', prefix: 'SO/', padding: 5 })],
  models: [SaleOrder],
});
export const account = defineModule({
  name: 'account',
  depends: [base],
  sequences: [
    defineSequence({
      code: 'account.move',
      prefix: 'INV/{year}/{month}/',
      padding: 4,
      reset: 'monthly',
      gapless: true,
    }),
  ],
  models: [AccountMove],
});

export const registry = buildRegistry({ modules: [sale, account], security: { enforce: false } });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
