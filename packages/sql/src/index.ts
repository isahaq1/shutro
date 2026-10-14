/**
 * @packageDocumentation
 * Shutro's SQL layer (RFC 0005): an immutable SQL AST, the `sql` tagged template, and a compiler to parameterized
 * SQL. Values only ever travel as parameters; identifiers are validated and quoted.
 *
 * @example
 * ```ts
 * import { compile, sql } from '@shutro/sql';
 *
 * const q = sql`SELECT ${sql.id('id')} FROM ${sql.id('sale_order')} WHERE ${sql.id('state')} = ANY(${sql.array(states, 'text')})`;
 * compile(q); // { text: 'SELECT "id" FROM "sale_order" WHERE "state" = ANY($1::text[])', params: [states] }
 * ```
 */
export {
  type IdentNode,
  isSql,
  type ParamNode,
  type SeqNode,
  SqlFragment,
  type SqlNode,
  type TextNode,
  visit,
} from './ast.js';
export { type CompiledSql, compile, MAX_PARAMS } from './compile.js';
export { SqlError, type SqlErrorCode } from './errors.js';
export { type SqlTag, sql } from './tag.js';
