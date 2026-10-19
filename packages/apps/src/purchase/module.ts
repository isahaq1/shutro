/**
 * Purchase (app): requests for quotation and purchase orders to vendors. Numbered at creation, amounts computed from
 * lines, prices default to the product cost; buyers see their own orders, managers see all.
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

const amounts = compute(
  'purchase.order',
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

export const PurchaseOrder = defineModel('purchase.order', {
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  tracking: ['partner', 'amountTotal', 'state'],
  access: {
    'purchase.user': ['read', 'write', 'create'],
    'purchase.manager': ['read', 'write', 'create', 'unlink', 'export'],
  },
  rules: {
    own: { groups: ['purchase.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
    all: { groups: ['purchase.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  },
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'purchase.order', dateField: 'dateOrder' },
    }),
    user: f.many2one('res.users', { required: true, default: (env: Env) => env.userId }),
    /** The vendor. */
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    partnerReference: f.char(),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.date({ required: true, default: (env: Env) => env.today() }),
    datePlanned: f.date(),
    origin: f.char(),
    note: f.text(),
    lines: f.one2many('purchase.order.line', 'order'),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTax: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTotal: f.monetary({ currency: 'currency', store: true, ...amounts }),
    state: f.state({
      states: {
        draft: 'RFQ',
        sent: 'RFQ sent',
        purchase: 'Purchase order',
        done: 'Locked',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        send: { from: ['draft'], to: 'sent' },
        confirm: {
          from: ['draft', 'sent'],
          to: 'purchase',
          guard: records('purchase.order', async (orders) => {
            const loaded = await orders.load({ lines: true });
            return loaded.filter((o) => o.lines.length === 0);
          }),
          message: 'Add at least one line before confirming the order.',
        },
        lock: { from: ['purchase'], to: 'done' },
        unlock: { from: ['done'], to: 'purchase' },
        cancel: { from: ['draft', 'sent', 'purchase'], to: 'cancel' },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  onchange: {
    partner: onchange('purchase.order', async (d) => {
      const p = await d.record('partner');
      if (p?.currency) d.set('currency', p.currency.id);
    }),
  },
});

export const PurchaseOrderLine = defineModel('purchase.order.line', {
  access: {
    'purchase.user': ['read', 'write', 'create', 'unlink'],
    'purchase.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    order: f.many2one('purchase.order', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product', { required: true }),
    name: f.char({ required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0' }),
    tax: f.many2one('account.tax'),
    datePlanned: f.date(),
    currency: f.many2one('res.currency', {
      store: true,
      ...compute('purchase.order.line', 'currency', ['order.currency'], (lines) => {
        for (const l of lines) l.currency = l.order.currency.id;
      }),
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('purchase.order.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit);
      }),
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('purchase.order.line', 'taxAmount', ['subtotal', 'tax.rate'], (lines) => {
        for (const l of lines)
          l.taxAmount = (l.subtotal?.amount ?? toDecimal(0)).times(l.tax?.rate ?? 0);
      }),
    }),
  },
  onchange: {
    product: onchange('purchase.order.line', async (d) => {
      const p = await d.record('product');
      if (p === null) return;
      d.set('name', p.name);
      d.set('priceUnit', p.standardPrice);
      d.set('tax', p.purchaseTax?.id ?? null);
    }),
  },
  constraints: {
    positiveQuantity: {
      ...check('purchase.order.line', ['quantity'], (lines) =>
        lines.filter((l) => l.quantity.lte(0)),
      ),
      message: 'Line quantities must be positive.',
    },
  },
});

export const purchase = defineModule({
  name: 'purchase',
  version: '1.0.0',
  label: 'Purchase',
  application: true,
  icon: icons.purchase,
  glyph: '🛒',
  category: 'Inventory & Purchasing',
  summary: 'Requests for quotation, purchase orders and vendors',
  depends: [partner, product],
  groups: [
    defineGroup({ code: 'purchase.user', label: 'Buyer', implies: ['base.user'] }),
    defineGroup({
      code: 'purchase.manager',
      label: 'Purchase manager',
      implies: ['purchase.user'],
    }),
  ],
  sequences: [
    defineSequence({ code: 'purchase.order', prefix: 'PO/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [PurchaseOrder, PurchaseOrderLine],
});
