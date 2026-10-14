import postgres from 'postgres';
import { describe, expect, test } from 'vitest';
import {
  ConnectionError,
  ConstraintViolationError,
  DeadlockError,
  DriverError,
  isRetryable,
  LockTimeoutError,
  mapPostgresError,
  QueryError,
  ReadOnlyTransactionError,
  SerializationFailureError,
  StatementTimeoutError,
} from '../src/index.js';

/** A PostgresError as postgres.js produces it. */
function pgError(fields: Record<string, string>): postgres.PostgresError {
  const PostgresError = postgres.PostgresError as unknown as new (
    x: Record<string, string>,
  ) => postgres.PostgresError;
  return new PostgresError({ severity: 'ERROR', message: 'server message', ...fields });
}

describe('mapPostgresError', () => {
  test.each([
    ['23505', 'unique'],
    ['23503', 'foreign_key'],
    ['23502', 'not_null'],
    ['23514', 'check'],
    ['23P01', 'exclusion'],
  ])('%s → ConstraintViolationError (%s)', (code, kind) => {
    const e = mapPostgresError(
      pgError({
        code,
        constraint_name: 'sale_order_name_key',
        table_name: 'sale_order',
        column_name: 'partner_id',
        detail: 'Key (name)=(SO001) already exists.',
      }),
    );
    expect(e).toBeInstanceOf(ConstraintViolationError);
    const err = e as ConstraintViolationError;
    expect(err).toMatchObject({
      code: 'CONSTRAINT_VIOLATION',
      kind,
      sqlState: code,
      constraint: 'sale_order_name_key',
      table: 'sale_order',
      retryable: false,
    });
    // not-null names the missing column; the others name the constraint
    expect(err.message).toContain(kind === 'not_null' ? 'partner_id' : 'sale_order_name_key');
    expect(err.message).toContain(err.hint);
    expect(err.cause).toBeInstanceOf(postgres.PostgresError);
  });

  test.each([
    ['40001', SerializationFailureError, 'SERIALIZATION_FAILURE', true],
    ['40P01', DeadlockError, 'DEADLOCK', true],
    ['57014', StatementTimeoutError, 'STATEMENT_TIMEOUT', false],
    ['55P03', LockTimeoutError, 'LOCK_TIMEOUT', false],
    ['25006', ReadOnlyTransactionError, 'READ_ONLY_TRANSACTION', false],
    ['42P01', QueryError, 'QUERY_FAILED', false],
  ] as const)('%s → %o', (sqlState, Class, code, retryable) => {
    const e = mapPostgresError(pgError({ code: sqlState }));
    expect(e).toBeInstanceOf(Class);
    expect(e).toBeInstanceOf(DriverError);
    expect(e).toMatchObject({ code, sqlState, retryable });
    expect(isRetryable(e)).toBe(retryable);
  });

  test('connection-level errors from postgres.js', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const e = mapPostgresError(refused);
    expect(e).toBeInstanceOf(ConnectionError);
    expect((e as ConnectionError).hint).toMatch(/running|reachable/i);
    const closed = Object.assign(new Error('write CONNECTION_CLOSED'), {
      code: 'CONNECTION_CLOSED',
    });
    expect(mapPostgresError(closed)).toBeInstanceOf(ConnectionError);
  });

  test('anything else is returned unchanged', () => {
    const own = new TypeError('business logic bug');
    expect(mapPostgresError(own)).toBe(own);
    expect(mapPostgresError('string')).toBe('string');
    expect(isRetryable(own)).toBe(false);
  });

  test('already-mapped errors pass through', () => {
    const mapped = mapPostgresError(pgError({ code: '40001' }));
    expect(mapPostgresError(mapped)).toBe(mapped);
  });
});
