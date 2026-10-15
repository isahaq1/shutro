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
  | 'INVALID_MODEL'
  | 'INVALID_MODULE'
  | 'DUPLICATE_MODULE'
  | 'DUPLICATE_MODEL'
  | 'UNDECLARED_DEPENDENCY'
  | 'UNKNOWN_MODEL'
  | 'INVALID_RELATION'
  | 'INVALID_DEPENDS_PATH'
  | 'FIELD_NOT_LOADED'
  | 'SINGLETON'
  | 'MISSING_RECORD'
  | 'INVALID_DOMAIN'
  | 'NO_REGISTRY'
  | 'VALIDATION';

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

/** A module definition that can't be right (RFC 0002 §7.1). */
export class InvalidModuleError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_MODULE', problem, hint);
  }
}

/** Two different module objects share a name (e.g. two copies of `base` from different package versions). */
export class DuplicateModuleError extends ShutroError {
  constructor(name: string) {
    super(
      'DUPLICATE_MODULE',
      `Two different modules are named '${name}'.`,
      'Modules are identified by name; dedupe the package (one version of each module) or rename one of them.',
    );
  }
}

/** The same model name is defined twice (in one module or in two). */
export class DuplicateModelError extends ShutroError {
  constructor(model: string, modules: readonly string[]) {
    super(
      'DUPLICATE_MODEL',
      `Model '${model}' is defined more than once (in ${modules.map((m) => `'${m}'`).join(' and ')}).`,
      'A model has exactly one owner; extend it from the other module with extendModel() instead of defining it again.',
    );
  }
}

/** A module references a model owned by a module it doesn't depend on (RFC 0002 W2). */
export class UndeclaredDependencyError extends ShutroError {
  constructor(module: string, model: string, owner: string, via: string) {
    super(
      'UNDECLARED_DEPENDENCY',
      `Module '${module}' references '${model}' (owned by '${owner}') in ${via}, but does not depend on '${owner}'.`,
      `Add the '${owner}' module to the depends of '${module}'. Only models of a module and its transitive dependencies may be referenced.`,
    );
  }
}

/** A model name that no loaded module defines. */
export class UnknownModelError extends ShutroError {
  constructor(model: string, via: string | undefined) {
    super(
      'UNKNOWN_MODEL',
      via === undefined
        ? `No loaded module defines model '${model}'.`
        : `${via} refers to model '${model}', which no loaded module defines.`,
      'Check the model name, and make sure the module that defines it is loaded (directly or as a dependency).',
    );
  }
}

/** A one2many whose inverse field doesn't point back, or another broken relation. */
export class InvalidRelationError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_RELATION', problem, hint);
  }
}

/** A `depends` path that doesn't resolve through real fields. */
export class InvalidDependsPathError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_DEPENDS_PATH', problem, hint);
  }
}

/** A field was read before it was loaded (RFC 0004 §7.1). */
export class FieldNotLoadedError extends ShutroError {
  constructor(model: string, field: string, hint: string) {
    super('FIELD_NOT_LOADED', `${model}.${field} is not loaded.`, hint);
  }
}

/** `first()` on an empty recordset, or `ensureOne()` on a recordset that isn't exactly one record. */
export class SingletonError extends ShutroError {
  constructor(model: string, count: number, what: 'first' | 'ensureOne') {
    super(
      'SINGLETON',
      `${what}() expected one ${model} record but the recordset has ${count}.`,
      what === 'first'
        ? 'Check isEmpty() first, or use a search that returns at least one record.'
        : 'Narrow the search, or iterate the recordset when several records are expected.',
    );
  }
}

/** A browsed id that doesn't exist (or isn't visible). */
export class MissingRecordError extends ShutroError {
  constructor(model: string, ids: readonly number[]) {
    super(
      'MISSING_RECORD',
      `${model} record(s) ${ids.join(', ')} do not exist or are not accessible.`,
      'The id may come from stale data or another company; search for the record instead of browsing a remembered id.',
    );
  }
}

/** A search domain that can't be compiled (RFC 0005 §7.1). */
export class InvalidDomainError extends ShutroError {
  constructor(problem: string, hint: string) {
    super('INVALID_DOMAIN', problem, hint);
  }
}

/** `env.model()` on a Shutro instance created without a registry. */
export class NoRegistryError extends ShutroError {
  constructor() {
    super(
      'NO_REGISTRY',
      'This Shutro instance has no registry, so there are no models.',
      'Pass registry: buildRegistry({ modules }) to createShutro().',
    );
  }
}

/** Values rejected by `create()` / `write()`: missing required fields, unknown or readonly fields, wrong types (RFC 0001 §7.7). */
export class ValidationError extends ShutroError {
  readonly model: string;
  /** The offending field keys. */
  readonly fields: readonly string[];
  constructor(model: string, fields: readonly string[], problem: string, hint: string) {
    super('VALIDATION', `${model}: ${problem}`, hint);
    this.model = model;
    this.fields = Object.freeze([...fields]);
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
