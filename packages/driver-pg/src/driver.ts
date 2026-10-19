import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';
import { DriverError, mapPostgresError } from './errors.js';

/** SQL ready to execute. `CompiledSql` from `@shutro/sql` satisfies this structurally. */
export interface DriverQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** A result row. */
export type Row = Record<string, unknown>;

/** Transaction isolation level. */
export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

/** Options for {@link Driver.transaction}. */
export interface TxOptions {
  /** Defaults to `repeatable read` (RFC 0003 §7.5). */
  readonly isolation?: Isolation;
  /** `BEGIN … READ ONLY`. Writes fail with `ReadOnlyTransactionError`. */
  readonly readOnly?: boolean;
  /** Session settings for this transaction only (`set_config(name, value, true)`), e.g. `{ 'shutro.user_id': '42' }`. */
  readonly settings?: Readonly<Record<string, string>>;
  /** `statement_timeout` for this transaction. */
  readonly statementTimeoutMs?: number;
  /** `lock_timeout` for this transaction. */
  readonly lockTimeoutMs?: number;
}

/** A connection inside a transaction (or savepoint). */
export interface DriverConnection {
  /** Runs one statement. */
  query<R extends Row = Row>(query: DriverQuery): Promise<readonly R[]>;
  /** Runs a query through a server-side cursor, yielding batches of at most `batchSize` rows (RFC 0004 §7.7). */
  stream<R extends Row = Row>(query: DriverQuery, batchSize: number): AsyncIterable<readonly R[]>;
  /** Runs `fn` in a savepoint: rolled back if `fn` throws (and the error rethrown), released otherwise. */
  savepoint<T>(fn: (conn: DriverConnection) => Promise<T>): Promise<T>;
  /** `COPY … FROM STDIN` with one text-format line per item (tab-separated). Returns the number of lines written. */
  copyIn(query: DriverQuery, lines: Iterable<string> | AsyncIterable<string>): Promise<number>;
}

/** The connection pool. */
export interface Driver {
  /** Pool size (`max`), when known: Shutro checks it against features that need a second connection. */
  readonly max?: number;
  /** Runs one statement in its own implicit transaction (DDL, maintenance). Business code uses `transaction()`. */
  query<R extends Row = Row>(query: DriverQuery): Promise<readonly R[]>;
  /**
   * Runs `fn` in a transaction: committed when `fn` resolves, rolled back when it throws. PostgreSQL errors are
   * mapped to typed `DriverError`s. Retrying is the caller's job (`isRetryable()`), because only the caller knows
   * that `fn` is safe to repeat.
   */
  transaction<T>(options: TxOptions, fn: (conn: DriverConnection) => Promise<T>): Promise<T>;
  /** `LISTEN` on a dedicated connection. Returns a function that stops listening. */
  listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  /** Closes all connections, waiting up to `timeoutSeconds` (default 5) for running queries. */
  end(options?: { readonly timeoutSeconds?: number }): Promise<void>;
}

/** Options for {@link createDriver}. */
export interface DriverOptions {
  /** `postgres://user:password@host:port/database`. */
  readonly url: string;
  /** Pool size. Defaults to 10. */
  readonly max?: number;
  /**
   * Parses `numeric` values (OID 1700) from their exact text form. `@shutro/core` passes `toDecimal`. Defaults to
   * returning the string unchanged, which is lossless.
   */
  readonly parseNumeric?: (text: string) => unknown;
  /** Named prepared statements (default `true`). Behind PgBouncer this needs `max_prepared_statements > 0` (≥ 1.21). */
  readonly prepare?: boolean;
  /**
   * Development guard (RFC 0007 §7.3): reject a query when a string parameter (8+ characters) also appears in its text,
   * which means the text was built by concatenation. Defaults to `true` unless `NODE_ENV === 'production'`.
   */
  readonly checkParamsInText?: boolean;
  /** Receives server NOTICE messages. Defaults to ignoring them (never `console`). */
  readonly onNotice?: (notice: Readonly<Record<string, unknown>>) => void;
  /** `application_name`, visible in `pg_stat_activity`. Defaults to `'shutro'`. */
  readonly applicationName?: string;
  readonly connectTimeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
}

const SETTING_NAME = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const MIN_GUARDED_LENGTH = 8;

/** bigint → number, refusing values that a JS number can't hold exactly (RFC 0001: ids are branded numbers). */
function parseBigint(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new DriverError(
      'BIGINT_OUT_OF_RANGE',
      `The bigint ${text} is beyond Number.MAX_SAFE_INTEGER and would lose precision as a JavaScript number.`,
      'Cast it to text or numeric in the query (e.g. col::text) if the column really holds such values.',
    );
  }
  return n;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_GUARDED_LENGTH) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  }
}

/** Quoted identifiers (`"purchase_order"`): `sql.id()` validates them, so a value inside one is not a leak. */
const QUOTED_IDENTIFIER = /"(?:[^"]|"")*"/g;

function guardParamsInText(query: DriverQuery): void {
  const strings: string[] = [];
  for (const p of query.params) collectStrings(p, strings);
  if (strings.length === 0) return;
  // A state 'purchase' written to "purchase_order" is a value equal to part of a table name, not concatenation.
  const text = query.text.replace(QUOTED_IDENTIFIER, '""');
  const leaked = strings.find((s) => text.includes(s));
  if (leaked !== undefined) {
    throw new DriverError(
      'PARAM_IN_TEXT',
      `A parameter value (${JSON.stringify(leaked.slice(0, 40))}) also appears in the SQL text, so the text was probably built by string concatenation.`,
      'Build queries with sql`...` from @shutro/sql so values only travel as parameters; set checkParamsInText: false only if the overlap is intentional.',
    );
  }
}

function settingsFor(options: TxOptions): readonly (readonly [string, string])[] {
  const entries: [string, string][] = Object.entries(options.settings ?? {});
  if (options.statementTimeoutMs !== undefined)
    entries.push(['statement_timeout', String(options.statementTimeoutMs)]);
  if (options.lockTimeoutMs !== undefined)
    entries.push(['lock_timeout', String(options.lockTimeoutMs)]);
  for (const [name, value] of entries) {
    if (!SETTING_NAME.test(name) || typeof value !== 'string') {
      throw new DriverError(
        'INVALID_SETTING',
        `${JSON.stringify(name)} is not a valid transaction setting.`,
        "Use lower-case names like 'statement_timeout' or a custom 'namespace.name' (e.g. 'shutro.user_id') with string values.",
      );
    }
  }
  return entries;
}

type Sql = postgres.Sql | postgres.TransactionSql;
type Params = postgres.ParameterOrJSON<never>[];

/**
 * Creates the PostgreSQL connection pool (postgres.js, RFC 0007). All type handling is configured on this instance;
 * no global state is touched.
 *
 * @example
 * ```ts
 * const driver = createDriver({ url: process.env.DATABASE_URL, parseNumeric: toDecimal });
 * await driver.transaction({ settings: { 'shutro.user_id': '42' } }, (conn) => conn.query(compile(q)));
 * ```
 */
export function createDriver(options: DriverOptions): Driver {
  const prepare = options.prepare ?? true;
  const guard = options.checkParamsInText ?? process.env['NODE_ENV'] !== 'production';
  const parseNumeric = options.parseNumeric ?? ((text: string): unknown => text);
  const sql = postgres(options.url, {
    max: options.max ?? 10,
    prepare,
    onnotice: options.onNotice ?? ((): void => {}),
    connection: { application_name: options.applicationName ?? 'shutro' },
    ...(options.connectTimeoutSeconds === undefined
      ? {}
      : { connect_timeout: options.connectTimeoutSeconds }),
    ...(options.idleTimeoutSeconds === undefined
      ? {}
      : { idle_timeout: options.idleTimeoutSeconds }),
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (v: unknown) => String(v),
        parse: parseNumeric,
      },
      bigint: { to: 20, from: [20], serialize: (v: unknown) => String(v), parse: parseBigint },
      // Calendar dates stay 'YYYY-MM-DD' strings: a JS Date would shift them by the time zone (RFC 0001 W7).
      calendar_date: {
        to: 1082,
        from: [1082],
        serialize: (v: unknown) => String(v),
        parse: (s: string) => s,
      },
    },
  });

  /**
   * postgres.js infers an array parameter's type from its first element, so an array of booleans is sent as a scalar
   * boolean (and a text array that the server resolves to boolean[] is serialized with the boolean serializer, giving
   * 'f' for anything but the value true). Declaring boolean arrays as boolean[] (OID 1000) avoids both.
   */
  const typed = (params: readonly unknown[]): Params =>
    params.map((p) =>
      Array.isArray(p) && p.some((v) => typeof v === 'boolean') ? sql.typed(p, 1000) : p,
    ) as Params;

  const run = async <R extends Row>(s: Sql, query: DriverQuery): Promise<readonly R[]> => {
    if (guard) guardParamsInText(query);
    try {
      return [...(await s.unsafe<R[]>(query.text, typed(query.params), { prepare }))];
    } catch (e) {
      throw mapPostgresError(e);
    }
  };

  const connection = (s: postgres.TransactionSql): DriverConnection => ({
    query: (query) => run(s, query),
    async *stream<R extends Row>(
      query: DriverQuery,
      batchSize: number,
    ): AsyncIterable<readonly R[]> {
      if (guard) guardParamsInText(query);
      try {
        for await (const rows of s
          .unsafe<R[]>(query.text, query.params as Params, { prepare })
          .cursor(batchSize)) {
          yield [...rows];
        }
      } catch (e) {
        throw mapPostgresError(e);
      }
    },
    async savepoint<T>(fn: (conn: DriverConnection) => Promise<T>): Promise<T> {
      return (await s.savepoint((sp) => fn(connection(sp)))) as T;
    },
    async copyIn(
      query: DriverQuery,
      lines: Iterable<string> | AsyncIterable<string>,
    ): Promise<number> {
      let count = 0;
      async function* withNewlines(): AsyncIterable<string> {
        for await (const line of lines) {
          count++;
          yield `${line}\n`;
        }
      }
      try {
        const writable = await s.unsafe(query.text, typed(query.params)).writable();
        await pipeline(Readable.from(withNewlines()), writable);
      } catch (e) {
        throw mapPostgresError(e);
      }
      return count;
    },
  });

  return {
    max: options.max ?? 10,
    query: (query) => run(sql, query),

    async transaction<T>(
      txOptions: TxOptions,
      fn: (conn: DriverConnection) => Promise<T>,
    ): Promise<T> {
      const settings = settingsFor(txOptions);
      const mode = `isolation level ${txOptions.isolation ?? 'repeatable read'}${txOptions.readOnly ? ' read only' : ''}`;
      try {
        return (await sql.begin(mode, async (tx) => {
          if (settings.length > 0) {
            // One round-trip for all settings: SELECT set_config($1, $2, true), set_config($3, $4, true), …
            const calls = settings
              .map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`)
              .join(', ');
            await tx.unsafe(`SELECT ${calls}`, settings.flat(), { prepare });
          }
          return fn(connection(tx));
        })) as T;
      } catch (e) {
        throw mapPostgresError(e);
      }
    },

    async listen(
      channel: string,
      onMessage: (payload: string) => void,
    ): Promise<() => Promise<void>> {
      try {
        const subscription = await sql.listen(channel, onMessage);
        return async () => {
          await subscription.unlisten();
        };
      } catch (e) {
        throw mapPostgresError(e);
      }
    },

    end: (endOptions) => sql.end({ timeout: endOptions?.timeoutSeconds ?? 5 }),
  };
}
