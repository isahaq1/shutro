/**
 * @packageDocumentation
 * `@shutro/driver-pg`: the PostgreSQL connection layer (RFC 0007). It wraps postgres.js behind a small interface
 * (`Driver`, `DriverConnection`). No other Shutro package imports postgres.js.
 */
export {
  createDriver,
  type Driver,
  type DriverConnection,
  type DriverOptions,
  type DriverQuery,
  type Isolation,
  type Row,
  type TxOptions,
} from './driver.js';
export {
  ConnectionError,
  type ConstraintKind,
  ConstraintViolationError,
  DeadlockError,
  DriverError,
  type DriverErrorCode,
  type DriverErrorDetails,
  isRetryable,
  LockTimeoutError,
  mapPostgresError,
  QueryError,
  ReadOnlyTransactionError,
  SerializationFailureError,
  StatementTimeoutError,
} from './errors.js';
