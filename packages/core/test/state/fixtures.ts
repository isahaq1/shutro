/**
 * A sale order workflow for the state-machine tests (RFC 0010): guard, state and transition events, a constraint
 * depending on the state, and a module that wraps `confirm` and adds a `hold` state with its transitions.
 */
import {
  buildRegistry,
  type DefaultLoaded,
  defineModel,
  defineModule,
  extendModel,
  f,
  type RecordSet,
} from '../../src/index.js';

export const log: string[] = [];

export const Users = defineModel('res.users', { fields: { login: f.char({ required: true }) } });
export const Currency = defineModel('res.currency', {
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
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

type Orders = RecordSet<S, 'sale.order', DefaultLoaded<S, 'sale.order'>>;

export const SaleOrderLine = defineModel('sale.order.line', {
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true }),
  },
});

export const SaleOrder = defineModel('sale.order', {
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    note: f.text(),
    lines: f.one2many('sale.order.line', 'order'),
    state: f.state({
      states: {
        draft: {
          label: 'Quotation',
          onExit(records: unknown): void {
            log.push(`exit draft ${(records as Orders).length}`);
          },
        },
        sent: 'Quotation sent',
        sale: {
          label: 'Sales Order',
          async onEnter(records: unknown): Promise<void> {
            log.push(`enter sale ${(records as Orders).length}`);
          },
        },
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        send: { from: ['draft'], to: 'sent' },
        confirm: {
          from: ['draft', 'sent'],
          to: 'sale',
          async guard(records: unknown): Promise<unknown> {
            const loaded = await (records as Orders).load({ lines: true });
            log.push(`guard confirm ${loaded.length}`);
            return loaded.filter((o) => o.lines.length === 0);
          },
          message: 'Add at least one line before confirming.',
          before(records: unknown): void {
            log.push(`before confirm ${(records as Orders).length}`);
          },
          after(records: unknown): void {
            log.push(`after confirm ${(records as Orders).length}`);
          },
        },
        cancel: { from: ['draft', 'sent', 'sale'], to: 'cancel' },
      },
      extensible: true,
    }),
  },
  constraints: {
    cancelReason: {
      depends: ['state', 'note'],
      check(records: unknown): unknown {
        return (records as Orders).filter((o) => o.state === 'cancel' && o.note === null);
      },
      message: 'A cancelled order needs a note explaining why.',
    },
  },
  methods: {
    async markSent(this: unknown): Promise<void> {
      await (this as Orders).send();
    },
  },
});

export const sale = defineModule({
  name: 'sale',
  depends: [base],
  models: [SaleOrderLine, SaleOrder],
});

/** Wraps `confirm`, adds a `hold` state and its transitions (RFC 0010 §7.4). */
export const SaleOrderHold = extendModel('sale.order', {
  fieldOverrides: {
    state: {
      statesAdd: { hold: 'On hold' },
      transitionsAdd: {
        hold: { from: ['sale'], to: 'hold' },
        resume: { from: ['hold'], to: 'sale' },
      },
    },
  },
  overrides: {
    async confirm(this: unknown, next: () => Promise<void>): Promise<void> {
      await next();
      await (this as Orders).write({ note: 'confirmed by sale_hold' });
    },
  },
});
export const saleHold = defineModule({
  name: 'sale_hold',
  depends: [sale],
  models: [],
  extensions: [SaleOrderHold],
});

export const registry = buildRegistry({ modules: [saleHold], security: { enforce: false } });
export type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;
