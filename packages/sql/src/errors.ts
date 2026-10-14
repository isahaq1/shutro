/** Machine-readable reason for a {@link SqlError}. */
export type SqlErrorCode =
  | 'SQL_NOT_A_TEMPLATE'
  | 'SQL_NOT_A_FRAGMENT'
  | 'SQL_UNDEFINED_PARAM'
  | 'SQL_INVALID_NUMBER'
  | 'SQL_INVALID_PARAM'
  | 'SQL_INVALID_IDENTIFIER'
  | 'SQL_INVALID_TYPE'
  | 'SQL_TOO_MANY_PARAMS'
  | 'SQL_EMPTY_SELECT'
  | 'SQL_EMPTY_VALUES'
  | 'SQL_INVALID_OPERATOR';

/**
 * Raised when a SQL fragment can't be built or compiled safely. The message says what went wrong, and
 * {@link SqlError.hint} says how to fix it.
 */
export class SqlError extends Error {
  /** Machine-readable reason. */
  readonly code: SqlErrorCode;
  /** How to fix the problem. Also included at the end of `message`. */
  readonly hint: string;

  constructor(code: SqlErrorCode, problem: string, hint: string) {
    super(`${problem} ${hint}`);
    this.name = 'SqlError';
    this.code = code;
    this.hint = hint;
  }
}
