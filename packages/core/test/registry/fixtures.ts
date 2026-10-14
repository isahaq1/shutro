import { type AnyModel, defineModel, defineModule, f, type Module } from '../../src/index.js';

/** The models every registry needs: the targets of the implicit fields. */
export function baseModels(): AnyModel[] {
  return [
    defineModel('res.users', { fields: { login: f.char({ required: true }) } }),
    defineModel('res.company', {
      fields: {
        name: f.char({ required: true }),
        currency: f.many2one('res.currency', { required: true }),
      },
    }),
    defineModel('res.currency', { fields: { name: f.char({ required: true }) } }),
    defineModel('res.partner', {
      archivable: true,
      companyScoped: { required: false },
      fields: {
        name: f.char({ required: true }),
        parent: f.many2one('res.partner'),
        children: f.one2many('res.partner', 'parent'),
      },
    }),
  ];
}

export function base(): Module {
  return defineModule({ name: 'base', models: baseModels() });
}

export function saleModule(deps: readonly Module[]): Module {
  return defineModule({
    name: 'sale',
    depends: deps,
    models: [
      defineModel('sale.order', {
        companyScoped: { required: true },
        fields: {
          name: f.char({ required: true }),
          partner: f.many2one('res.partner', { required: true }),
          currency: f.many2one('res.currency', { required: true }),
          lines: f.one2many('sale.order.line', 'order'),
          amountTotal: f.monetary({
            currency: 'currency',
            store: true,
            depends: ['lines.subtotal', 'partner.name'],
            compute: 'computeAmounts',
          }),
        },
        methods: { computeAmounts(): void {} },
      }),
      defineModel('sale.order.line', {
        fields: {
          order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
          currency: f.many2one('res.currency', { required: true }),
          subtotal: f.monetary({ currency: 'currency' }),
        },
      }),
    ],
  });
}
