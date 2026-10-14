/**
 * Property tests (fast-check) for RFC 0006 invariants: exactness, rounding bounds, allocation that never loses a unit.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { type Currency, Decimal, Money, Quantity, type RoundingMethod } from '../../src/index.js';
import { BDT, CHF_CASH, DOZEN, GRAM, JPY, KG, KWD, UNIT, USD } from './fixtures.js';

const currency = fc.constantFrom<Currency>(BDT, USD, JPY, KWD, CHF_CASH);
const method = fc.constantFrom<RoundingMethod>('half-up', 'half-even', 'up', 'down');
/** Exact decimals: a bigint scaled by 10^scale (up to 30 integer digits, 12 decimals). */
const decimalString = fc
  .tuple(fc.bigInt({ min: -(10n ** 42n), max: 10n ** 42n }), fc.integer({ min: 0, max: 12 }))
  .map(([n, scale]) => new Decimal(n.toString()).dividedBy(new Decimal(10).pow(scale)).toFixed());

describe('Money properties', () => {
  // Decimal is exact up to 64 significant digits (RFC 0006); ±10^50 leaves headroom for a sum and 12 decimals.
  const amount = fc.bigInt({ min: -(10n ** 50n), max: 10n ** 50n });
  test('plus/minus are exact (agree with bigint arithmetic on scaled integers)', () => {
    fc.assert(
      fc.property(amount, amount, fc.integer({ min: 0, max: 12 }), (a, b, scale) => {
        const unit = new Decimal(10).pow(-scale);
        const x = Money.of(new Decimal(a.toString()).times(unit), BDT);
        const y = Money.of(new Decimal(b.toString()).times(unit), BDT);
        expect(x.plus(y).amount.dividedBy(unit).toFixed()).toBe((a + b).toString());
        expect(x.plus(y).minus(y).equalsExactly(x)).toBe(true);
      }),
    );
  });

  test('round(): a multiple of the rounding unit, within bounds, idempotent', () => {
    fc.assert(
      fc.property(decimalString, currency, method, (value, c, m) => {
        const x = Money.of(value, c);
        const r = x.round(m);
        const unit = c.rounding;
        expect(r.amount.mod(unit).isZero()).toBe(true);
        const diff = r.amount.minus(x.amount).abs();
        if (m === 'half-up' || m === 'half-even') expect(diff.lte(unit.dividedBy(2))).toBe(true);
        else expect(diff.lt(unit)).toBe(true);
        if (m === 'up') expect(r.amount.abs().gte(x.amount.abs())).toBe(true);
        if (m === 'down') expect(r.amount.abs().lte(x.amount.abs())).toBe(true);
        expect(r.round(m).equalsExactly(r)).toBe(true);
      }),
    );
  });

  test('isZero agrees with round()', () => {
    fc.assert(
      fc.property(decimalString, currency, (value, c) => {
        const x = Money.of(value, c);
        expect(x.isZero()).toBe(x.round().amount.isZero());
      }),
    );
  });

  test('allocate: shares sum exactly to the rounded total and stay within one unit of the exact share', () => {
    fc.assert(
      fc.property(
        decimalString,
        currency,
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 12 })
          .filter((r) => r.some((x) => x > 0)),
        (value, c, ratios) => {
          const total = Money.of(value, c);
          const shares = total.allocate(ratios);
          expect(shares).toHaveLength(ratios.length);
          expect(Money.sum(shares, c).equalsExactly(total.round())).toBe(true);
          const sumRatios = ratios.reduce((a, b) => a + b, 0);
          shares.forEach((share, i) => {
            const ratio = ratios[i] ?? 0;
            const exact = total.round().amount.times(ratio).dividedBy(sumRatios);
            expect(share.amount.minus(exact).abs().lt(c.rounding)).toBe(true);
            expect(share.amount.mod(c.rounding).isZero()).toBe(true);
            if (ratio === 0) expect(share.amount.isZero()).toBe(true);
          });
          expect(total.allocate(ratios).map((s) => s.amount.toFixed())).toEqual(
            shares.map((s) => s.amount.toFixed()),
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('Quantity properties', () => {
  test('converting there and back returns the same quantity (to 50 decimal places)', () => {
    const pairs = fc.constantFrom(
      [UNIT, DOZEN] as const,
      [DOZEN, UNIT] as const,
      [KG, GRAM] as const,
      [GRAM, KG] as const,
    );
    fc.assert(
      fc.property(decimalString, pairs, (value, [from, to]) => {
        const q = Quantity.of(value, from);
        const back = q.to(to).to(from);
        expect(back.value.minus(q.value).abs().lt(new Decimal('1e-50'))).toBe(true);
      }),
    );
  });
});
