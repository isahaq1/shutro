/** Machine-readable reason for a {@link ShutroError}. */
export type ShutroErrorCode =
  | 'NON_INTEGER_NUMBER'
  | 'INVALID_DECIMAL'
  | 'DIVISION_BY_ZERO'
  | 'INVALID_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_ALLOCATION'
  | 'MONEY_EMPTY_SUM'
  | 'INVALID_UOM'
  | 'UOM_MISMATCH'
  | 'UOM_CATEGORY_MISMATCH';

/**
 * Base class of every error raised by `@shutro/core`. The message says what went wrong and ends with
 * {@link ShutroError.hint}, which says how to fix it (`CLAUDE.md` coding rules).
 */
export class ShutroError extends Error {
  /** Machine-readable reason. */
  readonly code: ShutroErrorCode;
  /** How to fix the problem. Also included at the end of `message`. */
  readonly hint: string;

  constructor(code: ShutroErrorCode, problem: string, hint: string) {
    super(`${problem} ${hint}`);
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
  }
}

/** A JavaScript `number` that isn't a safe integer was used where an exact decimal is required. */
export class NonIntegerNumberError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('NON_INTEGER_NUMBER', problem, hint);
  }
}

/** A string or Decimal that isn't a finite decimal number. */
export class InvalidDecimalError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_DECIMAL', problem, hint);
  }
}

/** Division of a money amount or quantity by zero. */
export class DivisionByZeroError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('DIVISION_BY_ZERO', problem, hint);
  }
}

/** Invalid currency definition. */
export class InvalidCurrencyError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_CURRENCY', problem, hint);
  }
}

/** Arithmetic or comparison between amounts in different currencies (RFC 0006 R4). */
export class CurrencyMismatchError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('CURRENCY_MISMATCH', problem, hint);
  }
}

/** Invalid ratios passed to `Money.allocate()`. */
export class InvalidAllocationError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_ALLOCATION', problem, hint);
  }
}

/** `Money.sum([])` without a currency. */
export class EmptyMoneySumError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('MONEY_EMPTY_SUM', problem, hint);
  }
}

/** Invalid unit-of-measure definition. */
export class InvalidUomError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_UOM', problem, hint);
  }
}

/** Arithmetic or comparison between quantities in different units. */
export class UomMismatchError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('UOM_MISMATCH', problem, hint);
  }
}

/** Conversion between units of different categories (e.g. units to kilograms). */
export class IncompatibleUomCategoryError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('UOM_CATEGORY_MISMATCH', problem, hint);
  }
}
