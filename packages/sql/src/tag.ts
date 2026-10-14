import { fragment, isSql, type SqlFragment, type SqlNode } from './ast.js';
import { SqlError } from './errors.js';

/** PostgreSQL keeps the first 63 bytes of an identifier (NAMEDATALEN - 1). */
const MAX_IDENTIFIER_LENGTH = 63;
/** Lower-case snake_case, matching Shutro's naming (RFC 0001 §7.5). */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
/** Type names such as `numeric`, `numeric(20, 6)`, `timestamp with time zone`. Arrays only through `sql.array`. */
const TYPE_NAME = /^[a-z_][a-z0-9_]*( [a-z_][a-z0-9_]*)*(\(\d+(, ?\d+)?\))?$/;

function checkValue(value: unknown): void {
  if (value === undefined) {
    throw new SqlError(
      'SQL_UNDEFINED_PARAM',
      'A SQL parameter is undefined.',
      'Pass null for SQL NULL; undefined usually means a missing property or variable.',
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new SqlError(
      'SQL_INVALID_NUMBER',
      `A SQL parameter is ${value}.`,
      'Only finite numbers can be sent. Check the calculation, or pass null.',
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new SqlError(
      'SQL_INVALID_PARAM',
      `A SQL parameter is a ${typeof value}.`,
      'Interpolate a value (string, number, bigint, boolean, null, Date, Uint8Array, array) or a sql fragment.',
    );
  }
  if (Array.isArray(value)) for (const item of value) checkValue(item);
}

function param(value: unknown, cast: string | undefined): SqlNode {
  checkValue(value);
  return Object.freeze({ kind: 'param', value, cast });
}

function checkType(type: string): string {
  if (type.length > 64 || !TYPE_NAME.test(type)) {
    throw new SqlError(
      'SQL_INVALID_TYPE',
      `${JSON.stringify(type)} is not a valid PostgreSQL type name for a cast.`,
      'Use a plain type such as numeric, numeric(20, 6), bigint or timestamp with time zone; use sql.array() for arrays.',
    );
  }
  return type;
}

function isTemplate(strings: unknown, values: readonly unknown[]): strings is TemplateStringsArray {
  return (
    Array.isArray(strings) &&
    Object.isFrozen(strings) &&
    Array.isArray((strings as { raw?: unknown }).raw) &&
    strings.length === values.length + 1 &&
    strings.every((s) => typeof s === 'string')
  );
}

/** The `sql` tagged template and its helpers. */
export interface SqlTag {
  /**
   * Builds a SQL fragment. Template text is SQL; every `${value}` becomes a bound parameter (`$n`), except
   * fragments, which are inlined. Values never become SQL text.
   *
   * @example
   * ```ts
   * sql`SELECT ${sql.id('name')} FROM ${sql.id('res_partner')} WHERE ${sql.id('id')} = ${partnerId}`
   * // → { text: 'SELECT "name" FROM "res_partner" WHERE "id" = $1', params: [partnerId] }
   * ```
   * @throws {SqlError} `SQL_NOT_A_TEMPLATE` if not called as a tagged template; `SQL_UNDEFINED_PARAM`,
   * `SQL_INVALID_NUMBER` or `SQL_INVALID_PARAM` for values that can't be sent.
   */
  (strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment;

  /**
   * A quoted identifier, optionally qualified: `sql.id('so', 'amount_total')` → `"so"."amount_total"`.
   * Each part must be lower-case snake_case, at most 63 characters.
   * @throws {SqlError} `SQL_INVALID_IDENTIFIER`
   */
  id(...parts: readonly string[]): SqlFragment;

  /**
   * A parameter with an explicit cast: `sql.param('1.50', 'numeric')` → `$1::numeric`.
   * @throws {SqlError} `SQL_INVALID_TYPE`, or the value errors of the tag.
   */
  param(value: unknown, type: string): SqlFragment;

  /**
   * One array parameter with an element type: `sql.array(ids, 'bigint')` → `$1::bigint[]`. The SQL text stays the same
   * whatever the array length (stable prepared statements, RFC 0005 R6).
   * @throws {SqlError} `SQL_INVALID_PARAM` if `values` is not an array, `SQL_INVALID_TYPE`, or the value errors of the tag.
   */
  array(values: readonly unknown[], elementType: string): SqlFragment;

  /**
   * Joins fragments with a separator (default `, `). Joining an empty list renders nothing.
   * @throws {SqlError} `SQL_NOT_A_FRAGMENT` if an item is not a fragment.
   */
  join(fragments: readonly SqlFragment[], separator?: SqlFragment): SqlFragment;

  /** A fragment that renders nothing. */
  readonly empty: SqlFragment;
}

function tag(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment {
  if (!isTemplate(strings, values)) {
    throw new SqlError(
      'SQL_NOT_A_TEMPLATE',
      'sql was called with something other than a template literal.',
      'Write sql`...` with the SQL in the template; put runtime values in template placeholders so they become parameters.',
    );
  }
  const nodes: SqlNode[] = [];
  strings.forEach((text, i) => {
    if (text !== '') nodes.push(Object.freeze({ kind: 'text', text }));
    if (i < values.length) {
      const value = values[i];
      nodes.push(isSql(value) ? value.node : param(value, undefined));
    }
  });
  return fragment({ kind: 'seq', nodes: Object.freeze(nodes) });
}

const COMMA = tag`, `;

export const sql: SqlTag = Object.assign(tag, {
  id(...parts: readonly string[]): SqlFragment {
    if (parts.length === 0) {
      throw new SqlError(
        'SQL_INVALID_IDENTIFIER',
        'sql.id() was called without a name.',
        'Pass at least one identifier part.',
      );
    }
    for (const part of parts) {
      if (
        typeof part !== 'string' ||
        part.length > MAX_IDENTIFIER_LENGTH ||
        !IDENTIFIER.test(part)
      ) {
        throw new SqlError(
          'SQL_INVALID_IDENTIFIER',
          `${JSON.stringify(part)} is not a valid identifier.`,
          `Use lower-case snake_case (a-z, 0-9, _), starting with a letter or _, at most ${MAX_IDENTIFIER_LENGTH} characters. Identifiers must come from the registry, never from user input.`,
        );
      }
    }
    return fragment({ kind: 'ident', parts: Object.freeze([...parts]) });
  },

  param(value: unknown, type: string): SqlFragment {
    return fragment(param(value, checkType(type)));
  },

  array(values: readonly unknown[], elementType: string): SqlFragment {
    if (!Array.isArray(values)) {
      throw new SqlError(
        'SQL_INVALID_PARAM',
        `sql.array() expects an array, got ${typeof values}.`,
        'Pass an array of values; use sql.param() for a single value.',
      );
    }
    return fragment(param(values, `${checkType(elementType)}[]`));
  },

  join(fragments: readonly SqlFragment[], separator: SqlFragment = COMMA): SqlFragment {
    if (!isSql(separator)) {
      throw new SqlError(
        'SQL_NOT_A_FRAGMENT',
        'The sql.join() separator is not a sql fragment.',
        'Pass the separator as sql`...`, e.g. sql` AND `.',
      );
    }
    const nodes: SqlNode[] = [];
    fragments.forEach((f, i) => {
      if (!isSql(f)) {
        throw new SqlError(
          'SQL_NOT_A_FRAGMENT',
          `sql.join() item ${i} is not a sql fragment.`,
          'Wrap each item with sql`...` (values inside become parameters).',
        );
      }
      if (i > 0) nodes.push(separator.node);
      nodes.push(f.node);
    });
    return fragment({ kind: 'seq', nodes: Object.freeze(nodes) });
  },

  empty: fragment({ kind: 'seq', nodes: Object.freeze([]) }),
});
