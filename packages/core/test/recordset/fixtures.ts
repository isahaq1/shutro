import { defineModel, defineModule, f } from '../../src/index.js';

export const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });

export const Currency = defineModel('res.currency', {
  fields: {
    name: f.char({ required: true, label: 'Code' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
    decimalPlaces: f.integer(),
    roundingMethod: f.selection({
      half_up: 'Half up',
      half_even: 'Half even',
      up: 'Up',
      down: 'Down',
    }),
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
  companyScoped: { required: false },
  fields: {
    name: f.char({ required: true }),
    email: f.char(),
    parent: f.many2one('res.partner'),
    children: f.one2many('res.partner', 'parent'),
  },
});

export const Uom = defineModel('uom.uom', {
  fields: {
    name: f.char({ required: true }),
    category: f.char({ required: true }),
    ratio: f.decimal({ scale: 6, required: true, default: '1' }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});

export const base = defineModule({
  name: 'base',
  models: [Users, Currency, Company, Partner, Uom],
});

export const Tag = defineModel('sale.tag', { fields: { name: f.char({ required: true }) } });

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  order: ['dateOrder desc', 'id desc'],
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    dateOrder: f.datetime({ required: true }),
    validityDate: f.date(),
    note: f.text(),
    amountTotal: f.monetary({ currency: 'currency', required: true, default: '0' }),
    lines: f.one2many('sale.order.line', 'order'),
    tags: f.many2many('sale.tag'),
    state: f.state({
      states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        confirm: { from: ['draft'], to: 'sale' },
        cancel: { from: ['draft', 'sale'], to: 'cancel' },
      },
    }),
    attachment: f.binary(),
  },
});

export const SaleOrderLine = defineModel('sale.order.line', {
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    uom: f.many2one('uom.uom'),
    quantity: f.quantity({ uom: 'uom', required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 4, required: true, default: '0' }),
    subtotal: f.monetary({ currency: 'currency', required: true, default: '0' }),
  },
});

export const sale = defineModule({
  name: 'sale',
  depends: [base],
  models: [Tag, SaleOrder, SaleOrderLine],
});
