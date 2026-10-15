/**
 * invoice: customer invoices with gapless legal numbering on posting, amounts in the invoice currency and in the
 * company currency (dated rates), and invoicing from sales orders (an extension of sale.order).
 */
import {
  defineGroup,
  defineModel,
  defineModule,
  defineSequence,
  type Env,
  extendModel,
  f,
  type Id,
  Money,
  toDecimal,
} from '@shutro/core';
import { type ComputeRecords, type Records, readId, readMoney } from '../../app/types.ts';
import { sale } from '../sale/module.ts';

const accounting = {
  'account.user': ['read', 'write', 'create'],
  'account.manager': ['read', 'write', 'create', 'unlink', 'export'],
} as const;

export const AccountMove = defineModel('account.move', {
  companyScoped: { required: true },
  order: ['date desc', 'id desc'],
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
    companyCurrency: f.many2one('res.currency', {
      store: true,
      depends: ['company.currency'],
      compute(records: unknown): void {
        for (const m of records as ComputeRecords<'account.move', { company: ['currency'] }>)
          m.companyCurrency = m.company.currency.id;
      },
    }),
    /** The total in the company currency at the invoice date's rate. */
    amountTotalCompany: f.monetary({
      currency: 'companyCurrency',
      store: true,
      depends: ['amountTotal', 'date', 'companyCurrency'],
      async compute(records: unknown): Promise<void> {
        const moves = records as ComputeRecords<'account.move'>;
        // One rate lookup per (date, currency pair), not per invoice.
        const groups = new Map<string, (typeof moves extends Iterable<infer R> ? R : never)[]>();
        for (const m of moves) {
          const key = `${m.date}|${m.currency.id}|${readId(m.companyCurrency)}`;
          groups.set(key, [...(groups.get(key) ?? []), m]);
        }
        for (const group of groups.values()) {
          const first = group[0];
          const total = readMoney(first?.amountTotal);
          const companyCurrency = readId(first?.companyCurrency);
          if (first === undefined || total === null || companyCurrency === null) continue;
          // PreparedRates.convert needs Currency objects; the target's comes from a one-off convert (docs/feedback.md #9).
          const target = (
            await moves.env.fx.convert(Money.zero(total.currency), companyCurrency, {
              date: first.date,
            })
          ).to;
          const rates = await moves.env.fx.prepare({
            date: first.date,
            currencies: [total.currency, target],
          });
          for (const m of group) {
            const amount = readMoney(m.amountTotal);
            m.amountTotalCompany = amount === null ? null : rates.convert(amount, target).money;
          }
        }
      },
    }),
    state: f.state({
      states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        post: {
          from: ['draft'],
          to: 'posted',
          guard(records: unknown): unknown {
            return (records as Records<'account.move'>).filter(
              (m) => m.amountTotal === null || m.amountTotal.isZero(),
            );
          },
          message: 'An invoice needs a non-zero total to be posted.',
          async before(records: unknown): Promise<void> {
            await (records as Records<'account.move'>).assignNumber('name'); // gapless, per month
          },
        },
        cancel: { from: ['draft', 'posted'], to: 'cancel' },
      },
    }),
  },
  methods: {
    computeAmounts(records: unknown): void {
      for (const m of records as ComputeRecords<
        'account.move',
        { lines: ['subtotal', 'taxAmount'] }
      >) {
        let untaxed = toDecimal(0);
        let tax = toDecimal(0);
        for (const l of m.lines) {
          untaxed = untaxed.plus(l.subtotal?.amount ?? 0);
          tax = tax.plus(l.taxAmount?.amount ?? 0);
        }
        m.amountUntaxed = untaxed;
        m.amountTax = tax;
        m.amountTotal = untaxed.plus(tax);
      }
    },
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
      depends: ['move.currency'],
      compute(records: unknown): void {
        for (const l of records as ComputeRecords<'account.move.line', { move: ['currency'] }>) {
          const move = l.move as typeof l.move | null; // drafts (docs/feedback.md #4)
          l.currency = move === null ? null : move.currency.id;
        }
      },
    }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['quantity', 'priceUnit'],
      compute(records: unknown): void {
        for (const l of records as ComputeRecords<'account.move.line'>)
          l.subtotal = l.quantity.times(l.priceUnit);
      },
    }),
    taxAmount: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['subtotal', 'tax.rate'],
      compute(records: unknown): void {
        for (const l of records as ComputeRecords<'account.move.line', { tax: ['rate'] }>)
          l.taxAmount = (readMoney(l.subtotal)?.amount ?? toDecimal(0)).times(l.tax?.rate ?? 0);
      },
    }),
  },
});

/** Invoicing from sales orders. */
export const SaleOrderInvoicing = extendModel('sale.order', {
  access: { 'account.user': ['read'] },
  fields: {
    invoices: f.one2many('account.move', 'saleOrder'),
    invoiceCount: f.integer({
      depends: ['invoices'],
      compute(records: unknown): void {
        for (const o of records as ComputeRecords<'sale.order', { invoices: true }>)
          o.invoiceCount = o.invoices.length;
      },
    }),
  },
  methods: {
    /** Draft invoices for confirmed orders, one per order, with the order's lines. Returns the invoice ids. */
    async createInvoices(
      this: unknown,
      options: { readonly date?: string } = {},
    ): Promise<readonly Id<'account.move'>[]> {
      const orders = await (this as Records<'sale.order'>).load({
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
          saleOrder: o.id as Id<'sale.order'>,
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
  },
});

/** Accountants read the order lines they invoice (each model a method touches needs a grant: docs/feedback.md #8). */
export const SaleOrderLineInvoicing = extendModel('sale.order.line', {
  access: { 'account.user': ['read'] },
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
  extensions: [SaleOrderInvoicing, SaleOrderLineInvoicing],
});
