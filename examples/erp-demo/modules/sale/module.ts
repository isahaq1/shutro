/**
 * sale: quotations and sales orders. Numbered at creation, amounts computed from lines, a guarded workflow,
 * salespeople see their own orders, managers see all.
 */
import {
  defineGroup,
  defineModel,
  defineModule,
  defineSequence,
  type Env,
  f,
  type Id,
  toDecimal,
} from '@shutro/core';
import { type ComputeRecords, type Draft, type Records, readMoney } from '../../app/types.ts';
import { partner } from '../partner/module.ts';
import { product } from '../product/module.ts';

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  tracking: ['partner', 'amountTotal'],
  access: {
    'sale.user': ['read', 'write', 'create'],
    'sale.manager': ['read', 'write', 'create', 'unlink', 'export'],
  },
  rules: {
    own: { groups: ['sale.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
    all: { groups: ['sale.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'sale.order', dateField: 'dateOrder' },
    }),
    user: f.many2one('res.users', {
      required: true,
      default: (env: Env) => env.uid as Id<'res.users'>,
    }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today() }),
    note: f.text(),
    lines: f.one2many('sale.order.line', 'order'),
    amountUntaxed: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['lines.subtotal'],
      compute: 'computeAmounts',
    }),
    amountTax: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['lines.taxAmount'],
      compute: 'computeAmounts',
    }),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['amountUntaxed', 'amountTax'],
      compute: 'computeAmounts',
    }),
    state: f.state({
      states: {
        draft: 'Quotation',
        sent: 'Quotation sent',
        sale: 'Sales order',
        done: 'Locked',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        send: { from: ['draft'], to: 'sent' },
        confirm: {
          from: ['draft', 'sent'],
          to: 'sale',
          async guard(records: unknown): Promise<unknown> {
            const orders = await (records as Records<'sale.order'>).load({ lines: true });
            return orders.filter((o) => o.lines.length === 0);
          },
          message: 'Add at least one line before confirming the order.',
        },
        lock: { from: ['sale'], to: 'done' },
        cancel: { from: ['draft', 'sent', 'sale'], to: 'cancel' },
      },
      extensible: true,
    }),
  },
  onchange: {
    async partner(draft: unknown): Promise<void> {
      const d = draft as Draft<'sale.order'>;
      const p = await d.record('partner');
      if (p?.currency !== null && p?.currency !== undefined) d.set('currency', p.currency.id);
    },
  },
  methods: {
    computeAmounts(records: unknown): void {
      for (const o of records as ComputeRecords<
        'sale.order',
        { lines: ['subtotal', 'taxAmount'] }
      >) {
        let untaxed = toDecimal(0);
        let tax = toDecimal(0);
        for (const l of o.lines) {
          untaxed = untaxed.plus(l.subtotal?.amount ?? 0);
          tax = tax.plus(l.taxAmount?.amount ?? 0);
        }
        o.amountUntaxed = untaxed;
        o.amountTax = tax;
        o.amountTotal = untaxed.plus(tax);
      }
    },
  },
});

export const SaleOrderLine = defineModel('sale.order.line', {
  access: {
    'sale.user': ['read', 'write', 'create', 'unlink'],
    'sale.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true }),
    name: f.char({ required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0' }),
    tax: f.many2one('account.tax'),
    /** The order's currency, so line amounts are Money in it. */
    currency: f.many2one('res.currency', {
      store: true,
      depends: ['order.currency'],
      compute(records: unknown): void {
        for (const l of records as ComputeRecords<'sale.order.line', { order: ['currency'] }>) {
          // An onchange draft has no order yet, although the field is required (docs/feedback.md #4).
          const order = l.order as typeof l.order | null;
          l.currency = order === null ? null : order.currency.id;
        }
      },
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['quantity', 'priceUnit'],
      compute(records: unknown): void {
        for (const l of records as ComputeRecords<'sale.order.line'>)
          l.subtotal = l.quantity.times(l.priceUnit);
      },
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['subtotal', 'tax.rate'],
      compute(records: unknown): void {
        for (const l of records as ComputeRecords<'sale.order.line', { tax: ['rate'] }>)
          l.taxAmount = (readMoney(l.subtotal)?.amount ?? toDecimal(0)).times(l.tax?.rate ?? 0);
      },
    }),
  },
  onchange: {
    async product(draft: unknown): Promise<void> {
      const d = draft as Draft<'sale.order.line'>;
      const p = await d.record('product');
      if (p === null) return;
      d.set('name', p.name);
      d.set('priceUnit', p.listPrice);
      d.set('tax', p.tax?.id ?? null);
    },
  },
  constraints: {
    positiveQuantity: {
      depends: ['quantity'],
      check(records: unknown): unknown {
        return (records as Records<'sale.order.line'>).filter((l) => l.quantity.lte(0));
      },
      message: 'Line quantities must be positive.',
    },
  },
});

export const sale = defineModule({
  name: 'sale',
  version: '1.0.0',
  depends: [partner, product],
  groups: [
    defineGroup({ code: 'sale.user', label: 'Salesperson', implies: ['base.user'] }),
    defineGroup({ code: 'sale.manager', label: 'Sales manager', implies: ['sale.user'] }),
  ],
  sequences: [
    defineSequence({ code: 'sale.order', prefix: 'SO/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [SaleOrder, SaleOrderLine],
});
