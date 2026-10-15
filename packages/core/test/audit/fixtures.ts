/**
 * Audit fixtures (RFC 0013): a sale order with tracked scalar, relation, computed and state fields.
 */
import {
  buildRegistry,
  type ComputeSet,
  type DefaultLoaded,
  defineModel,
  defineModule,
  f,
  type Merge,
  type ToLoaded,
  toDecimal,
} from '../../src/index.js';

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
export const Partner = defineModel('res.partner', { fields: { name: f.char({ required: true }) } });
export const base = defineModule({ name: 'base', models: [Users, Currency, Company, Partner] });

type LineSet = ComputeSet<S, 'sale.order.line', DefaultLoaded<S, 'sale.order.line'>>;
type OrderSet = ComputeSet<
  S,
  'sale.order',
  Merge<DefaultLoaded<S, 'sale.order'>, ToLoaded<S, 'sale.order', { lines: ['subtotal'] }>>
>;

export const SaleOrderLine = defineModel('sale.order.line', {
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0' }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['priceUnit'],
      compute(records: unknown): void {
        for (const line of records as LineSet) line.subtotal = line.priceUnit;
      },
    }),
  },
});

export const SaleOrder = defineModel('sale.order', {
  tracking: ['partner', 'note'],
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    note: f.text(),
    untracked: f.text(),
    lines: f.one2many('sale.order.line', 'order'),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      tracking: true,
      depends: ['lines.subtotal'],
      compute(records: unknown): void {
        for (const o of records as OrderSet)
          o.amountTotal = [...o.lines].reduce(
            (acc, l) => acc.plus(l.subtotal?.amount ?? toDecimal(0)),
            toDecimal(0),
          );
      },
    }),
    state: f.state({
      states: { draft: 'Draft', sale: 'Confirmed', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        confirm: { from: ['draft'], to: 'sale' },
        cancel: { from: ['draft', 'sale'], to: 'cancel' },
      },
    }),
  },
});

export const sale = defineModule({
  name: 'sale',
  depends: [base],
  models: [SaleOrderLine, SaleOrder],
});

export const registry = buildRegistry({ modules: [sale] });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
