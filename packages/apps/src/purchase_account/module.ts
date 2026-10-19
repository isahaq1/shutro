/**
 * purchase_account (glue, installed with Purchase and Accounting): vendor bills from purchase orders, and the billing
 * status of an order.
 */
import type { Id } from '@shutro/core';
import { account } from '../account/module.js';
import { icons } from '../icons.js';
import { purchase } from '../purchase/module.js';
import { compute, defineModule, extendModel, f, method } from './.shutro/bindings.js';

export const AccountMovePurchase = extendModel('account.move', {
  fields: { purchaseOrder: f.many2one('purchase.order', { ondelete: 'set null' }) },
});

export const PurchaseOrderBilling = extendModel('purchase.order', {
  access: { 'account.user': ['read'] },
  fields: {
    bills: f.one2many('account.move', 'purchaseOrder'),
    billCount: f.integer({
      ...compute('purchase.order', 'billCount', ['bills'], (orders) => {
        for (const o of orders) o.billCount = o.bills.length;
      }),
    }),
    billStatus: f.selection(
      { no: 'Nothing to bill', to_bill: 'Waiting bills', billed: 'Fully billed' },
      {
        ...compute('purchase.order', 'billStatus', ['state', 'bills.state'], (orders) => {
          for (const o of orders) {
            const billed = o.bills.filter((m) => m.state !== 'cancel').length > 0;
            o.billStatus =
              o.state !== 'purchase' && o.state !== 'done' ? 'no' : billed ? 'billed' : 'to_bill';
          }
        }),
      },
    ),
  },
  methods: {
    /** Draft vendor bills for confirmed orders, one per order, with the order's lines. Returns the bill ids. */
    createBills: method(
      'purchase.order',
      { elevate: ['purchase.order.line:read'], reason: 'bill confirmed purchase orders' },
      async function (
        options: { readonly date?: string } = {},
      ): Promise<readonly Id<'account.move'>[]> {
        const orders = await this.load({
          lines: ['product', 'name', 'quantity', 'priceUnit', 'tax'],
        });
        const notConfirmed = orders.filter((o) => o.state !== 'purchase' && o.state !== 'done');
        if (!notConfirmed.isEmpty())
          throw new Error(
            `Only confirmed purchase orders can be billed (${notConfirmed.map((o) => o.name).join(', ')}).`,
          );
        const { env } = orders;
        const journal = await env.refId('account.journal', 'account.journal_purchase');
        const expense = await env.refId('account.account', 'account.account_6000');
        const created = await env.model('account.move').create(
          orders.map((o) => ({
            moveType: 'in_invoice' as const,
            partner: o.partner.id,
            currency: o.currency.id,
            company: o.company.id,
            journal,
            purchaseOrder: o.id,
            origin: o.name,
            reference: o.partnerReference,
            date: options.date ?? env.today(),
            lines: {
              create: [...o.lines].map((l) => ({
                product: l.product.id,
                name: l.name,
                account: expense,
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

export const purchaseAccount = defineModule({
  name: 'purchase_account',
  version: '1.0.0',
  label: 'Purchase billing',
  autoInstall: true,
  icon: icons.link,
  glyph: '🔗',
  summary: 'Vendor bills from purchase orders',
  depends: [purchase, account],
  models: [],
  extensions: [AccountMovePurchase, PurchaseOrderBilling],
});
