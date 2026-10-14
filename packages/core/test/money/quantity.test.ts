import { describe, expect, test } from 'vitest';
import {
  defineUom,
  IncompatibleUomCategoryError,
  Quantity,
  UomMismatchError,
} from '../../src/index.js';
import { catchError, DOZEN, GRAM, KG, UNIT } from './fixtures.js';

describe('Quantity', () => {
  test('conversion within a category is exact', () => {
    expect(Quantity.of('3', DOZEN).to(UNIT).value.toFixed()).toBe('36');
    expect(Quantity.of('36', UNIT).to(DOZEN).value.toFixed()).toBe('3');
    expect(Quantity.of('1500', GRAM).to(KG).value.toFixed()).toBe('1.5');
    expect(Quantity.of('1', UNIT).to(DOZEN).uom).toBe(DOZEN);
  });

  test('different units never mix without conversion', () => {
    const err = catchError(() => Quantity.of('3', DOZEN).plus(Quantity.of('6', UNIT)));
    expect(err).toBeInstanceOf(UomMismatchError);
    expect(err.hint).toMatch(/\.to\(/);
    expect(Quantity.of('3', DOZEN).plus(Quantity.of('6', UNIT).to(DOZEN)).value.toFixed()).toBe(
      '3.5',
    );
  });

  test('converting across categories is an error', () => {
    const err = catchError(() => Quantity.of('1', UNIT).to(KG));
    expect(err).toBeInstanceOf(IncompatibleUomCategoryError);
    expect(err.message).toMatch(/Unit.*Weight/);
  });

  test('rounding to the unit of measure', () => {
    expect(Quantity.of('0.3', UNIT).round('up').value.toFixed()).toBe('1');
    expect(Quantity.of('0.3', UNIT).round().value.toFixed()).toBe('0');
    expect(Quantity.of('1.2345', KG).round().value.toFixed()).toBe('1.235');
    expect(Quantity.of('0.4', UNIT).isZero()).toBe(true);
  });

  test('arithmetic and comparison', () => {
    const q = Quantity.of('2.5', KG);
    expect(q.times('4').value.toFixed()).toBe('10');
    expect(q.minus(Quantity.of('0.5', KG)).value.toFixed()).toBe('2');
    expect(q.compare(Quantity.of('2.5004', KG))).toBe(0); // at uom precision
    expect(q.equals(Quantity.of('2.5', KG))).toBe(true);
    expect(q.toJSON()).toEqual({ value: '2.5', uom: 'kg' });
    expect(Object.isFrozen(q)).toBe(true);
  });

  test('defineUom validates its input', () => {
    expect(
      catchError(() => defineUom({ name: '', category: 'Unit', ratio: '1', rounding: '1' })).code,
    ).toBe('INVALID_UOM');
    expect(
      catchError(() => defineUom({ name: 'x', category: 'Unit', ratio: '0', rounding: '1' })).code,
    ).toBe('INVALID_UOM');
    expect(
      catchError(() => defineUom({ name: 'x', category: 'Unit', ratio: '1', rounding: '-1' })).code,
    ).toBe('INVALID_UOM');
  });
});
