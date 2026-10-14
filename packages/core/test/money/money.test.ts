import { describe, expect, test } from 'vitest';
import { CurrencyMismatchError, DivisionByZeroError, Money } from '../../src/index.js';
import { BDT, CHF_CASH, catchError, JPY, KWD, USD } from './fixtures.js';

const bdt = (v: string): Money => Money.of(v, BDT);
const amounts = (ms: readonly Money[]): string[] => ms.map((m) => m.amount.toFixed());

describe('arithmetic', () => {
  test('exact and unrounded', () => {
    expect(bdt('0.1').plus(bdt('0.2')).equalsExactly(bdt('0.3'))).toBe(true);
    expect(bdt('85000').times('0.15').amount.toFixed()).toBe('12750');
    expect(bdt('100').dividedBy(3).amount.toFixed().startsWith('33.3333333333')).toBe(true);
    expect(bdt('10').minus(bdt('12.5')).amount.toFixed()).toBe('-2.5');
    expect(bdt('-5').negated().amount.toFixed()).toBe('5');
    expect(bdt('-5').abs().amount.toFixed()).toBe('5');
  });

  test('different currencies never mix', () => {
    const err = catchError(() => Money.of('10', USD).plus(bdt('10')));
    expect(err).toBeInstanceOf(CurrencyMismatchError);
    expect(err.code).toBe('CURRENCY_MISMATCH');
    expect(err.message).toMatch(/USD.*BDT/);
    expect(err.hint).toMatch(/convert/i);
    expect(err.hint).toMatch(/date/i);
    expect(() => Money.of('1', USD).minus(bdt('1'))).toThrow(CurrencyMismatchError);
    expect(() => Money.of('1', USD).compare(bdt('1'))).toThrow(CurrencyMismatchError);
    expect(() => Money.of('1', USD).equals(bdt('1'))).toThrow(CurrencyMismatchError);
  });

  test('division by zero is an error', () => {
    expect(() => bdt('1').dividedBy(0)).toThrow(DivisionByZeroError);
    expect(() => bdt('1').dividedBy('0.000')).toThrow(DivisionByZeroError);
  });

  test('values are immutable', () => {
    const m = bdt('1');
    m.plus(bdt('2'));
    expect(m.amount.toFixed()).toBe('1');
    expect(Object.isFrozen(m)).toBe(true);
  });
});

describe('rounding to the currency', () => {
  test.each([
    [BDT, '1.005', '1.01'], // half-up rounds half away from zero
    [BDT, '-1.005', '-1.01'],
    [BDT, '1.004999', '1'],
    [USD, '1.005', '1'], // half-even (banker's)
    [USD, '1.015', '1.02'],
    [JPY, '1234.5', '1235'],
    [KWD, '1.0005', '1.001'],
    [CHF_CASH, '1.02', '1'], // cash rounding to 0.05
    [CHF_CASH, '1.03', '1.05'],
    [CHF_CASH, '1.025', '1.05'],
    [CHF_CASH, '1.074', '1.05'],
  ])('%o: %s → %s', (currency, input, expected) => {
    expect(Money.of(input, currency).round().amount.toFixed()).toBe(expected);
  });

  test('explicit rounding method', () => {
    expect(bdt('1.001').round('up').amount.toFixed()).toBe('1.01');
    expect(bdt('-1.001').round('up').amount.toFixed()).toBe('-1.01'); // up = away from zero
    expect(bdt('1.009').round('down').amount.toFixed()).toBe('1');
    expect(bdt('1.005').round('half-even').amount.toFixed()).toBe('1');
  });
});

describe('comparisons at currency precision', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(bdt('0.004').isZero()).toBe(true);
    expect(bdt('0.005').isZero()).toBe(false);
    expect(bdt('-0.004').isNegative()).toBe(false);
    expect(bdt('0.006').isPositive()).toBe(true);
    expect(bdt('-0.006').isNegative()).toBe(true);
  });

  test('equals, equalsExactly, compare', () => {
    expect(bdt('1.004').equals(bdt('1'))).toBe(true);
    expect(bdt('1.004').equalsExactly(bdt('1'))).toBe(false);
    expect(bdt('1.006').compare(bdt('1'))).toBe(1);
    expect(bdt('0.999').compare(bdt('1'))).toBe(0);
    expect(bdt('1').compare(bdt('2'))).toBe(-1);
    expect(Money.of('1', USD).equalsExactly(bdt('1'))).toBe(false); // different currency: not equal, no throw
  });
});

describe('allocation (largest remainder, no lost cents)', () => {
  test.each([
    [BDT, '1000', ['1', '1', '1'], ['333.34', '333.33', '333.33']],
    [BDT, '100', ['1', '2'], ['33.33', '66.67']],
    [BDT, '-1000', ['1', '1', '1'], ['-333.34', '-333.33', '-333.33']],
    [JPY, '10', ['1', '1', '1'], ['4', '3', '3']],
    [BDT, '50', ['0', '1'], ['0', '50']],
    [BDT, '1', ['0.5', '0.25', '0.25'], ['0.5', '0.25', '0.25']],
    [CHF_CASH, '1', ['1', '1', '1'], ['0.35', '0.35', '0.3']],
    [BDT, '10.005', ['1', '1'], ['5.01', '5']], // allocates the rounded total
  ])('%o %s over %j', (currency, total, ratios, expected) => {
    const shares = Money.of(total, currency).allocate(ratios);
    expect(amounts(shares)).toEqual(expected);
  });

  test('ratios whose shares are not representable at 64 digits still sum exactly', () => {
    // 1/3 and 2/3 of 10^40 cents, with decimal ratios: exact remainders are needed to break the tie correctly
    const total = Money.of(`1${'0'.repeat(40)}`, BDT);
    const shares = total.allocate(['0.1', '0.2', '0.3', '0.3333333333333333333333333333333']);
    expect(Money.sum(shares).equalsExactly(total)).toBe(true);
    const thirds = Money.of('0.02', BDT).allocate(['1', '1', '1']);
    expect(amounts(thirds)).toEqual(['0.01', '0.01', '0']);
  });

  test.each([[[]], [['-1', '2']], [['0', '0']]])('invalid ratios %j', (ratios) => {
    expect(catchError(() => bdt('10').allocate(ratios)).code).toBe('INVALID_ALLOCATION');
  });
});

describe('sum and zero', () => {
  test('sum', () => {
    expect(Money.sum([bdt('1.5'), bdt('2.25')]).amount.toFixed()).toBe('3.75');
    expect(Money.sum([], BDT).isZero()).toBe(true);
    expect(catchError(() => Money.sum([])).code).toBe('MONEY_EMPTY_SUM');
    expect(() => Money.sum([bdt('1'), Money.of('1', USD)])).toThrow(CurrencyMismatchError);
    expect(() => Money.sum([bdt('1')], USD)).toThrow(CurrencyMismatchError);
  });

  test('zero', () => {
    expect(Money.zero(JPY).toJSON()).toEqual({ amount: '0', currency: 'JPY' });
  });
});

describe('serialization', () => {
  test.each([
    [Money.of('85000', BDT), '85000.00'],
    [Money.of('1.2345', BDT), '1.2345'], // unrounded values keep their digits
    [Money.of('1500', JPY), '1500'],
    [Money.of('-0', BDT), '0.00'], // no negative zero
    [Money.of('-12.5', BDT), '-12.50'],
  ])('%s', (money, amount) => {
    expect(money.toJSON()).toEqual({ amount, currency: money.currency.code });
    expect(JSON.stringify(money)).toBe(JSON.stringify({ amount, currency: money.currency.code }));
  });

  test('toString', () => {
    expect(bdt('85000').toString()).toBe('BDT 85000.00');
  });
});

describe('RFC 0006 §7.8 tax rounding example', () => {
  const lines = [bdt('10.03'), bdt('10.03'), bdt('10.03')];
  const rate = '0.15';

  test('per line: round each line tax, then sum → 4.50', () => {
    const tax = Money.sum(lines.map((l) => l.times(rate).round()));
    expect(tax.amount.toFixed(2)).toBe('4.50');
  });

  test('global: round the total once → 4.51, then allocate back to lines exactly', () => {
    const tax = Money.sum(lines).times(rate).round();
    expect(tax.amount.toFixed(2)).toBe('4.51');
    const perLine = tax.allocate(lines.map((l) => l.times(rate).amount));
    expect(amounts(perLine)).toEqual(['1.51', '1.5', '1.5']);
    expect(Money.sum(perLine).equalsExactly(tax)).toBe(true);
  });
});
