import { InvalidCurrencyError } from '../errors.js';
import { type Decimal, type DecimalInput, toDecimal } from './decimal.js';
import type { RoundingMethod } from './rounding.js';

/**
 * The rounding-relevant attributes of a currency (a snapshot of a `res.currency` record, RFC 0006 §7.2).
 * Immutable. Two currencies are the same when their ISO codes match (and their ids, when both have one).
 */
export interface Currency {
  /** ISO 4217 code, e.g. `'BDT'`. */
  readonly code: string;
  /** Database id of the `res.currency` record, when known. */
  readonly id: number | undefined;
  /** Smallest unit amounts are rounded to: `0.01`, `1` (JPY), `0.05` (cash rounding). */
  readonly rounding: Decimal;
  /** Digits shown after the decimal point; at least the digits of `rounding`. */
  readonly decimalPlaces: number;
  /** Default rounding method. */
  readonly roundingMethod: RoundingMethod;
}

/** Input of {@link defineCurrency}. */
export interface CurrencyInput {
  readonly code: string;
  readonly rounding: DecimalInput;
  readonly roundingMethod?: RoundingMethod;
  readonly decimalPlaces?: number;
  readonly id?: number;
}

/**
 * Creates a {@link Currency}. `decimalPlaces` defaults to the digits of `rounding`, `roundingMethod` to `half-up`.
 *
 * @example
 * ```ts
 * const BDT = defineCurrency({ code: 'BDT', rounding: '0.01' });
 * const CHF_CASH = defineCurrency({ code: 'CHF', rounding: '0.05' });
 * ```
 * @throws {InvalidCurrencyError} for a code that isn't 3 upper-case letters, a non-positive rounding, or too few decimal places.
 */
export function defineCurrency(input: CurrencyInput): Currency {
  if (!/^[A-Z]{3}$/.test(input.code)) {
    throw new InvalidCurrencyError(
      `${JSON.stringify(input.code)} is not an ISO 4217 currency code.`,
      "Use three upper-case letters, e.g. 'BDT', 'USD', 'EUR'.",
    );
  }
  const rounding = toDecimal(input.rounding);
  if (!rounding.isPositive() || rounding.isZero()) {
    throw new InvalidCurrencyError(
      `Currency ${input.code} has rounding ${rounding.toFixed()}.`,
      "The rounding unit must be positive, e.g. '0.01' for cents or '1' for currencies without decimals.",
    );
  }
  const minPlaces = rounding.decimalPlaces();
  const decimalPlaces = input.decimalPlaces ?? minPlaces;
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < minPlaces) {
    throw new InvalidCurrencyError(
      `Currency ${input.code} has ${decimalPlaces} decimal places but rounds to ${rounding.toFixed()}.`,
      `Use at least ${minPlaces} decimal places, or omit decimalPlaces to derive it from the rounding.`,
    );
  }
  return Object.freeze({
    code: input.code,
    id: input.id,
    rounding,
    decimalPlaces,
    roundingMethod: input.roundingMethod ?? 'half-up',
  });
}

/** True when `a` and `b` denote the same currency. */
export function sameCurrency(a: Currency, b: Currency): boolean {
  return (
    a === b || (a.code === b.code && (a.id === undefined || b.id === undefined || a.id === b.id))
  );
}
