/**
 * Sales (app): quotations and sales orders. Numbered at creation, amounts computed from lines, a guarded workflow;
 * salespeople see their own orders, managers see all.
 */
import { defineGroup, defineSequence, toDecimal } from '@shutro/core';
import { icons } from '../icons.js';
import { partner } from '../partner/module.js';
import { product } from '../product/module.js';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  onchange,
  records,
} from './.shutro/bindings.js';

/** One compute for the three totals (they share a function, so they are computed together). */
const amounts = compute(
  'sale.order',
  ['amountUntaxed', 'amountTax', 'amountTotal'],
  ['lines.subtotal', 'lines.taxAmount'],
  (orders) => {
    for (const o of orders) {
      const untaxed = o.lines.sum('subtotal', o.currency);
      const tax = o.lines.sum('taxAmount', o.currency);
      o.amountUntaxed = untaxed;
      o.amountTax = tax;
      o.amountTotal = untaxed.plus(tax);
    }
  },
);

export const SaleOrder = defineModel('sale.order', {
  label: 'Sales order',
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  tracking: ['partner', 'amountTotal', 'state'],
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
    user: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today() }),
    validityDate: f.date(),
    clientReference: f.char(),
    note: f.text(),
    lines: f.one2many('sale.order.line', 'order'),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTax: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTotal: f.monetary({ currency: 'currency', store: true, ...amounts }),
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
          guard: records('sale.order', async (orders) => {
            const loaded = await orders.load({ lines: true });
            return loaded.filter((o) => o.lines.length === 0);
          }),
          message: 'Add at least one line before confirming the order.',
        },
        lock: { from: ['sale'], to: 'done' },
        unlock: { from: ['done'], to: 'sale' },
        cancel: { from: ['draft', 'sent', 'sale'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  onchange: {
    partner: onchange('sale.order', async (d) => {
      const p = await d.record('partner');
      if (p?.currency) d.set('currency', p.currency.id);
    }),
  },
});

export const SaleOrderLine = defineModel('sale.order.line', {
  label: 'Order line',
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
      ...compute('sale.order.line', 'currency', ['order.currency'], (lines) => {
        for (const l of lines) l.currency = l.order.currency.id; // drafts without an order skip this compute
      }),
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('sale.order.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit);
      }),
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('sale.order.line', 'taxAmount', ['subtotal', 'tax.rate'], (lines) => {
        for (const l of lines)
          l.taxAmount = (l.subtotal?.amount ?? toDecimal(0)).times(l.tax?.rate ?? 0);
      }),
    }),
  },
  onchange: {
    product: onchange('sale.order.line', async (d) => {
      const p = await d.record('product');
      if (p === null) return;
      d.set('name', p.name);
      d.set('priceUnit', p.listPrice);
      d.set('tax', p.tax?.id ?? null);
    }),
  },
  constraints: {
    positiveQuantity: {
      ...check('sale.order.line', ['quantity'], (lines) => lines.filter((l) => l.quantity.lte(0))),
      message: 'Line quantities must be positive.',
    },
  },
});

export const sale = defineModule({
  name: 'sale',
  version: '1.0.0',
  label: 'Sales',
  application: true,
  icon: icons.sale,
  glyph: '💼',
  category: 'Sales',
  summary: 'Quotations, sales orders and customers',
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
