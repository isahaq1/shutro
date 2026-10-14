import { Decimal as DecimalJs } from 'decimal.js';
import { type Decimal, normalizeZero } from './decimal.js';

/**
 * How to round to a currency's or unit's rounding unit:
 * - `half-up`: halves away from zero (1.005 → 1.01, -1.005 → -1.01). Common accounting practice, Odoo's default.
 * - `half-even`: banker's rounding (1.005 → 1.00, 1.015 → 1.02).
 * - `up`: away from zero (1.001 → 1.01). For procurement quantities.
 * - `down`: towards zero (1.009 → 1.00).
 */
export type RoundingMethod = 'half-up' | 'half-even' | 'up' | 'down';

const MODES: Readonly<Record<RoundingMethod, DecimalJs.Rounding>> = {
  'half-up': DecimalJs.ROUND_HALF_UP,
  'half-even': DecimalJs.ROUND_HALF_EVEN,
  up: DecimalJs.ROUND_UP,
  down: DecimalJs.ROUND_DOWN,
};

/** Rounds `value` to a multiple of `unit` (e.g. 0.01, 0.05 for cash rounding, 1). */
export function roundToUnit(value: Decimal, unit: Decimal, method: RoundingMethod): Decimal {
  return normalizeZero(value.dividedBy(unit).toDecimalPlaces(0, MODES[method]).times(unit));
}
