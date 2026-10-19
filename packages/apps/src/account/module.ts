/**
 * Accounting (app): chart of accounts, journals, payment terms, customer invoices and vendor bills with gapless legal
 * numbering per kind, amounts in the document and the company currency (dated rates), and payments with a computed
 * payment status.
 *
 * v1 covers invoicing and payments (RFC 0019 §11.2). The double-entry ledger, reconciliation and reports get their own
 * RFCs.
 */
import { defineGroup, definePermission, defineSequence, type Id, toDecimal } from '@shutro/core';
import { sql } from '@shutro/sql';
import { icons } from '../icons.js';
import { partner } from '../partner/module.js';
import { product } from '../product/module.js';
import {
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  record,
  records,
  ref,
} from './.shutro/bindings.js';

const user = ['read', 'write', 'create'] as const;
const manage = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;
const accounting = { 'account.user': user, 'account.manager': manage } as const;
const masterData = { 'base.user': ['read'], 'account.manager': manage } as const;

/** `date` plus `days`, as `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const AccountAccount = defineModel('account.account', {
  archivable: true,
  access: masterData,
  order: ['code'],
  fields: {
    code: f.char({ required: true, size: 16, index: 'unique' }),
    name: f.char({ required: true, translate: true }),
    accountType: f.selection(
      {
        asset_receivable: 'Receivable',
        asset_cash: 'Bank and cash',
        asset_current: 'Current assets',
        asset_fixed: 'Fixed assets',
        liability_payable: 'Payable',
        liability_current: 'Current liabilities',
        equity: 'Equity',
        income: 'Income',
        expense: 'Expenses',
      },
      { required: true },
    ),
  },
});

export const AccountJournal = defineModel('account.journal', {
  archivable: true,
  access: masterData,
  order: ['code'],
  fields: {
    name: f.char({ required: true, translate: true }),
    code: f.char({ required: true, size: 8, index: 'unique' }),
    journalType: f.selection(
      {
        sale: 'Sales',
        purchase: 'Purchases',
        bank: 'Bank',
        cash: 'Cash',
        general: 'Miscellaneous',
      },
      { required: true },
    ),
    defaultAccount: f.many2one('account.account'),
  },
});

export const AccountPaymentTerm = defineModel('account.payment.term', {
  archivable: true,
  access: masterData,
  order: ['days'],
  fields: {
    name: f.char({ required: true, translate: true }),
    /** Days from the document date to the due date. */
    days: f.integer({ required: true, default: 0 }),
  },
  sqlConstraints: {
    daysPositive: { check: sql`days >= 0`, message: 'Payment terms count days forward.' },
  },
});

/** The three totals share one compute (computed together). */
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

/** Paid and residual amounts, and the payment status, from the posted payments. */
const paid = compute(
  'account.move',
  ['amountPaid', 'amountResidual', 'paymentState'],
  ['lines.subtotal', 'lines.taxAmount', 'state', 'payments.amount', 'payments.state'],
  (moves) => {
    for (const m of moves) {
      const amountPaid = m.payments.filter((p) => p.state === 'posted').sum('amount', m.currency);
      const total = m.lines.sum('subtotal', m.currency).plus(m.lines.sum('taxAmount', m.currency));
      const residual = total.minus(amountPaid);
      m.amountPaid = amountPaid;
      m.amountResidual = residual;
      m.paymentState =
        m.state !== 'posted'
          ? 'not_paid'
          : !residual.isPositive()
            ? 'paid'
            : amountPaid.isZero()
              ? 'not_paid'
              : 'partial';
    }
  },
);

export const AccountMove = defineModel('account.move', {
  companyScoped: { required: true },
  order: ['date desc', 'id desc'],
  // Documents dated before today need 'account.backdate' (accounting managers, a special grant, or administrators).
  backdate: { field: 'date', permission: 'account.backdate' },
  tracking: ['partner', 'amountTotal', 'state'],
  access: accounting,
  fields: {
    moveType: f.selection(
      { out_invoice: 'Customer invoice', in_invoice: 'Vendor bill' },
      { required: true, default: 'out_invoice' },
    ),
    /** Customer invoice number: gapless per month, assigned when posted. */
    invoiceNumber: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'account.invoice', on: 'manual', dateField: 'date' },
    }),
    /** Vendor bill number: gapless per month, assigned when posted. */
    billNumber: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'account.bill', on: 'manual', dateField: 'date' },
    }),
    /** The document number: the invoice or bill number. */
    name: f.char({
      store: true,
      ...compute('account.move', 'name', ['moveType', 'invoiceNumber', 'billNumber'], (moves) => {
        for (const m of moves)
          m.name = m.moveType === 'in_invoice' ? m.billNumber : m.invoiceNumber;
      }),
    }),
    /** The vendor's own reference on a bill, or the customer's on an invoice. */
    reference: f.char(),
    /** Where the document comes from (an order number). */
    origin: f.char(),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    paymentTerm: f.many2one('account.payment.term'),
    dueDate: f.date({
      store: true,
      ...compute('account.move', 'dueDate', ['date', 'paymentTerm.days'], (moves) => {
        for (const m of moves) m.dueDate = addDays(m.date, m.paymentTerm?.days ?? 0);
      }),
    }),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    journal: f.many2one('account.journal'),
    currency: f.many2one('res.currency', { required: true }),
    lines: f.one2many('account.move.line', 'move'),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTax: f.monetary({ currency: 'currency', store: true, ...amounts }),
    amountTotal: f.monetary({ currency: 'currency', store: true, ...amounts }),
    payments: f.one2many('account.payment', 'move'),
    amountPaid: f.monetary({ currency: 'currency', store: true, ...paid }),
    amountResidual: f.monetary({ currency: 'currency', store: true, ...paid }),
    paymentState: f.selection(
      { not_paid: 'Not paid', partial: 'Partially paid', paid: 'Paid' },
      { store: true, ...paid },
    ),
    companyCurrency: f.many2one('res.currency', {
      store: true,
      ...compute('account.move', 'companyCurrency', ['company.currency'], (moves) => {
        for (const m of moves) m.companyCurrency = m.company.currency.id;
      }),
    }),
    /** The total in the company currency at the document date's rate. */
    amountTotalCompany: f.monetary({
      currency: 'companyCurrency',
      store: true,
      ...compute(
        'account.move',
        'amountTotalCompany',
        ['amountTotal', 'date', 'company.currency'],
        async (moves) => {
          // One rate lookup per (date, company), not per document.
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
          message: 'A document needs a non-zero total to be posted.',
          // Gapless, per month and per kind: numbered inside the posting transaction.
          before: records('account.move', async (moves) => {
            await moves.filter((m) => m.moveType === 'out_invoice').assignNumber('invoiceNumber');
            await moves.filter((m) => m.moveType === 'in_invoice').assignNumber('billNumber');
          }),
        },
        cancel: {
          from: ['draft', 'posted'],
          to: 'cancel',
          guard: records('account.move', async (moves) => {
            const loaded = await moves.load({ payments: ['state'] });
            return loaded.filter((m) => m.payments.filter((p) => p.state === 'posted').length > 0);
          }),
          message: 'Cancel the posted payments of this document first.',
        },
        redraft: { from: ['cancel'], to: 'draft' },
      },
      extensible: true,
    }),
  },
  methods: {
    /**
     * Pays posted documents in full (or `amount` each): one posted payment per document, in its currency. Returns the
     * payment ids.
     */
    registerPayment: method(
      'account.move',
      async function (
        options: { readonly journal?: Id<'account.journal'>; readonly date?: string } = {},
      ): Promise<readonly Id<'account.payment'>[]> {
        const moves = await this.load();
        const unposted = moves.filter((m) => m.state !== 'posted');
        if (!unposted.isEmpty())
          throw new Error(
            `Post the documents before registering payments (${unposted.map((m) => m.id).join(', ')}).`,
          );
        const { env } = moves;
        const journal =
          options.journal ?? (await env.refId('account.journal', 'account.journal_bank'));
        const payments = await env.model('account.payment').create(
          moves
            .filter((m) => m.amountResidual?.isPositive() === true)
            .map((m) => ({
              move: m.id,
              partner: m.partner.id,
              company: m.company.id,
              currency: m.currency.id,
              journal,
              paymentType:
                m.moveType === 'in_invoice' ? ('outbound' as const) : ('inbound' as const),
              amount: m.amountResidual?.toDecimal() ?? toDecimal(0),
              date: options.date ?? env.today(),
            })),
        );
        await payments.post();
        return payments.ids;
      },
    ),
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
    account: f.many2one('account.account'),
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

export const AccountPayment = defineModel('account.payment', {
  companyScoped: { required: true },
  order: ['date desc', 'id desc'],
  tracking: ['amount', 'state'],
  access: accounting,
  fields: {
    name: f.char({
      required: true,
      readonly: true,
      sequence: { code: 'account.payment', dateField: 'date' },
    }),
    paymentType: f.selection(
      { inbound: 'Receive money', outbound: 'Send money' },
      { required: true, default: 'inbound' },
    ),
    partner: f.many2one('res.partner', { required: true, checkCompany: true }),
    move: f.many2one('account.move', { ondelete: 'restrict' }),
    journal: f.many2one('account.journal', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    amount: f.monetary({ currency: 'currency', required: true }),
    date: f.date({ required: true, default: (env: Env) => env.today() }),
    memo: f.char(),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          guard: records('account.payment', (payments) =>
            payments.filter((p) => p.amount === null || !p.amount.isPositive()),
          ),
          message: 'A payment amount must be positive.',
        },
        cancel: { from: ['draft', 'posted'], to: 'cancel' },
      },
    }),
  },
});

const ledgerAccount = (code: string, name: string, accountType: string) =>
  record('account.account', `account_${code}`, { code, name, accountType: accountType as never });

export const account = defineModule({
  name: 'account',
  version: '1.0.0',
  label: 'Accounting',
  application: true,
  icon: icons.account,
  glyph: '📒',
  category: 'Accounting',
  summary: 'Invoices, vendor bills, payments, chart of accounts and journals',
  depends: [partner, product],
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
      label: 'Back-dated documents',
      groups: ['account.manager'],
    }),
  ],
  sequences: [
    defineSequence({
      code: 'account.invoice',
      prefix: 'INV/{year}/{month}/',
      padding: 4,
      reset: 'monthly',
      gapless: true,
    }),
    defineSequence({
      code: 'account.bill',
      prefix: 'BILL/{year}/{month}/',
      padding: 4,
      reset: 'monthly',
      gapless: true,
    }),
    defineSequence({ code: 'account.payment', prefix: 'PAY/{year}/', padding: 5, reset: 'yearly' }),
  ],
  models: [
    AccountAccount,
    AccountJournal,
    AccountPaymentTerm,
    AccountMove,
    AccountMoveLine,
    AccountPayment,
  ],
  // A generic chart of accounts (RFC 0019 §11.5); country localizations come as their own modules.
  data: [
    ledgerAccount('1100', 'Accounts receivable', 'asset_receivable'),
    ledgerAccount('1200', 'Bank', 'asset_cash'),
    ledgerAccount('1210', 'Cash', 'asset_cash'),
    ledgerAccount('1300', 'Inventory', 'asset_current'),
    ledgerAccount('1500', 'Fixed assets', 'asset_fixed'),
    ledgerAccount('2100', 'Accounts payable', 'liability_payable'),
    ledgerAccount('2200', 'Tax payable', 'liability_current'),
    ledgerAccount('3000', 'Owner equity', 'equity'),
    ledgerAccount('4000', 'Sales revenue', 'income'),
    ledgerAccount('4100', 'Service revenue', 'income'),
    ledgerAccount('5000', 'Cost of goods sold', 'expense'),
    ledgerAccount('6000', 'Operating expenses', 'expense'),
    record('account.journal', 'journal_sale', {
      name: 'Customer invoices',
      code: 'INV',
      journalType: 'sale',
      defaultAccount: ref('account.account', 'account.account_4000'),
    }),
    record('account.journal', 'journal_purchase', {
      name: 'Vendor bills',
      code: 'BILL',
      journalType: 'purchase',
      defaultAccount: ref('account.account', 'account.account_6000'),
    }),
    record('account.journal', 'journal_bank', {
      name: 'Bank',
      code: 'BNK',
      journalType: 'bank',
      defaultAccount: ref('account.account', 'account.account_1200'),
    }),
    record('account.journal', 'journal_cash', {
      name: 'Cash',
      code: 'CSH',
      journalType: 'cash',
      defaultAccount: ref('account.account', 'account.account_1210'),
    }),
    record('account.journal', 'journal_general', {
      name: 'Miscellaneous',
      code: 'MISC',
      journalType: 'general',
    }),
    record('account.payment.term', 'term_immediate', { name: 'Immediate payment', days: 0 }),
    record('account.payment.term', 'term_15', { name: '15 days', days: 15 }),
    record('account.payment.term', 'term_30', { name: '30 days', days: 30 }),
  ],
});
