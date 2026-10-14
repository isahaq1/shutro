/**
 * RFC 0001 §7.3 / §8: field faces and local type checks, verified by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import {
  type CreateOf,
  type Decimal,
  type Env,
  f,
  type Id,
  type Money,
  type Quantity,
  type ReadOf,
  type WriteOf,
  type X2ManyCommands,
} from '../../src/index.js';

const fields = {
  name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),
  note: f.text(),
  active: f.boolean(),
  priority: f.integer({ default: 1 }),
  big: f.bigint(),
  ratio: f.float(),
  discount: f.decimal({ scale: 2, default: '0' }),
  partner: f.many2one('res.partner', { required: true }),
  currency: f.many2one('res.currency', {
    required: true,
    default: (env: Env) => env.companyId as Id<'res.currency'>,
  }),
  lines: f.one2many('sale.order.line', 'order'),
  tags: f.many2many('sale.tag'),
  amountTotal: f.monetary({
    currency: 'currency',
    store: true,
    depends: ['lines.subtotal'],
    compute: 'computeAmounts',
  }),
  weight: f.quantity({ uom: 'weightUom' }),
  validityDate: f.date(),
  dateOrder: f.datetime({ required: true }),
  type: f.selection({ consu: 'Goods', service: 'Service' }, { required: true, default: 'consu' }),
  lang: f.selection(() => ['en_US', 'bn_BD']),
  state: f.state({
    states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' },
    initial: 'draft',
    transitions: {
      confirm: { from: ['draft'], to: 'sale' },
      cancel: { from: ['draft', 'sale'], to: 'cancel' },
    },
  }),
  meta: f.json<{ readonly tags: readonly string[] }>(),
  image: f.binary(),
  displayName: f.char({ compute: () => undefined, inverse: () => undefined }),
};

type R = ReadOf<typeof fields>;
type C = CreateOf<typeof fields>;
type W = WriteOf<typeof fields>;

test('read faces', () => {
  expectTypeOf<R['name']>().toEqualTypeOf<string>();
  expectTypeOf<R['note']>().toEqualTypeOf<string | null>();
  expectTypeOf<R['active']>().toEqualTypeOf<boolean>(); // never null
  expectTypeOf<R['priority']>().toEqualTypeOf<number | null>(); // a default does not make it non-null
  expectTypeOf<R['big']>().toEqualTypeOf<number | null>(); // bigint columns read as safe numbers (driver guard)
  expectTypeOf<R['ratio']>().toEqualTypeOf<number | null>();
  expectTypeOf<R['discount']>().toEqualTypeOf<Decimal | null>();
  expectTypeOf<R['partner']>().toEqualTypeOf<{ readonly id: Id<'res.partner'> }>();
  expectTypeOf<R['lines']>().toEqualTypeOf<{ readonly model: 'sale.order.line' }>();
  expectTypeOf<R['amountTotal']>().toEqualTypeOf<Money | null>();
  expectTypeOf<R['weight']>().toEqualTypeOf<Quantity | null>();
  expectTypeOf<R['validityDate']>().toEqualTypeOf<string | null>(); // 'YYYY-MM-DD' until CalendarDate exists
  expectTypeOf<R['dateOrder']>().toEqualTypeOf<Date>();
  expectTypeOf<R['type']>().toEqualTypeOf<'consu' | 'service'>();
  expectTypeOf<R['lang']>().toEqualTypeOf<string | null>();
  expectTypeOf<R['state']>().toEqualTypeOf<'draft' | 'sale' | 'cancel'>();
  expectTypeOf<R['meta']>().toEqualTypeOf<{ readonly tags: readonly string[] } | null>();
  expectTypeOf<R['image']>().toEqualTypeOf<Uint8Array | null>();
});

test('create faces', () => {
  expectTypeOf<C>().toHaveProperty('partner'); // required, no default → mandatory
  expectTypeOf<C['partner']>().toEqualTypeOf<Id<'res.partner'>>();
  expectTypeOf<C>().toHaveProperty('dateOrder');
  expectTypeOf<C>().not.toHaveProperty('amountTotal'); // computed
  expectTypeOf<C>().not.toHaveProperty('name'); // readonly + sequence
  expectTypeOf<C>().not.toHaveProperty('state'); // only via transitions
  expectTypeOf<C['currency']>().toEqualTypeOf<Id<'res.currency'> | undefined>(); // has a default → optional
  expectTypeOf<C['active']>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<C['note']>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<C['discount']>().toEqualTypeOf<Decimal | string | null | undefined>();
  expectTypeOf<C['big']>().toEqualTypeOf<bigint | number | null | undefined>();
  expectTypeOf<C['lines']>().toEqualTypeOf<X2ManyCommands<'sale.order.line'> | undefined>();
  expectTypeOf<C['type']>().toEqualTypeOf<'consu' | 'service' | undefined>();
  expectTypeOf<C['displayName']>().toEqualTypeOf<string | null | undefined>(); // computed with inverse → writable
  const ok: C = { partner: 1 as Id<'res.partner'>, dateOrder: new Date() };
  void ok;
  // @ts-expect-error partner is mandatory
  const missing: C = { dateOrder: new Date() };
  void missing;
  // @ts-expect-error plain numbers are not partner ids
  const wrongId: C = { partner: 1, dateOrder: new Date() };
  void wrongId;
  // @ts-expect-error binary floats can't be sent for decimals
  const float: C = { partner: 1 as Id<'res.partner'>, dateOrder: new Date(), discount: 0.1 };
  void float;
});

test('write faces', () => {
  expectTypeOf<W>().not.toHaveProperty('state');
  expectTypeOf<W>().not.toHaveProperty('amountTotal');
  expectTypeOf<W>().not.toHaveProperty('name');
  expectTypeOf<W['note']>().toEqualTypeOf<string | null | undefined>();
  expectTypeOf<W['partner']>().toEqualTypeOf<Id<'res.partner'> | undefined>(); // required → never null
  expectTypeOf<W['tags']>().toEqualTypeOf<X2ManyCommands<'sale.tag'> | undefined>();
  const ok: W = {};
  void ok;
});

test('local checks on builders', () => {
  const misuse = (): void => {
    // @ts-expect-error unknown option
    f.char({ requird: true });
    // @ts-expect-error default must match the value type
    f.integer({ default: 'one' });
    // @ts-expect-error selection default must be a key
    f.selection({ a: 'A', b: 'B' }, { default: 'c' });
    f.state({
      states: { draft: 'D', sale: 'S' },
      // @ts-expect-error unknown initial state
      initial: 'drafr',
      transitions: {},
    });
    f.state({
      states: { draft: 'D', sale: 'S' },
      initial: 'draft',
      // @ts-expect-error unknown state in a transition
      transitions: { confirm: { from: ['dratf'], to: 'sale' } },
    });
    // @ts-expect-error many2one with ondelete 'set null' can't be required
    f.many2one('res.partner', { required: true, ondelete: 'set null' });
    // @ts-expect-error relations can't be stored
    f.one2many('a.b', 'c', { store: true });
    // @ts-expect-error depends needs a compute
    f.char({ depends: ['x'] });
    // @ts-expect-error ids are branded per model
    const id: Id<'res.partner'> = 1 as Id<'product.product'>;
    void id;
  };
  expectTypeOf(misuse).toBeFunction();
});
