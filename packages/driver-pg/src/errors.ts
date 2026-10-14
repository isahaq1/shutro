import postgres from 'postgres';

/** Machine-readable reason for a {@link DriverError}. */
export type DriverErrorCode =
  | 'QUERY_FAILED'
  | 'CONSTRAINT_VIOLATION'
  | 'SERIALIZATION_FAILURE'
  | 'DEADLOCK'
  | 'STATEMENT_TIMEOUT'
  | 'LOCK_TIMEOUT'
  | 'READ_ONLY_TRANSACTION'
  | 'CONNECTION_FAILED'
  | 'BIGINT_OUT_OF_RANGE'
  | 'PARAM_IN_TEXT'
  | 'INVALID_SETTING';

/** Server-side details carried by a {@link DriverError}. */
export interface DriverErrorDetails {
  /** SQLSTATE, e.g. `'23505'`. */
  readonly sqlState?: string | undefined;
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly column?: string | undefined;
  /** PostgreSQL's DETAIL line, e.g. `Key (name)=(SO001) already exists.` */
  readonly detail?: string | undefined;
  /** The original error. */
  readonly cause?: unknown;
}

/**
 * Base class of every error raised by `@shutro/driver-pg`. Same convention as `ShutroError` in `@shutro/core`: the
 * message says what went wrong and ends with {@link DriverError.hint}, which says how to fix it.
 */
export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly hint: string;
  /** True when re-running the whole transaction may succeed (serialization failure, deadlock). */
  readonly retryable: boolean;
  readonly sqlState: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly detail: string | undefined;

  constructor(
    code: DriverErrorCode,
    problem: string,
    hint: string,
    details: DriverErrorDetails = {},
    retryable = false,
  ) {
    super(`${problem} ${hint}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
    this.sqlState = details.sqlState;
    this.constraint = details.constraint;
    this.table = details.table;
    this.column = details.column;
    this.detail = details.detail;
  }
}

/** Which kind of constraint was violated. */
export type ConstraintKind = 'unique' | 'foreign_key' | 'not_null' | 'check' | 'exclusion';

/** A unique, foreign-key, not-null, check or exclusion constraint was violated (SQLSTATE class 23). */
export class ConstraintViolationError extends DriverError {
  readonly kind: ConstraintKind;
  constructor(kind: ConstraintKind, problem: string, hint: string, details: DriverErrorDetails) {
    super('CONSTRAINT_VIOLATION', problem, hint, details);
    this.kind = kind;
  }
}

/** 40001: the transaction conflicted with a concurrent one. Retry the whole transaction. */
export class SerializationFailureError extends DriverError {
  constructor(details: DriverErrorDetails) {
    super(
      'SERIALIZATION_FAILURE',
      'The transaction conflicted with a concurrent transaction (serialization failure).',
      'Retry the whole transaction; shutro.run() does this automatically (RFC 0003 §7.5).',
      details,
      true,
    );
  }
}

/** 40P01: deadlock detected. Retry the whole transaction. */
export class DeadlockError extends DriverError {
  constructor(details: DriverErrorDetails) {
    super(
      'DEADLOCK',
      'The transaction was chosen as a deadlock victim.',
      'Retry the whole transaction; to avoid it, lock records in a consistent order (e.g. by id).',
      details,
      true,
    );
  }
}

/** 57014: the statement exceeded `statement_timeout`. */
export class StatementTimeoutError extends DriverError {
  constructor(details: DriverErrorDetails) {
    super(
      'STATEMENT_TIMEOUT',
      'The statement was cancelled because it exceeded statement_timeout.',
      'Add an index, process the data in smaller batches, or raise statementTimeoutMs for this transaction.',
      details,
    );
  }
}

/** 55P03: waiting for a lock exceeded `lock_timeout`. */
export class LockTimeoutError extends DriverError {
  constructor(details: DriverErrorDetails) {
    super(
      'LOCK_TIMEOUT',
      'Waiting for a lock exceeded lock_timeout.',
      'Another transaction holds the lock: retry later, use FOR UPDATE SKIP LOCKED for queues, or raise lockTimeoutMs.',
      details,
    );
  }
}

/** 25006: a write in a read-only transaction. */
export class ReadOnlyTransactionError extends DriverError {
  constructor(details: DriverErrorDetails) {
    super(
      'READ_ONLY_TRANSACTION',
      'A write was attempted in a read-only transaction.',
      'Run writes in a read-write transaction (readOnly: false), or move the write out of the report/replica code path.',
      details,
    );
  }
}

/** The server could not be reached, the connection broke, or authentication failed. */
export class ConnectionError extends DriverError {
  constructor(problem: string, hint: string, details: DriverErrorDetails) {
    super('CONNECTION_FAILED', problem, hint, details);
  }
}

/** Any other PostgreSQL error. */
export class QueryError extends DriverError {
  constructor(problem: string, hint: string, details: DriverErrorDetails) {
    super('QUERY_FAILED', problem, hint, details);
  }
}

const CONSTRAINT_KINDS: Readonly<Record<string, ConstraintKind>> = {
  '23505': 'unique',
  '23503': 'foreign_key',
  '23502': 'not_null',
  '23514': 'check',
  '23P01': 'exclusion',
};

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
]);

function constraintMessage(kind: ConstraintKind, d: DriverErrorDetails): readonly [string, string] {
  const on = d.table === undefined ? '' : ` on "${d.table}"`;
  const detail = d.detail === undefined ? '' : `${d.detail} `;
  switch (kind) {
    case 'unique':
      return [
        `A record with the same value already exists (unique constraint "${d.constraint ?? '?'}"${on}).`,
        `${detail}Use a different value, or update the existing record instead of creating a new one.`,
      ];
    case 'foreign_key':
      return [
        `The record references a missing record, or is still referenced (foreign key "${d.constraint ?? '?'}"${on}).`,
        `${detail}Check that the referenced record exists, or reassign or delete the records that reference it first.`,
      ];
    case 'not_null':
      return [
        `A required value is missing (column "${d.column ?? '?'}"${on}).`,
        'Provide a value, or give the field a default.',
      ];
    case 'check':
      return [
        `A value breaks the check constraint "${d.constraint ?? '?'}"${on}.`,
        `${detail}Correct the value so it satisfies the constraint.`,
      ];
    case 'exclusion':
      return [
        `The record overlaps an existing one (exclusion constraint "${d.constraint ?? '?'}"${on}).`,
        `${detail}Change the overlapping range or value.`,
      ];
  }
}

/**
 * Maps a postgres.js error to a typed {@link DriverError}. Anything else (including errors thrown by business
 * code and already-mapped errors) is returned unchanged.
 */
export function mapPostgresError(error: unknown): unknown {
  if (error instanceof DriverError) return error;
  if (error instanceof postgres.PostgresError) {
    const details: DriverErrorDetails = {
      sqlState: error.code,
      constraint: error.constraint_name,
      table: error.table_name,
      column: error.column_name,
      detail: error.detail,
      cause: error,
    };
    const kind = CONSTRAINT_KINDS[error.code];
    if (kind !== undefined) {
      const [problem, hint] = constraintMessage(kind, details);
      return new ConstraintViolationError(kind, problem, hint, details);
    }
    switch (error.code) {
      case '40001':
        return new SerializationFailureError(details);
      case '40P01':
        return new DeadlockError(details);
      case '57014':
        return new StatementTimeoutError(details);
      case '55P03':
        return new LockTimeoutError(details);
      case '25006':
        return new ReadOnlyTransactionError(details);
    }
    if (/^(08|28|57P0)/.test(error.code)) {
      return new ConnectionError(
        `PostgreSQL closed or refused the connection (${error.code}: ${error.message}).`,
        'Check credentials and that the server is running; the transaction outcome is unknown, so verify before retrying.',
        details,
      );
    }
    return new QueryError(
      `PostgreSQL error ${error.code}: ${error.message}.`,
      error.hint ?? 'See sqlState and detail; this usually means the SQL or the schema is wrong.',
      details,
    );
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && CONNECTION_CODES.has(code)) {
      return new ConnectionError(
        `Could not talk to PostgreSQL (${code}: ${error.message}).`,
        'Check that the server is running and reachable at the configured URL (host, port, firewall, PgBouncer).',
        { cause: error },
      );
    }
  }
  return error;
}

/** True when `error` is a {@link DriverError} worth retrying as a whole transaction. */
export function isRetryable(error: unknown): boolean {
  return error instanceof DriverError && error.retryable;
}
