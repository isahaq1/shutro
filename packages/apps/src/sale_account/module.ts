/**
 * sale_account (glue, installed with Sales and Accounting): invoicing from sales orders, and the invoice status of an
 * order.
 */
import type { Id } from '@shutro/core';
import { account } from '../account/module.js';
import { icons } from '../icons.js';
import { sale } from '../sale/module.js';
import { compute, defineModule, extendModel, f, method } from './.shutro/bindings.js';

export const AccountMoveSale = extendModel('account.move', {
  fields: { saleOrder: f.many2one('sale.order', { ondelete: 'set null' }) },
});

export const SaleOrderInvoicing = extendModel('sale.order', {
  access: { 'account.user': ['read'] },
  fields: {
    invoices: f.one2many('account.move', 'saleOrder'),
    invoiceCount: f.integer({
      ...compute('sale.order', 'invoiceCount', ['invoices'], (orders) => {
        for (const o of orders) o.invoiceCount = o.invoices.length;
      }),
    }),
    invoiceStatus: f.selection(
      { no: 'Nothing to invoice', to_invoice: 'To invoice', invoiced: 'Fully invoiced' },
      {
        ...compute('sale.order', 'invoiceStatus', ['state', 'invoices.state'], (orders) => {
          for (const o of orders) {
            const invoiced = o.invoices.filter((m) => m.state !== 'cancel').length > 0;
            o.invoiceStatus =
              o.state !== 'sale' && o.state !== 'done'
                ? 'no'
                : invoiced
                  ? 'invoiced'
                  : 'to_invoice';
          }
        }),
      },
    ),
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
        const notConfirmed = orders.filter((o) => o.state !== 'sale' && o.state !== 'done');
        if (!notConfirmed.isEmpty())
          throw new Error(
            `Only confirmed orders can be invoiced (${notConfirmed.map((o) => o.name).join(', ')}).`,
          );
        const { env } = orders;
        const journal = await env.refId('account.journal', 'account.journal_sale');
        const income = await env.refId('account.account', 'account.account_4000');
        const created = await env.model('account.move').create(
          orders.map((o) => ({
            moveType: 'out_invoice' as const,
            partner: o.partner.id,
            currency: o.currency.id,
            company: o.company.id,
            journal,
            saleOrder: o.id,
            origin: o.name,
            date: options.date ?? env.today(),
            lines: {
              create: [...o.lines].map((l) => ({
                product: l.product.id,
                name: l.name,
                account: income,
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

export const saleAccount = defineModule({
  name: 'sale_account',
  version: '1.0.0',
  label: 'Sales invoicing',
  autoInstall: true,
  icon: icons.link,
  glyph: '🔗',
  summary: 'Invoice confirmed sales orders',
  depends: [sale, account],
  models: [],
  extensions: [AccountMoveSale, SaleOrderInvoicing],
});
