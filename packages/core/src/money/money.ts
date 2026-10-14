import {
  CurrencyMismatchError,
  DivisionByZeroError,
  EmptyMoneySumError,
  InvalidAllocationError,
} from '../errors.js';
import { type Currency, sameCurrency } from './currency.js';
import { Decimal, type DecimalInput, normalizeZero, toDecimal } from './decimal.js';
import { type RoundingMethod, roundToUnit } from './rounding.js';

/** JSON form of {@link Money}: the amount as an exact decimal string. */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

/**
 * An immutable amount in one currency (RFC 0006 §7.3).
 *
 * - Arithmetic is exact and **unrounded**; call {@link Money.round} at the points where rounding is defined.
 * - Combining or comparing amounts in different currencies throws {@link CurrencyMismatchError}. Conversion is a
 *   separate, dated operation.
 * - `isZero`, `equals` and `compare` work at the currency's rounding precision (like Odoo's `float_is_zero`).
 *
 * @example
 * ```ts
 * const price = Money.of('85000.00', BDT);
 * price.times('0.15').round();          // BDT 12750.00
 * Money.of('1000', BDT).allocate([1, 1, 1]); // 333.34, 333.33, 333.33
 * ```
 */
export class Money {
  /** The exact amount. */
  readonly amount: Decimal;
  /** The currency. */
  readonly currency: Currency;

  private constructor(amount: Decimal, currency: Currency) {
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  /** An amount in `currency`. */
  static of(amount: DecimalInput, currency: Currency): Money {
    return new Money(toDecimal(amount), currency);
  }

  /** Zero in `currency`. */
  static zero(currency: Currency): Money {
    return new Money(new Decimal(0), currency);
  }

  /**
   * Sum of amounts in one currency. An empty list needs `currency` to know which zero to return.
   * @throws {CurrencyMismatchError} if the amounts (or `currency`) differ.
   * @throws {EmptyMoneySumError} for an empty list without `currency`.
   */
  static sum(items: readonly Money[], currency?: Currency): Money {
    const first = items[0];
    const target = currency ?? first?.currency;
    if (target === undefined) {
      throw new EmptyMoneySumError(
        'Money.sum() was given an empty list and no currency.',
        'Pass the currency for the empty case: Money.sum(amounts, currency).',
      );
    }
    let total = Money.zero(target);
    for (const item of items) total = total.plus(item);
    return total;
  }

  /** `this + other`. @throws {CurrencyMismatchError} */
  plus(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  /** `this - other`. @throws {CurrencyMismatchError} */
  minus(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** `this × factor`, unrounded. */
  times(factor: DecimalInput): Money {
    return new Money(this.amount.times(toDecimal(factor)), this.currency);
  }

  /** `this ÷ divisor`, unrounded (64 significant digits). @throws {DivisionByZeroError} */
  dividedBy(divisor: DecimalInput): Money {
    const d = toDecimal(divisor);
    if (d.isZero()) {
      throw new DivisionByZeroError(
        `Cannot divide ${this.toString()} by zero.`,
        'Check the divisor (quantity, ratio, number of installments) before dividing; use allocate() to split amounts.',
      );
    }
    return new Money(this.amount.dividedBy(d), this.currency);
  }

  /** `-this`. */
  negated(): Money {
    return new Money(normalizeZero(this.amount.negated()), this.currency);
  }

  /** `|this|`. */
  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /** Rounded to the currency's rounding unit, with the currency's method unless `method` is given. */
  round(method: RoundingMethod = this.currency.roundingMethod): Money {
    return new Money(roundToUnit(this.amount, this.currency.rounding, method), this.currency);
  }

  /** True when the amount rounds to zero in its currency. */
  isZero(): boolean {
    return this.round().amount.isZero();
  }

  /** True when the amount rounds to more than zero. */
  isPositive(): boolean {
    return this.round().amount.gt(0);
  }

  /** True when the amount rounds to less than zero. */
  isNegative(): boolean {
    return this.round().amount.lt(0);
  }

  /** Equal at currency precision. @throws {CurrencyMismatchError} */
  equals(other: Money): boolean {
    return this.compare(other) === 0;
  }

  /** Same currency and exactly the same amount (no rounding). Never throws. */
  equalsExactly(other: Money): boolean {
    return sameCurrency(this.currency, other.currency) && this.amount.eq(other.amount);
  }

  /** -1, 0 or 1 at currency precision. @throws {CurrencyMismatchError} */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compare');
    const c = this.round().amount.cmp(other.round().amount);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }

  /**
   * Splits the rounded amount by `ratios` with the largest-remainder method (RFC 0006 §7.6): every share is a
   * multiple of the rounding unit, the shares add up **exactly** to `this.round()`, each is within one unit of its
   * exact proportional value, and ties go to the earliest share.
   *
   * @throws {InvalidAllocationError} for an empty list, a negative ratio, or ratios that sum to zero.
   */
  allocate(ratios: readonly DecimalInput[]): readonly Money[] {
    const weights = ratios.map(toDecimal);
    const totalWeight = weights.reduce((a, b) => a.plus(b), new Decimal(0));
    if (
      weights.length === 0 ||
      weights.some((w) => w.isNegative() && !w.isZero()) ||
      totalWeight.isZero()
    ) {
      throw new InvalidAllocationError(
        `Cannot allocate ${this.toString()} by ratios [${weights.map((w) => w.toFixed()).join(', ')}].`,
        'Pass at least one ratio; ratios must be zero or positive and not all zero.',
      );
    }
    const unit = this.currency.rounding;
    const totalUnits = this.round().amount.dividedBy(unit); // an integer
    const units = totalUnits.abs();
    // Exact integer arithmetic: scale ratios to integers, then share_i = floor(units·w_i / W) with an exact
    // remainder. Comparing inexact quotients could floor a near-integer share the wrong way and break Σ = total.
    const scale = new Decimal(10).pow(Math.max(...weights.map((w) => w.decimalPlaces())));
    const ints = weights.map((w) => w.times(scale));
    const sumInts = ints.reduce((a, b) => a.plus(b), new Decimal(0));
    const counts = ints.map((w) => units.times(w).dividedToIntegerBy(sumInts));
    const remainders = ints.map((w) => units.times(w).mod(sumInts));
    let remaining = counts.reduce((a, b) => a.minus(b), units).toNumber();
    const byRemainder = remainders
      .map((r, i) => ({ i, r }))
      .sort((a, b) => b.r.cmp(a.r) || a.i - b.i);
    for (const { i } of byRemainder) {
      if (remaining <= 0) break;
      counts[i] = (counts[i] ?? new Decimal(0)).plus(1);
      remaining--;
    }
    const sign = totalUnits.isNegative() ? -1 : 1;
    return Object.freeze(
      counts.map((count) => new Money(normalizeZero(count.times(unit).times(sign)), this.currency)),
    );
  }

  /** The exact amount as a Decimal. */
  toDecimal(): Decimal {
    return this.amount;
  }

  /**
   * `{ amount: '85000.00', currency: 'BDT' }`. The amount is exact: padded to the currency's decimal places, never
   * truncated (an unrounded `1.2345` stays `'1.2345'`).
   */
  toJSON(): MoneyJson {
    const places = Math.max(this.currency.decimalPlaces, this.amount.decimalPlaces());
    return { amount: normalizeZero(this.amount).toFixed(places), currency: this.currency.code };
  }

  /** `'BDT 85000.00'`. Locale-aware formatting is the job of `format(lang)` (later). */
  toString(): string {
    return `${this.currency.code} ${this.toJSON().amount}`;
  }

  private assertSameCurrency(other: Money, operation: 'add' | 'subtract' | 'compare'): void {
    if (!sameCurrency(this.currency, other.currency)) {
      throw new CurrencyMismatchError(
        `Cannot ${operation} ${this.toString()} and ${other.toString()}: they are in different currencies.`,
        'Convert one amount first: await env.fx.convert(amount, currency, { date }), and use the date of the document (invoice date / accounting date), not today.',
      );
    }
  }
}
