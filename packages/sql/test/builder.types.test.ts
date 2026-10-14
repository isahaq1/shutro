/**
 * Type-level guarantees of the query builder, checked by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import { createQueryBuilder, type RowOf } from '../src/index.js';

interface Db {
  sale_order: {
    id: number;
    name: string;
    state: string;
    partner_id: number;
    amount_total: string;
    date_order: Date | null;
  };
  res_partner: { id: number; name: string; country_id: number | null };
}
const qb = createQueryBuilder<Db>();

test('selected columns and aliases shape the row type', () => {
  const q = qb
    .selectFrom('sale_order as so')
    .innerJoin('res_partner as p', 'p.id', 'so.partner_id')
    .select(['so.id', 'so.name as reference', 'p.country_id', 'state'])
    .select((eb) => [
      eb.fn.count().as('n'),
      eb.fn.sum('so.amount_total').as('total'),
      eb.fn.max('so.date_order').as('last'),
    ]);
  type R = RowOf<typeof q>;
  expectTypeOf<R>().toEqualTypeOf<{
    id: number;
    reference: string;
    country_id: number | null;
    state: string;
    n: number;
    total: string | null;
    last: Date | null;
  }>();
});

test('selectAll gives the table row; a CTE becomes a typed table', () => {
  expectTypeOf<
    RowOf<ReturnType<ReturnType<typeof qb.selectFrom<'res_partner'>>['selectAll']>>
  >().toEqualTypeOf<Db['res_partner']>();
  const q = qb
    .with('open', (q) => q.selectFrom('sale_order').select(['id', 'partner_id']))
    .selectFrom('open')
    .select(['open.partner_id']);
  expectTypeOf<RowOf<typeof q>>().toEqualTypeOf<{ partner_id: number }>();
});

test('returning shapes insert/update/delete rows; values are typed per column', () => {
  const ins = qb
    .insertInto('res_partner')
    .values([{ name: 'x' }])
    .returning(['id']);
  expectTypeOf<RowOf<typeof ins>>().toEqualTypeOf<{ id: number }>();
  const upd = qb.updateTable('sale_order').set({ state: 'sale' }).returning(['id', 'name']);
  expectTypeOf<RowOf<typeof upd>>().toEqualTypeOf<{ id: number; name: string }>();
});

test('misuse is a compile error', () => {
  const misuse = (): void => {
    // @ts-expect-error unknown table
    qb.selectFrom('sale_orders');
    // @ts-expect-error unknown column
    qb.selectFrom('sale_order as so').select(['so.nam']);
    // @ts-expect-error alias not in scope
    qb.selectFrom('sale_order as so').select(['p.name']);
    // @ts-expect-error value type must match the column
    qb.selectFrom('sale_order').select(['id']).where('id', '=', 'one');
    // @ts-expect-error in needs an array
    qb.selectFrom('sale_order').select(['id']).where('id', 'in', 1);
    // @ts-expect-error unknown operator
    qb.selectFrom('sale_order').select(['id']).where('id', '===', 1);
    // @ts-expect-error insert values must be columns of the table
    qb.insertInto('res_partner').values([{ nam: 'x' }]);
    // @ts-expect-error joined alias column must exist
    qb.selectFrom('sale_order as so').innerJoin('res_partner as p', 'p.idd', 'so.partner_id');
    // @ts-expect-error order by needs a column in scope
    qb.selectFrom('sale_order').select(['id']).orderBy('nope');
  };
  expectTypeOf(misuse).toBeFunction();
});
