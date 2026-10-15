/**
 * Models with computed fields for the compute-engine tests (RFC 0008): a chain line.subtotal → order.amountUntaxed →
 * order.amountTotal, a many2one path, a many2many path, a non-stored count, an inverse, and a required compute.
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

export const calls = {
  subtotal: 0,
  amounts: 0,
  partnerName: 0,
  tagNames: 0,
  lineCount: 0,
  code: 0,
};
/** When true, `code`'s compute assigns nothing (to test the required check). */
export const flags = { skipCode: false };

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

export const Tag = defineModel('sale.tag', { fields: { name: f.char({ required: true }) } });

type LineSet = ComputeSet<S, 'sale.order.line', DefaultLoaded<S, 'sale.order.line'>>;

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
        calls.subtotal++;
        for (const line of records as LineSet) line.subtotal = line.quantity.times(line.priceUnit);
      },
    }),
  },
});

type OrderSet = ComputeSet<
  S,
  'sale.order',
  Merge<
    DefaultLoaded<S, 'sale.order'>,
    ToLoaded<S, 'sale.order', { lines: ['subtotal']; partner: ['name']; tags: ['name'] }>
  >
>;

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    taxRate: f.decimal({ scale: 4, required: true, default: '0.1' }),
    lines: f.one2many('sale.order.line', 'order'),
    tags: f.many2many('sale.tag'),
    amountUntaxed: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['lines.subtotal'],
      compute: 'computeAmounts',
    }),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['amountUntaxed', 'taxRate'],
      compute: 'computeAmounts',
    }),
    partnerName: f.char({
      store: true,
      depends: ['partner.name'],
      compute(records: unknown): void {
        calls.partnerName++;
        for (const o of records as OrderSet) o.partnerName = o.partner.name;
      },
    }),
    tagNames: f.char({
      store: true,
      depends: ['tags.name'],
      compute(records: unknown): void {
        calls.tagNames++;
        for (const o of records as OrderSet)
          o.tagNames = [...o.tags]
            .map((t) => t.name)
            .sort()
            .join(',');
      },
    }),
    lineCount: f.integer({
      depends: ['lines'],
      compute(records: unknown): void {
        calls.lineCount++;
        for (const o of records as OrderSet) o.lineCount = o.lines.length;
      },
    }),
    code: f.char({
      required: true,
      store: true,
      depends: ['name'],
      compute(records: unknown): void {
        calls.code++;
        if (flags.skipCode) return;
        for (const o of records as OrderSet) o.code = o.name.toUpperCase();
      },
      async inverse(records: unknown): Promise<void> {
        for (const o of records as OrderSet) await o.write({ name: String(o.code).toLowerCase() });
      },
    }),
  },
  methods: {
    computeAmounts(records: unknown): void {
      calls.amounts++;
      for (const o of records as OrderSet) {
        const untaxed = [...o.lines].reduce(
          (acc, l) => acc.plus(l.subtotal?.amount ?? toDecimal(0)),
          toDecimal(0),
        );
        o.amountUntaxed = untaxed;
        o.amountTotal = untaxed.times(toDecimal(1).plus(o.taxRate));
      }
    },
  },
});

export const sale = defineModule({
  name: 'sale',
  depends: [base],
  models: [Tag, SaleOrderLine, SaleOrder],
});

export const registry = buildRegistry({ modules: [sale] });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
