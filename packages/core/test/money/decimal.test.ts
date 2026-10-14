import { Decimal as DecimalJs } from 'decimal.js';
import { describe, expect, test } from 'vitest';
import {
  Decimal,
  defineCurrency,
  InvalidDecimalError,
  NonIntegerNumberError,
  ShutroError,
  toDecimal,
} from '../../src/index.js';
import { catchError } from './fixtures.js';

describe('Decimal', () => {
  test('is an isolated decimal.js clone with precision 64 (RFC 0006 as amended by RFC 0007)', () => {
    expect(Decimal.precision).toBe(64);
    expect(Decimal.rounding).toBe(DecimalJs.ROUND_HALF_UP);
    expect(Decimal).not.toBe(DecimalJs);
    expect(DecimalJs.precision).toBe(20); // the global config is untouched
  });

  test('exact decimal arithmetic', () => {
    expect(toDecimal('0.1').plus('0.2').toString()).toBe('0.3');
  });

  test('sums of 42-digit values stay exact (spike 0002 K1 regression)', () => {
    const a = toDecimal('123456789012345678901234567890.123456789012');
    const b = toDecimal('987654321098765432109876543210.987654321098');
    expect(a.plus(b).toFixed()).toBe('1111111110111111111011111111101.11111111011');
  });
});

describe('toDecimal inputs', () => {
  test.each([
    ['85000.00', '85000'],
    ['-0.5', '-0.5'],
    ['+3', '3'],
    ['.25', '0.25'],
    ['1e3', '1000'],
    ['1.5E-2', '0.015'],
  ])('string %j', (input, expected) => {
    expect(toDecimal(input).toFixed()).toBe(expected);
  });

  test('integer numbers, bigint and Decimal', () => {
    expect(toDecimal(3).toFixed()).toBe('3');
    expect(toDecimal(-42).toFixed()).toBe('-42');
    expect(toDecimal(10n ** 30n).toFixed()).toBe(`1${'0'.repeat(30)}`);
    expect(toDecimal(new Decimal('1.5')).toFixed()).toBe('1.5');
  });

  test('a fractional number is rejected with a fix in the message', () => {
    const err = catchError(() => toDecimal(0.15));
    expect(err).toBeInstanceOf(NonIntegerNumberError);
    expect(err.code).toBe('NON_INTEGER_NUMBER');
    expect(err.message).toContain("'0.15'");
  });

  test('unsafe integers are rejected too (precision already lost)', () => {
    expect(() => toDecimal(2 ** 53)).toThrow(NonIntegerNumberError);
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['0x10'],
    ['0b11'],
    ['1,000'],
    [''],
    [' 1'],
    ['1.2.3'],
    ['৳5'],
  ])('invalid string %j', (input) => {
    const err = catchError(() => toDecimal(input));
    expect(err).toBeInstanceOf(InvalidDecimalError);
    expect(err.hint.length).toBeGreaterThan(10);
  });

  test('NaN and infinite numbers are rejected', () => {
    expect(() => toDecimal(Number.NaN)).toThrow(NonIntegerNumberError);
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow(NonIntegerNumberError);
  });

  test('a Decimal from another decimal.js config is re-created with Shutro precision', () => {
    const Low = DecimalJs.clone({ precision: 5 });
    const third = toDecimal(new Low(1)).dividedBy(3);
    expect(third.toFixed().length).toBeGreaterThan(60);
  });

  test('a non-finite Decimal is rejected', () => {
    expect(() => toDecimal(new Decimal(Number.POSITIVE_INFINITY))).toThrow(InvalidDecimalError);
  });

  test('all errors derive from ShutroError with code and hint', () => {
    const err = catchError(() => toDecimal('abc'));
    expect(err).toBeInstanceOf(ShutroError);
    expect(err.message).toContain(err.hint);
  });
});

describe('defineCurrency', () => {
  test('derives decimal places from the rounding unit, defaults to half-up', () => {
    const c = defineCurrency({ code: 'BDT', rounding: '0.01' });
    expect(c.decimalPlaces).toBe(2);
    expect(c.roundingMethod).toBe('half-up');
    expect(c.rounding.toFixed()).toBe('0.01');
    expect(Object.isFrozen(c)).toBe(true);
    expect(defineCurrency({ code: 'CHF', rounding: '0.05' }).decimalPlaces).toBe(2);
    expect(defineCurrency({ code: 'JPY', rounding: '1' }).decimalPlaces).toBe(0);
  });

  test.each([
    [{ code: 'bdt', rounding: '0.01' }],
    [{ code: 'BDTX', rounding: '0.01' }],
    [{ code: 'BDT', rounding: '0' }],
    [{ code: 'BDT', rounding: '-0.01' }],
    [{ code: 'BDT', rounding: '0.01', decimalPlaces: 1 }],
  ])('rejects %j', (input) => {
    const err = catchError(() => defineCurrency(input));
    expect(err.code).toBe('INVALID_CURRENCY');
  });
});
