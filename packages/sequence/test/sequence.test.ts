import { describe, expect, test } from 'vitest';
import {
  allocateStatement,
  defineSequence,
  formatNumber,
  InvalidSequenceError,
  numbersFrom,
  periodKey,
} from '../src/index.js';

describe('defineSequence', () => {
  test('defaults and validation', () => {
    expect(defineSequence({ code: 'sale.order' })).toEqual({
      code: 'sale.order',
      prefix: '',
      suffix: '',
      padding: 5,
      start: 1,
      step: 1,
      gapless: false,
      perCompany: true,
      reset: 'never',
    });
    expect(() => defineSequence({ code: 'Sale Order' })).toThrow(InvalidSequenceError);
    expect(() => defineSequence({ code: 'x', padding: 30 })).toThrow(/padding/);
    expect(() => defineSequence({ code: 'x', step: 0 })).toThrow(/step/);
    expect(() => defineSequence({ code: 'x', prefix: 'INV/{yr}/' })).toThrow(/\{yr\}/);
    expect(() => defineSequence({ code: 'x', reset: 'weekly' as never })).toThrow(/reset/);
  });
});

describe('format and period', () => {
  const inv = defineSequence({
    code: 'account.move',
    prefix: 'INV/{year}/{month}/',
    suffix: '-{yy}',
    padding: 4,
    reset: 'monthly',
  });
  test('placeholders and padding', () => {
    expect(formatNumber(inv, 7, '2026-03-15')).toBe('INV/2026/03/0007-26');
    expect(formatNumber(defineSequence({ code: 'x', padding: 0 }), 7, '2026-03-15')).toBe('7');
  });
  test('period keys', () => {
    expect(periodKey(inv, '2026-03-15')).toBe('2026-03');
    expect(periodKey(defineSequence({ code: 'x', reset: 'yearly' }), '2026-03-15')).toBe('2026');
    expect(periodKey(defineSequence({ code: 'x', reset: 'daily' }), '2026-03-15')).toBe(
      '2026-03-15',
    );
    expect(periodKey(defineSequence({ code: 'x' }), '2026-03-15')).toBe('');
  });
});

describe('allocation', () => {
  test('one statement reserves a range with step, returning the first number', () => {
    const def = defineSequence({ code: 'x', start: 10, step: 5 });
    const { text, params } = allocateStatement(def, 1, '2026', 3);
    expect(text).toContain('ON CONFLICT');
    expect(params).toEqual(['x', 1, '2026', 25, 15, 15]);
    expect(numbersFrom(def, 10, 3)).toEqual([10, 15, 20]);
  });
});
