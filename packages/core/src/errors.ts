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
  | 'UOM_CATEGORY_MISMATCH'
  | 'NO_ENVIRONMENT'
  | 'TRANSACTION_SCOPE'
  | 'CONCURRENT_UPDATE'
  | 'INVALID_IDENTITY'
  | 'COMPANY_NOT_ALLOWED'
  | 'FLAG_NOT_ALLOWED'
  | 'INVALID_FIELD'
  | 'INVALID_MODEL';

/**
 * Base class of every error raised by `@shutro/core`. The message says what went wrong and ends with
 * {@link ShutroError.hint}, which says how to fix it (`CLAUDE.md` coding rules).
 */
export class ShutroError extends Error {
  /** Machine-readable reason. */
  readonly code: ShutroErrorCode;
  /** How to fix the problem. Also included at the end of `message`. */
  readonly hint: string;

  constructor(
    code: ShutroErrorCode,
    problem: string,
    hint: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `${problem} ${hint}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
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

/** No environment is active (code ran outside `shutro.run()`), RFC 0003 §7.7. */
export class NoEnvironmentError extends ShutroError {
  constructor() {
    super(
      'NO_ENVIRONMENT',
      'No Shutro environment is active.',
      'Wrap the call in shutro.run({ user, company }, (env) => ...) or use the env of an existing recordset.',
    );
  }
}

/** An environment was used outside its transaction scope (RFC 0003 §7.7). */
export class TransactionScopeError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('TRANSACTION_SCOPE', problem, hint);
  }
}

/** Every retry of a transaction hit a serialization failure or deadlock (RFC 0003 §7.5). */
export class ConcurrentUpdateError extends ShutroError {
  constructor(attempts: number, cause: unknown) {
    super(
      'CONCURRENT_UPDATE',
      `The transaction conflicted with concurrent transactions on all ${attempts} attempts.`,
      'Reduce contention: lock records in a consistent order, keep transactions short, or process the data in smaller chunks (shutro.forEachChunk).',
      { cause },
    );
  }
}

/** Invalid user, company, language, time zone or reason passed to `shutro.run()` or a derived environment. */
export class InvalidIdentityError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_IDENTITY', problem, hint);
  }
}

/** `withCompany()` outside the user's allowed companies (RFC 0003 §7.2). */
export class CompanyNotAllowedError extends ShutroError {
  constructor(company: number, allowed: readonly number[]) {
    super(
      'COMPANY_NOT_ALLOWED',
      `Company ${company} is not among the allowed companies [${allowed.join(', ')}] of this environment.`,
      'Select the company in the session (allowed companies), or run the operation under env.asSuperuser({ reason }, ...) if it is a system task.',
    );
  }
}

/** A field definition that can't be right (RFC 0001): bad size, scale, selection, transition, relation option, ... */
export class InvalidFieldError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_FIELD', problem, hint);
  }
}

/** A model definition that can't be right (RFC 0001): reserved keys, column collisions, bad sibling references, ... */
export class InvalidModelError extends ShutroError {
  constructor(model: string, problem: string, hint: string) {
    super('INVALID_MODEL', `Model '${model}': ${problem}`, hint);
  }
}

/** A flag that only a superuser environment may change (RFC 0003 §7.4). */
export class FlagNotAllowedError extends ShutroError {
  constructor(flag: string) {
    super(
      'FLAG_NOT_ALLOWED',
      `The flag '${flag}' can only be changed in a superuser environment.`,
      'Disable it inside env.asSuperuser({ reason }, (su) => su.withFlags({ ... })), and only for system tasks such as migrations.',
    );
  }
}
