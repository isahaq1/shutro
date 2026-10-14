import { Decimal as DecimalJs } from 'decimal.js';
import { InvalidDecimalError, NonIntegerNumberError } from '../errors.js';

/**
 * Shutro's decimal type: an isolated decimal.js constructor with 64 significant digits and half-up rounding
 * (RFC 0006 §6, precision amended by RFC 0007). The global decimal.js configuration is never touched.
 *
 * Instances are ordinary decimal.js `Decimal`s; prefer {@link toDecimal} for input validation.
 */
export const Decimal: typeof DecimalJs = DecimalJs.clone({
  precision: 64,
  rounding: DecimalJs.ROUND_HALF_UP,
  toExpNeg: -100,
  toExpPos: 100,
});
/** A decimal value (decimal.js instance). */
export type Decimal = DecimalJs;

/**
 * Anything accepted where a decimal is expected: a `Decimal`, a decimal string (`'85000.00'`, `'1.5e-2'`), a
 * `bigint`, or a **safe integer** `number`. Fractional numbers are rejected at runtime because they are already
 * binary floating point (`0.1 + 0.2 !== 0.3`).
 */
export type DecimalInput = Decimal | string | bigint | number;

const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Converts input into a {@link Decimal} created with Shutro's constructor, so later arithmetic uses Shutro's precision
 * even if the input came from another decimal.js configuration.
 *
 * @throws {NonIntegerNumberError} for numbers that aren't safe integers (e.g. `0.15`, `NaN`, `2 ** 53`).
 * @throws {InvalidDecimalError} for strings that aren't plain decimals (`'NaN'`, `'0x10'`, `'1,000'`) and non-finite Decimals.
 */
export function toDecimal(input: DecimalInput): Decimal {
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new NonIntegerNumberError(
        Number.isFinite(input) && Number.isInteger(input)
          ? `${input} is beyond Number.MAX_SAFE_INTEGER, so it has already lost precision.`
          : `${input} is a binary floating-point number, not an exact decimal.`,
        `Pass the value as a string ('${input}') or a Decimal; use bigint for large integers.`,
      );
    }
    return new Decimal(input);
  }
  if (typeof input === 'bigint') return new Decimal(input.toString());
  if (typeof input === 'string') {
    if (!PLAIN_DECIMAL.test(input)) {
      throw new InvalidDecimalError(
        `${JSON.stringify(input)} is not a decimal number.`,
        "Use digits with an optional sign, decimal point and exponent, e.g. '85000.00', '-0.5', '1e3' (no thousands separators, currency symbols or spaces).",
      );
    }
    return new Decimal(input);
  }
  if (DecimalJs.isDecimal(input)) {
    if (!input.isFinite()) {
      throw new InvalidDecimalError(
        `${input.toString()} is not a finite decimal.`,
        'Business amounts must be finite: check for a division by zero or an invalid source value.',
      );
    }
    return new Decimal(input);
  }
  throw new InvalidDecimalError(
    `A ${typeof input} was given where a decimal was expected.`,
    'Pass a Decimal, a decimal string, a bigint or a safe integer.',
  );
}

/** Removes the sign of a zero (`-0` → `0`), so serialized amounts never show `-0.00`. */
export function normalizeZero(value: Decimal): Decimal {
  return value.isZero() ? new Decimal(0) : value;
}
