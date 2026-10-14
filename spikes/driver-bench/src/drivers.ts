/**
 * Thin adapters with the surface @shutro/driver-pg needs, so the checks and benchmarks run identically on both drivers.
 * Both are configured per instance; neither touches the driver's global type registry.
 */
import { createHash } from 'node:crypto';
import { Decimal as DecimalJs } from 'decimal.js';
import pg from 'pg';
import postgres from 'postgres';

/**
 * Isolated decimal.js constructor (RFC 0006 §6: never mutate the global config).
 * Precision 64, not RFC 0006's original 40: K1 showed sums of 42-digit values rounding at 40 significant digits.
 */
export const Decimal: typeof DecimalJs = DecimalJs.clone({
  precision: 64,
  rounding: DecimalJs.ROUND_HALF_UP,
});
export type Decimal = DecimalJs;

/** bigint → number with an overflow guard (RFC 0001 Q2). */
export function toSafeId(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`bigint ${text} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
}

export type Row = Record<string, unknown>;
export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

/** Driver errors normalized to the fields Shutro maps into typed errors. */
export interface DbError {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly detail: string | undefined;
}

export interface Conn {
  query<R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<R[]>;
  savepoint<T>(fn: (conn: Conn) => Promise<T>): Promise<T>;
}

export interface Driver {
  readonly name: 'postgres' | 'pg';
  query<R extends Row = Row>(text: string, params?: readonly unknown[]): Promise<R[]>;
  transaction<T>(isolation: Isolation, fn: (conn: Conn) => Promise<T>): Promise<T>;
  listen(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>;
  /** COPY FROM STDIN of tab-separated lines; undefined when the driver has no built-in support. */
  readonly copyIn: ((sql: string, lines: readonly string[]) => Promise<void>) | undefined;
  normalizeError(e: unknown): DbError;
  end(): Promise<void>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const field = (e: unknown, key: string): unknown =>
  typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[key] : undefined;

// ---------------------------------------------------------------------------------------------------- postgres.js

export function postgresJs(url: string, max = 10): Driver {
  const sql = postgres(url, {
    max,
    prepare: true,
    onnotice: () => {},
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (v: unknown) => String(v),
        parse: (s: string) => new Decimal(s),
      },
      bigint: { to: 20, from: [20], serialize: (v: unknown) => String(v), parse: toSafeId },
    },
  });
  type Sql = postgres.Sql | postgres.TransactionSql;
  const run = async <R extends Row>(
    s: Sql,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> => [
    ...(await s.unsafe<R[]>(text, params as postgres.ParameterOrJSON<never>[], { prepare: true })),
  ];
  const conn = (s: postgres.TransactionSql): Conn => ({
    query: (text, params) => run(s, text, params),
    savepoint: (fn) => s.savepoint((sp) => fn(conn(sp))) as Promise<never>,
  });
  return {
    name: 'postgres',
    query: (text, params) => run(sql, text, params),
    transaction: (isolation, fn) =>
      sql.begin(`isolation level ${isolation}`, (tx) => fn(conn(tx))) as Promise<never>,
    async listen(channel, onMessage) {
      const sub = await sql.listen(channel, onMessage);
      return () => sub.unlisten();
    },
    async copyIn(text, lines) {
      const stream = await sql.unsafe(text).writable();
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.on('finish', resolve);
        for (const line of lines) stream.write(`${line}\n`);
        stream.end();
      });
    },
    normalizeError: (e) => ({
      code: str(field(e, 'code')),
      constraint: str(field(e, 'constraint_name')),
      table: str(field(e, 'table_name')),
      detail: str(field(e, 'detail')),
    }),
    end: () => sql.end({ timeout: 5 }),
  };
}

// ---------------------------------------------------------------------------------------------------------- pg

export function nodePg(url: string, max = 10): Driver {
  const builtins = pg.types;
  const pool = new pg.Pool({
    connectionString: url,
    max,
    // Per-pool parsers (pg's `types` option), instead of mutating pg.types globally.
    types: {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
        if (oid === 1700) return (s: string) => new Decimal(s);
        if (oid === 20) return toSafeId;
        return builtins.getTypeParser(oid, format ?? 'text');
      }) as typeof builtins.getTypeParser,
    },
  });
  // Named statements keep SQL text stable and parsed once per connection (also through PgBouncer >= 1.21).
  const named = (text: string): string =>
    `s_${createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
  // pg would JSON.stringify a Decimal (giving a quoted string), so serialize Decimals, including inside arrays.
  const encodeOne = (p: unknown): unknown =>
    p instanceof DecimalJs ? p.toString() : Array.isArray(p) ? p.map(encodeOne) : p;
  const encode = (params: readonly unknown[]): unknown[] => params.map(encodeOne);
  const run = async <R extends Row>(
    c: pg.Pool | pg.PoolClient,
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> => (await c.query<R>({ text, values: encode(params), name: named(text) })).rows;

  let savepoints = 0;
  const conn = (client: pg.PoolClient): Conn => ({
    query: (text, params) => run(client, text, params),
    async savepoint(fn) {
      const name = `sp_${++savepoints}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(conn(client));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw e;
      }
    },
  });

  return {
    name: 'pg',
    query: (text, params) => run(pool, text, params),
    async transaction(isolation, fn) {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
        const result = await fn(conn(client));
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async listen(channel, onMessage) {
      const client = await pool.connect();
      client.on('notification', (n) => {
        if (n.channel === channel) onMessage(n.payload ?? '');
      });
      await client.query(`LISTEN "${channel.replaceAll('"', '""')}"`);
      return async () => {
        await client.query(`UNLISTEN "${channel.replaceAll('"', '""')}"`);
        client.release();
      };
    },
    copyIn: undefined, // needs the separate pg-copy-streams package
    normalizeError: (e) => ({
      code: str(field(e, 'code')),
      constraint: str(field(e, 'constraint')),
      table: str(field(e, 'table')),
      detail: str(field(e, 'detail')),
    }),
    end: () => pool.end(),
  };
}

export const drivers = { postgres: postgresJs, pg: nodePg } as const;
export type DriverName = keyof typeof drivers;
