/**
 * @packageDocumentation
 * `@shutro/core`: fields, `defineModel`, recordsets, environment, registry and compute engine (RFCs 0001–0004),
 * and the accounting-safe value types of RFC 0006.
 *
 * Implemented so far: `Decimal`, `Money`, `Currency`, `Quantity`, `Uom`.
 */
export {
  CurrencyMismatchError,
  DivisionByZeroError,
  EmptyMoneySumError,
  IncompatibleUomCategoryError,
  InvalidAllocationError,
  InvalidCurrencyError,
  InvalidDecimalError,
  InvalidUomError,
  NonIntegerNumberError,
  ShutroError,
  type ShutroErrorCode,
  UomMismatchError,
} from './errors.js';
export {
  type Currency,
  type CurrencyInput,
  defineCurrency,
  sameCurrency,
} from './money/currency.js';
export { Decimal, type DecimalInput, toDecimal } from './money/decimal.js';
export { Money, type MoneyJson } from './money/money.js';
export { defineUom, Quantity, type Uom, type UomInput } from './money/quantity.js';
export type { RoundingMethod } from './money/rounding.js';
