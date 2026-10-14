# Money, decimals and quantities

Shutro never uses JavaScript `number` for money or quantities. These value types implement
[RFC 0006](../rfcs/0006-money-decimals-and-currency.md). Later, monetary and quantity fields will read as these
types automatically. For now they're plain values you construct yourself.

```ts
import { Decimal, defineCurrency, defineUom, Money, Quantity, toDecimal } from '@shutro/core';
```

## Decimal

`Decimal` is decimal.js with 64 significant digits and half-up rounding, configured as an **isolated** clone, so the
global decimal.js settings are never changed. `toDecimal()` validates input:

| Input | Accepted | Example |
| ----- | -------- | ------- |
| decimal string | ✅ | `'85000.00'`, `'-0.5'`, `'1e3'` |
| `bigint` | ✅ | `10n ** 30n` |
| safe integer `number` | ✅ | `3` |
| fractional `number` | ❌ `NonIntegerNumberError` | `0.15`: pass `'0.15'` instead |
| other strings | ❌ `InvalidDecimalError` | `'NaN'`, `'0x10'`, `'1,000'`, `'৳5'` |

## Currencies and Money

```ts
const BDT = defineCurrency({ code: 'BDT', rounding: '0.01' });                       // half-up by default
const USD = defineCurrency({ code: 'USD', rounding: '0.01', roundingMethod: 'half-even' });
const CHF_CASH = defineCurrency({ code: 'CHF', rounding: '0.05' });                  // cash rounding

const price = Money.of('85000.00', BDT);
const vat = price.times('0.15');           // BDT 12750.00: exact, unrounded
const total = price.plus(vat.round());     // round where your policy says so
total.toJSON();                            // { amount: '97750.00', currency: 'BDT' }
```

- **Exact and unrounded by default.** `times` and `dividedBy` keep every digit. `round()` uses the currency's rounding
  unit and method, or the method you pass (`'half-up' | 'half-even' | 'up' | 'down'`).
- **Comparisons at currency precision:** `isZero()`, `isPositive()`, `equals()` and `compare()` compare rounded values
  (`Money.of('0.004', BDT).isZero()` is `true`). Use `equalsExactly()` for a raw comparison.
- **Currencies never mix.** `usd.plus(bdt)` throws `CurrencyMismatchError`, which tells you to convert with a dated rate.
- **Allocation keeps every unit.** `Money.of('1000', BDT).allocate([1, 1, 1])` gives `333.34 / 333.33 / 333.33`.
  The shares always add up exactly to the rounded total. They're computed with exact integer arithmetic, and ties go to the earliest share.

### Tax rounding, both policies

```ts
const lines = [Money.of('10.03', BDT), Money.of('10.03', BDT), Money.of('10.03', BDT)];

// round per line → 4.50
Money.sum(lines.map((l) => l.times('0.15').round()));

// round globally → 4.51, then spread back to lines so Σ line tax = invoice tax
const tax = Money.sum(lines).times('0.15').round();
tax.allocate(lines.map((l) => l.times('0.15').amount));   // 1.51, 1.50, 1.50
```

## Units of measure and Quantity

```ts
const UNIT = defineUom({ name: 'Units', category: 'Unit', ratio: '1', rounding: '1' });
const DOZEN = defineUom({ name: 'Dozens', category: 'Unit', ratio: '12', rounding: '0.01' });
const KG = defineUom({ name: 'kg', category: 'Weight', ratio: '1', rounding: '0.001' });

Quantity.of('3', DOZEN).to(UNIT);                          // 36 Units (exact)
Quantity.of('3', DOZEN).plus(Quantity.of('6', UNIT));      // ❌ UomMismatchError: convert with .to() first
Quantity.of('1', UNIT).to(KG);                             // ❌ IncompatibleUomCategoryError
Quantity.of('0.3', UNIT).round('up');                      // 1 Units (procurement rounds up)
```

## Errors

Every error extends `ShutroError` and has a `code` (`'CURRENCY_MISMATCH'`, `'INVALID_ALLOCATION'`, …) and a `hint`
that says how to fix it. The hint is also appended to `message`.

## Limits

- Exact up to **64 significant digits** per value and per intermediate result. That's far beyond any business amount
  (the property tests use values up to 10⁵⁰).
- Currency conversion (`env.fx`), `res.currency` records and locale formatting come with the environment and registry (RFCs 0003 and 0006 §7.7).
