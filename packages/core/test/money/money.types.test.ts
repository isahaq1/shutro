/**
 * Type-level guarantees (RFC 0006 §8), checked by `pnpm typecheck`.
 */
import { expectTypeOf, test } from 'vitest';
import { type Decimal, Money, Quantity, toDecimal } from '../../src/index.js';
import { BDT, KG } from './fixtures.js';

test('result types', () => {
  const m = Money.of('1', BDT);
  expectTypeOf(m.plus(m)).toEqualTypeOf<Money>();
  expectTypeOf(m.amount).toEqualTypeOf<Decimal>();
  expectTypeOf(m.allocate(['1', '1'])).toEqualTypeOf<readonly Money[]>();
  expectTypeOf(m.compare(m)).toEqualTypeOf<-1 | 0 | 1>();
  expectTypeOf(m.toJSON()).toEqualTypeOf<{ readonly amount: string; readonly currency: string }>();
  expectTypeOf(Quantity.of('1', KG).value).toEqualTypeOf<Decimal>();
  expectTypeOf(toDecimal('1')).toEqualTypeOf<Decimal>();
});

test('Money, Quantity and Decimal do not mix', () => {
  // Type-checked only, never called.
  const misuse = (): void => {
    const m = Money.of('1', BDT);
    const q = Quantity.of('1', KG);
    // @ts-expect-error Decimal is not Money
    m.plus(toDecimal('1'));
    // @ts-expect-error Quantity is not Money
    m.plus(q);
    // @ts-expect-error Money is not Quantity
    q.plus(m);
    // @ts-expect-error a ratio list is required
    m.allocate();
    // @ts-expect-error money is immutable
    m.amount = toDecimal('2');
    // @ts-expect-error a currency is required
    Money.of('1');
  };
  expectTypeOf(misuse).toBeFunction();
});
