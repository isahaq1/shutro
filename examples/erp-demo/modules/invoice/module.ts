/**
 * invoice: customer invoices with gapless legal numbering on posting, amounts in the invoice currency and in the
 * company currency (dated rates), and invoicing from sales orders (an extension of sale.order).
 */
import { defineGroup, definePermission, defineSequence, type Id, toDecimal } from '@shutro/core';
import { sale } from '../sale/module.ts';
import {
  compute,
  defineModel,
  defineModule,
  type Env,
  extendModel,
  f,
  method,
  records,
} from './.shutro/bindings.ts';

/** The three totals share one compute (computed together, at the rank of the last one). */
const amounts = compute(
  'account.move',
  ['amountUntaxed', 'amountTax', 'amountTotal'],
  ['lines.subtotal', 'lines.taxAmount'],
  (moves) => {
    for (const m of moves) {
      const untaxed = m.lines.sum('subtotal', m.currency);
      const tax = m.lines.sum('taxAmount', m.currency);
      m.amountUntaxed = untaxed;
      m.amountTax = tax;
      m.amountTotal = untaxed.plus(tax);
    }
  },
);

const accounting = {
  'account.user': ['read', 'write', 'create'],
  'account.manager': ['read', 'write', 'create', 'unlink', 'export'],
} as const;

export const AccountMove = defineModel('account.move', {
  companyScoped: { required: true },
  order: ['date desc', 'id desc'],
  // Invoices dated before today need 'account.backdate' (accounting managers, a special grant, or administrators).
  backdate: { field: 'date', permission: 'account.backdate' },
  tracking: ['partner', 'amountTotal'],
  access: accounting,
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'account.move', on: 'manual', dateField: 'date' },
    }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    currency: f.many2one('res.currency', { required: true }),
    saleOrder: f.many2one('sale.order', { ondelete: 'set null' }),
    lines: f.one2many('account.move.line', 'move'),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTax: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTotal: f.monetary({ currency: 'currency', store: true, ...amounts }),
    companyCurrency: f.many2one('res.currency', {
      store: true,
      ...compute('account.move', 'companyCurrency', ['company.currency'], (moves) => {
        for (const m of moves) m.companyCurrency = m.company.currency.id;
      }),
    }),
    /** The total in the company currency at the invoice date's rate. */
    amountTotalCompany: f.monetary({
      currency: 'companyCurrency',
      store: true,
      ...compute(
        'account.move',
        'amountTotalCompany',
        ['amountTotal', 'date', 'company.currency'],
        async (moves) => {
          // One rate lookup per (date, company), not per invoice.
          const all = [...moves];
          const groups = new Map<string, typeof all>();
          for (const m of all) {
            const key = `${m.date}|${m.company.id}`;
            groups.set(key, [...(groups.get(key) ?? []), m]);
          }
          for (const group of groups.values()) {
            const first = group[0];
            if (first === undefined) continue;
            const rates = await moves.env.fx.prepare({
              date: first.date,
              company: first.company.id,
              currencies: group.map((m) => m.currency.id),
            });
            for (const m of group)
              m.amountTotalCompany =
                m.amountTotal === null
                  ? null
                  : rates.convert(m.amountTotal, rates.companyCurrency).money;
          }
        },
      ),
    }),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          guard: records('account.move', (moves) =>
            moves.filter((m) => m.amountTotal === null || m.amountTotal.isZero()),
          ),
          message: 'An invoice needs a non-zero total to be posted.',
          // Gapless, per month: numbered inside the posting transaction.
          before: records('account.move', (moves) => moves.assignNumber('name')),
        },
        cancel: { from: ['draft', 'posted'], to: 'cancel' },
      },
    }),
  },
});

export const AccountMoveLine = defineModel('account.move.line', {
  access: {
    'account.user': ['read', 'write', 'create', 'unlink'],
    'account.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    move: f.many2one('account.move', { required: true, ondelete: 'cascade' }),
    product: f.many2one('product.product'),
    name: f.char({ required: true }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 2, required: true, default: '0' }),
    tax: f.many2one('account.tax'),
    currency: f.many2one('res.currency', {
      store: true,
      ...compute('account.move.line', 'currency', ['move.currency'], (lines) => {
        for (const l of lines) l.currency = l.move.currency.id; // drafts without a move skip this compute
      }),
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('account.move.line', 'subtotal', ['quantity', 'priceUnit'], (lines) => {
        for (const l of lines) l.subtotal = l.quantity.times(l.priceUnit);
      }),
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      ...compute('account.move.line', 'taxAmount', ['subtotal', 'tax.rate'], (lines) => {
        for (const l of lines)
          l.taxAmount = (l.subtotal?.amount ?? toDecimal(0)).times(l.tax?.rate ?? 0);
      }),
    }),
  },
});

/** Invoicing from sales orders. */
export const SaleOrderInvoicing = extendModel('sale.order', {
  access: { 'account.user': ['read'] },
  fields: {
    invoices: f.one2many('account.move', 'saleOrder'),
    invoiceCount: f.integer({
      ...compute('sale.order', 'invoiceCount', ['invoices'], (orders) => {
        for (const o of orders) o.invoiceCount = o.invoices.length;
      }),
    }),
  },
  methods: {
    /** Draft invoices for confirmed orders, one per order, with the order's lines. Returns the invoice ids. */
    // Accountants may not read order lines in general; invoicing reads them for these orders only (audited).
    createInvoices: method(
      'sale.order',
      { elevate: ['sale.order.line:read'], reason: 'invoice confirmed orders' },
      async function (
        options: { readonly date?: string } = {},
      ): Promise<readonly Id<'account.move'>[]> {
        const orders = await this.load({
          lines: ['product', 'name', 'quantity', 'priceUnit', 'tax'],
        });
        const notConfirmed = orders.filter((o) => o.state !== 'sale');
        if (notConfirmed.length > 0)
          throw new Error(
            `Only confirmed orders can be invoiced (${notConfirmed.map((o) => o.name).join(', ')}).`,
          );
        const { env } = orders;
        const created = await env.model('account.move').create(
          orders.map((o) => ({
            partner: o.partner.id,
            currency: o.currency.id,
            company: o.company.id,
            saleOrder: o.id,
            date: options.date ?? env.today(),
            lines: {
              create: [...o.lines].map((l) => ({
                product: l.product.id,
                name: l.name,
                quantity: l.quantity,
                priceUnit: l.priceUnit,
                tax: l.tax === null ? null : l.tax.id,
              })),
            },
          })),
        );
        return created.ids;
      },
    ),
  },
});

export const invoice = defineModule({
  name: 'invoice',
  version: '1.0.0',
  depends: [sale],
  groups: [
    defineGroup({ code: 'account.user', label: 'Accountant', implies: ['base.user'] }),
    defineGroup({
      code: 'account.manager',
      label: 'Accounting manager',
      implies: ['account.user'],
    }),
  ],
  permissions: [
    definePermission({
      code: 'account.backdate',
      label: 'Back-dated invoices',
      groups: ['account.manager'],
    }),
  ],
  sequences: [
    defineSequence({
      code: 'account.move',
      prefix: 'INV/{year}/{month}/',
      padding: 4,
      reset: 'monthly',
      gapless: true,
    }),
  ],
  models: [AccountMove, AccountMoveLine],
  extensions: [SaleOrderInvoicing],
});
