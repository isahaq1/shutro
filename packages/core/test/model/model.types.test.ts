/**
 * RFC 0001 §8: checks that need the sibling fields, verified by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import {
  type CreateOf,
  defineModel,
  f,
  type Id,
  type Money,
  type ReadOf,
} from '../../src/index.js';

const Order = defineModel('sale.order', {
  archivable: true,
  companyScoped: { required: true },
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    currency: f.many2one('res.currency', { required: true }),
    amountTotal: f.monetary({ currency: 'currency', compute: 'computeAmounts', store: true }),
  },
  methods: { computeAmounts(): void {} },
});

test('the model type carries the merged fields and names', () => {
  expectTypeOf(Order.name).toEqualTypeOf<'sale.order'>();
  type R = ReadOf<typeof Order.fields>;
  expectTypeOf<R['id']>().toEqualTypeOf<Id<'sale.order'>>();
  expectTypeOf<R['createdAt']>().toEqualTypeOf<Date>();
  expectTypeOf<R['createdBy']>().toEqualTypeOf<{ readonly id: Id<'res.users'> } | null>();
  expectTypeOf<R['displayName']>().toEqualTypeOf<string>();
  expectTypeOf<R['active']>().toEqualTypeOf<boolean>();
  expectTypeOf<R['company']>().toEqualTypeOf<{ readonly id: Id<'res.company'> }>();
  expectTypeOf<R['amountTotal']>().toEqualTypeOf<Money | null>();
  type C = CreateOf<typeof Order.fields>;
  expectTypeOf<C>().not.toHaveProperty('id');
  expectTypeOf<C>().not.toHaveProperty('createdAt');
  expectTypeOf<C['company']>().toEqualTypeOf<Id<'res.company'> | undefined>(); // required, but defaults to env.company
  expectTypeOf<C['active']>().toEqualTypeOf<boolean | undefined>();
});

test('without the opt-ins, active and company do not exist', () => {
  const Plain = defineModel('x.y', { fields: { code: f.char() } });
  type R = ReadOf<typeof Plain.fields>;
  expectTypeOf<R>().not.toHaveProperty('active');
  expectTypeOf<R>().not.toHaveProperty('company');
  expectTypeOf<R['code']>().toEqualTypeOf<string | null>();
});

test('sibling checks are compile errors', () => {
  const misuse = (): void => {
    defineModel('x.y', {
      fields: {
        // @ts-expect-error 'currnecy' is not a many2one('res.currency') field of this model
        amount: f.monetary({ currency: 'currnecy' }),
        currency: f.many2one('res.currency'),
      },
    });
    defineModel('x.y', {
      fields: {
        // @ts-expect-error 'partner' is many2one('res.partner'), expected many2one('res.currency')
        amount: f.monetary({ currency: 'partner' }),
        partner: f.many2one('res.partner'),
      },
    });
    defineModel('x.y', {
      fields: {
        // @ts-expect-error 'uom' must be a many2one('uom.uom')
        qty: f.quantity({ uom: 'partner' }),
        partner: f.many2one('res.partner'),
      },
    });
    defineModel('x.y', {
      // @ts-expect-error 'computeB' is not a method
      fields: { a: f.char({ compute: 'computeB' }) },
      methods: { computeA(): void {} },
    });
    // @ts-expect-error 'id' is a reserved field name
    defineModel('x.y', { fields: { id: f.char() } });
    // @ts-expect-error recName must be a field
    defineModel('x.y', { recName: 'nope', fields: { code: f.char() } });
    // @ts-expect-error order entries name fields with an optional direction
    defineModel('x.y', { order: ['code sideways'], fields: { code: f.char() } });
    // @ts-expect-error tracking entries name fields
    defineModel('x.y', { tracking: ['nope'], fields: { code: f.char() } });
    // @ts-expect-error unknown model option
    defineModel('x.y', { lable: 'X', fields: {} });
  };
  expectTypeOf(misuse).toBeFunction();
});
