/**
 * Models for the constraints and onchange tests (RFC 0009): a business constraint with a message function, SQL
 * unique / check constraints, a line constraint, a computed total, and cascading onchange handlers.
 */
import { sql } from '@shutro/sql';
import {
  buildRegistry,
  type ComputeSet,
  type DefaultLoaded,
  type Draft,
  defineModel,
  defineModule,
  type Env,
  f,
  type Merge,
  type RecordSet,
  type ToLoaded,
  toDecimal,
} from '../../src/index.js';

export const calls = { validity: 0, positiveQuantity: 0, partnerOnchange: 0, currencyOnchange: 0 };

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
export const Partner = defineModel('res.partner', {
  archivable: true,
  fields: {
    name: f.char({ required: true }),
    email: f.char(),
    currency: f.many2one('res.currency'),
  },
});
export const base = defineModule({ name: 'base', models: [Users, Currency, Company, Partner] });

type LineSet = ComputeSet<S, 'sale.order.line', DefaultLoaded<S, 'sale.order.line'>>;
type Lines = RecordSet<S, 'sale.order.line', DefaultLoaded<S, 'sale.order.line'>>;

export const SaleOrderLine = defineModel('sale.order.line', {
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 4, required: true, default: '0' }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['quantity', 'priceUnit'],
      compute(records: unknown): void {
        for (const line of records as LineSet) line.subtotal = line.quantity.times(line.priceUnit);
      },
    }),
  },
  onchange: {
    // Runs inside the order's onchange for new line rows (feedback #10): reads the parent draft.
    async name(draft: unknown): Promise<void> {
      const d = draft as Draft<S, 'sale.order.line'>;
      const order = await d.record('order');
      if (order !== null && d.get('currency') === null) d.set('currency', order.currency.id);
    },
    quantity(draft: unknown): void {
      const d = draft as Draft<S, 'sale.order.line'>;
      if (d.get('quantity')?.gt(100) === true) d.warn('Large quantity: check the stock.');
    },
  },
  constraints: {
    positiveQuantity: {
      depends: ['quantity'],
      check(records: unknown): unknown {
        calls.positiveQuantity++;
        return (records as Lines).filter((l) => l.quantity.lte(0));
      },
      message: 'Line quantities must be positive.',
    },
  },
});

type OrderSet = ComputeSet<
  S,
  'sale.order',
  Merge<DefaultLoaded<S, 'sale.order'>, ToLoaded<S, 'sale.order', { lines: ['subtotal'] }>>
>;
type Orders = RecordSet<S, 'sale.order', DefaultLoaded<S, 'sale.order'>>;
type OrderDraft = Draft<S, 'sale.order'>;

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: '2026-10-01' }),
    validityDate: f.date(),
    taxRate: f.decimal({ scale: 4, required: true, default: '0.1' }),
    note: f.text(),
    lines: f.one2many('sale.order.line', 'order'),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['lines.subtotal', 'taxRate'],
      compute(records: unknown): void {
        for (const o of records as OrderSet) {
          const untaxed = [...o.lines].reduce(
            (acc, l) => acc.plus(l.subtotal?.amount ?? toDecimal(0)),
            toDecimal(0),
          );
          o.amountTotal = untaxed.times(toDecimal(1).plus(o.taxRate));
        }
      },
    }),
  },
  constraints: {
    validity: {
      depends: ['validityDate', 'dateOrder'],
      check(records: unknown): unknown {
        calls.validity++;
        return (records as Orders).filter(
          (o) => o.validityDate !== null && o.validityDate < o.dateOrder,
        );
      },
      message: (failing: unknown): string =>
        `The validity date is before the order date on ${(failing as Orders).length} order(s). Set a later validity date.`,
    },
  },
  sqlConstraints: {
    nameUnique: {
      unique: ['company', 'name'],
      message: 'Order reference must be unique per company.',
    },
    taxRateNonNegative: { check: sql`tax_rate >= 0`, message: 'The tax rate cannot be negative.' },
  },
  onchange: {
    async partner(draft: unknown, _env: unknown): Promise<void> {
      calls.partnerOnchange++;
      const d = draft as OrderDraft;
      const partner = await d.record('partner');
      if (partner === null) return;
      if (partner.currency !== null) d.set('currency', partner.currency.id);
      if (partner.email === null) d.warn('This partner has no email address.');
    },
    currency(draft: unknown, env: unknown): void {
      calls.currencyOnchange++;
      (draft as OrderDraft).set('note', `currency set by uid ${(env as Env<S>).uid}`);
    },
  },
});

export const sale = defineModule({
  name: 'sale',
  depends: [base],
  models: [SaleOrderLine, SaleOrder],
});

export const registry = buildRegistry({ modules: [sale], security: { enforce: false } });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
