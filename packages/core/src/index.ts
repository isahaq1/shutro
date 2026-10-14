/**
 * @packageDocumentation
 * `@shutro/core`: fields, `defineModel`, recordsets, environment, registry and compute engine (RFCs 0001–0004),
 * and the accounting-safe value types of RFC 0006.
 *
 * Implemented so far: the value types (`Decimal`, `Money`, `Currency`, `Quantity`, `Uom`) and the environment &
 * transaction context (`createShutro`, `Env`).
 */
export {
  createShutro,
  Env,
  type Flags,
  type Hook,
  type RunOptions,
  type Shutro,
  type ShutroOptions,
} from './env/env.js';
export type { Identity, ResolvedIdentity } from './env/identity.js';
export { assertTimeZone, calendarDateIn } from './env/time.js';
export {
  CompanyNotAllowedError,
  ConcurrentUpdateError,
  CurrencyMismatchError,
  DivisionByZeroError,
  EmptyMoneySumError,
  FlagNotAllowedError,
  IncompatibleUomCategoryError,
  InvalidAllocationError,
  InvalidCurrencyError,
  InvalidDecimalError,
  InvalidIdentityError,
  InvalidUomError,
  NoEnvironmentError,
  NonIntegerNumberError,
  ShutroError,
  type ShutroErrorCode,
  TransactionScopeError,
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
