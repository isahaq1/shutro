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
  InvalidFieldError,
  InvalidIdentityError,
  InvalidModelError,
  InvalidUomError,
  NoEnvironmentError,
  NonIntegerNumberError,
  ShutroError,
  type ShutroErrorCode,
  TransactionScopeError,
  UomMismatchError,
} from './errors.js';
export type { CreateOf, FlagsOfField, ReadOf, WriteOf } from './model/faces.js';
export {
  type BinaryField,
  type BinaryOptions,
  type CharField,
  type CharOptions,
  type CommonOptions,
  type ComputeFn,
  type DecimalField,
  type DecimalOptions,
  type Field,
  type FieldBase,
  type FieldBuilders,
  type FieldFlags,
  type FieldKind,
  type FieldTypes,
  type FlagsOf,
  type FloatField,
  f,
  type HtmlOptions,
  type IndexKind,
  type InverseFn,
  isField,
  type JsonField,
  type JsonOptions,
  type Many2manyField,
  type Many2manyOptions,
  type Many2oneField,
  type Many2oneOptions,
  type MonetaryField,
  type MonetaryOptions,
  type OnDelete,
  type One2manyField,
  type QuantityField,
  type QuantityOptions,
  type ScalarField,
  type SelectionField,
  type SelectionOptions,
  type StateField,
  type StateOptions,
  type TextOptions,
  type Transition,
  type X2ManyOptions,
} from './model/field.js';
export { asId, type Id, type X2ManyCommands } from './model/id.js';
export {
  type ActiveField,
  type AnyModel,
  type CompanyField,
  type CompanyScope,
  type ConstraintSpec,
  defineModel,
  type FieldDescription,
  type FieldRules,
  type FieldsRecord,
  humanize,
  type ImplicitFields,
  type ImplicitFieldsBase,
  type IndexSpec,
  isModel,
  type MethodsRecord,
  type Model,
  type ModelDefinition,
  type ModelDescription,
  type ModelFields,
  type OrderSpec,
  type OrderTerm,
  RESERVED_KEYS,
  type ReservedKey,
  type ResolvedConstraint,
  type ResolvedIndex,
  type ResolvedSqlConstraint,
  type SqlCheckConstraint,
  type SqlUniqueConstraint,
  snakeCase,
} from './model/model.js';
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
