import { IncompatibleUomCategoryError, InvalidUomError, UomMismatchError } from '../errors.js';
import { type Decimal, type DecimalInput, normalizeZero, toDecimal } from './decimal.js';
import { type RoundingMethod, roundToUnit } from './rounding.js';

/** A unit of measure (a snapshot of a `uom.uom` record, RFC 0006 §7.4). */
export interface Uom {
  readonly name: string;
  /** Units convert only within a category ('Unit', 'Weight', 'Length', ...). */
  readonly category: string;
  /** How many of the category's reference unit one of this unit is (dozen: 12, gram: 0.001 when kg is the reference). */
  readonly ratio: Decimal;
  /** Smallest quantity in this unit (units: 1, kg: 0.001). */
  readonly rounding: Decimal;
  /** Database id of the `uom.uom` record, when known. */
  readonly id: number | undefined;
}

/** Input of {@link defineUom}. */
export interface UomInput {
  readonly name: string;
  readonly category: string;
  readonly ratio: DecimalInput;
  readonly rounding: DecimalInput;
  readonly id?: number;
}

/**
 * Creates a {@link Uom}.
 * @throws {InvalidUomError} for an empty name or category, or a non-positive ratio or rounding.
 */
export function defineUom(input: UomInput): Uom {
  const ratio = toDecimal(input.ratio);
  const rounding = toDecimal(input.rounding);
  if (input.name.trim() === '' || input.category.trim() === '') {
    throw new InvalidUomError(
      'A unit of measure needs a name and a category.',
      "Pass e.g. { name: 'kg', category: 'Weight', ... }.",
    );
  }
  for (const [label, value] of [
    ['ratio', ratio],
    ['rounding', rounding],
  ] as const) {
    if (value.isZero() || value.isNegative()) {
      throw new InvalidUomError(
        `Unit ${input.name} has ${label} ${value.toFixed()}.`,
        `The ${label} must be positive (ratio: reference units per ${input.name}; rounding: smallest quantity).`,
      );
    }
  }
  return Object.freeze({
    name: input.name,
    category: input.category,
    ratio,
    rounding,
    id: input.id,
  });
}

function sameUom(a: Uom, b: Uom): boolean {
  return a === b || (a.name === b.name && a.category === b.category && a.ratio.eq(b.ratio));
}

/**
 * An immutable quantity in one unit of measure. Mixing units requires an explicit {@link Quantity.to}, and
 * conversion is only possible within a category.
 */
export class Quantity {
  /** The exact value. */
  readonly value: Decimal;
  /** The unit. */
  readonly uom: Uom;

  private constructor(value: Decimal, uom: Uom) {
    this.value = value;
    this.uom = uom;
    Object.freeze(this);
  }

  /** A quantity of `value` in `uom`. */
  static of(value: DecimalInput, uom: Uom): Quantity {
    return new Quantity(toDecimal(value), uom);
  }

  /**
   * The same quantity in `target` (exact, unrounded): `Quantity.of(3, dozen).to(unit)` → 36 units.
   * @throws {IncompatibleUomCategoryError} when the categories differ.
   */
  to(target: Uom): Quantity {
    if (this.uom.category !== target.category) {
      throw new IncompatibleUomCategoryError(
        `Cannot convert ${this.uom.name} (${this.uom.category}) to ${target.name} (${target.category}).`,
        'Units convert only within one category; check the product unit and the unit used on the document.',
      );
    }
    if (sameUom(this.uom, target)) return this;
    return new Quantity(
      normalizeZero(this.value.times(this.uom.ratio).dividedBy(target.ratio)),
      target,
    );
  }

  /** `this + other`, same unit. @throws {UomMismatchError} */
  plus(other: Quantity): Quantity {
    this.assertSameUom(other, 'add');
    return new Quantity(this.value.plus(other.value), this.uom);
  }

  /** `this - other`, same unit. @throws {UomMismatchError} */
  minus(other: Quantity): Quantity {
    this.assertSameUom(other, 'subtract');
    return new Quantity(this.value.minus(other.value), this.uom);
  }

  /** `this × factor`, unrounded. */
  times(factor: DecimalInput): Quantity {
    return new Quantity(this.value.times(toDecimal(factor)), this.uom);
  }

  /** Rounded to the unit's rounding (`half-up` unless given; procurement typically uses `up`). */
  round(method: RoundingMethod = 'half-up'): Quantity {
    return new Quantity(roundToUnit(this.value, this.uom.rounding, method), this.uom);
  }

  /** True when the quantity rounds to zero in its unit. */
  isZero(): boolean {
    return this.round().value.isZero();
  }

  /** -1, 0 or 1 at the unit's precision. @throws {UomMismatchError} */
  compare(other: Quantity): -1 | 0 | 1 {
    this.assertSameUom(other, 'compare');
    const c = this.round().value.cmp(other.round().value);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }

  /** Equal at the unit's precision. @throws {UomMismatchError} */
  equals(other: Quantity): boolean {
    return this.compare(other) === 0;
  }

  /** `{ value: '2.5', uom: 'kg' }`. */
  toJSON(): { readonly value: string; readonly uom: string } {
    return { value: normalizeZero(this.value).toFixed(), uom: this.uom.name };
  }

  /** `'2.5 kg'`. */
  toString(): string {
    return `${normalizeZero(this.value).toFixed()} ${this.uom.name}`;
  }

  private assertSameUom(other: Quantity, operation: 'add' | 'subtract' | 'compare'): void {
    if (!sameUom(this.uom, other.uom)) {
      throw new UomMismatchError(
        `Cannot ${operation} ${this.toString()} and ${other.toString()}: they are in different units.`,
        `Convert first, e.g. other.to(${this.uom.name}) with Quantity.to(uom).`,
      );
    }
  }
}
