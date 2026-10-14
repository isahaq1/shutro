/**
 * Correctness checks for the `full` variant (criterion C5). Compile-only: `tsc` fails if any assertion is wrong.
 */
import type { DefaultLoaded, Env, IdOnly, PendingSet, RecordSet } from './full.ts';
import type { CalendarDate, Decimal, Id, Many2one, NotLoaded, Scalar, X2many } from './schema.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assert<T extends true>(): T | undefined {
  return undefined;
}

export interface Erp {
  'res.partner': {
    fields: {
      name: Scalar<string, true>;
      vat: Scalar<string>;
      country: Many2one<'res.country'>;
      parent: Many2one<'res.partner'>;
    };
    defaults: 'name' | 'vat' | 'country' | 'parent';
  };
  'res.country': {
    fields: { code: Scalar<string, true>; name: Scalar<string, true> };
    defaults: 'code' | 'name';
  };
  'product.product': {
    fields: {
      name: Scalar<string, true>;
      listPrice: Scalar<Decimal, true>;
      image: Scalar<Uint8Array>;
    };
    defaults: 'name' | 'listPrice'; // binary is not prefetched
  };
  'sale.order': {
    fields: {
      name: Scalar<string, true>;
      validityDate: Scalar<CalendarDate>;
      partner: Many2one<'res.partner', true>;
      lines: X2many<'sale.order.line'>;
    };
    defaults: 'name' | 'validityDate' | 'partner';
  };
  'sale.order.line': {
    fields: {
      order: Many2one<'sale.order', true>;
      product: Many2one<'product.product'>;
      quantity: Scalar<Decimal, true>;
    };
    defaults: 'order' | 'product' | 'quantity';
  };
}

export async function checks(env: Env<Erp>): Promise<void> {
  const orders = await env.model('sale.order').search();
  const o = orders.first();

  // Defaults are loaded.
  assert<Equal<typeof o.name, string>>();
  assert<Equal<typeof o.validityDate, CalendarDate | null>>();
  // A many2one that is not loaded exposes only its id.
  assert<Equal<typeof o.partner, IdOnly<'res.partner'>>>();
  assert<Equal<typeof o.partner.id, Id<'res.partner'>>>();
  // An x2many that is not loaded is pending.
  assert<Equal<typeof o.lines, PendingSet<Erp, 'sale.order.line'>>>();

  // Nested load: a scalar list on one relation, a nested spec on another.
  const l1 = await orders.load({ partner: ['name'], lines: { product: true } });
  const o1 = l1.first();
  assert<Equal<typeof o1.partner.name, string>>();
  assert<Equal<typeof o1.partner.vat, NotLoaded<'res.partner', 'vat'>>>();
  for (const line of o1.lines) {
    assert<Equal<typeof line.quantity, Decimal>>(); // line defaults
    const p = line.product;
    if (p !== null) {
      assert<Equal<typeof p.listPrice, Decimal>>();
      assert<Equal<typeof p.image, NotLoaded<'product.product', 'image'>>>(); // not a default
    }
  }

  // Successive loads merge, including at depth 3.
  const l2 = await l1.load({ partner: { country: ['code'] } });
  const p2 = l2.first().partner;
  assert<Equal<typeof p2.name, string>>(); // kept from l1
  const c = p2.country;
  if (c !== null) {
    assert<Equal<typeof c.code, string>>();
    assert<Equal<typeof c.name, NotLoaded<'res.country', 'name'>>>();
  }

  // Using a value that is not loaded is a compile error.
  // @ts-expect-error vat was not loaded
  const vat: string | null = o1.partner.vat;
  // @ts-expect-error unknown field in a load spec
  await orders.load({ partnr: true });
  // @ts-expect-error unknown scalar in a nested list
  await orders.load({ partner: ['nam'] });
  // @ts-expect-error x2many is not iterable before loading
  for (const _ of o.lines) {
    // unreachable
  }
  // @ts-expect-error scalar fields can't be load-spec keys
  await orders.load({ name: true });

  // Pending x2many can be loaded on its own.
  const lines: RecordSet<
    Erp,
    'sale.order.line',
    DefaultLoaded<Erp, 'sale.order.line'>
  > = await o.lines.load({});
  void lines;
  void vat;
}
