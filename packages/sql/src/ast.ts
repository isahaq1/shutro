/**
 * The SQL AST shared by every Shutro front-end (the `sql` tag now; the typed builder and domains later, RFC 0005 §6).
 * Nodes are immutable. Text nodes can only come from template-literal strings written in source code.
 */

/** Literal SQL text, taken verbatim from a template literal. Never built from runtime values. */
export interface TextNode {
  readonly kind: 'text';
  readonly text: string;
}

/** A bound value, rendered as `$n` (with `::cast` when given). The value itself never reaches the SQL text. */
export interface ParamNode {
  readonly kind: 'param';
  readonly value: unknown;
  /** Validated PostgreSQL type, e.g. `numeric` or `bigint[]`. */
  readonly cast: string | undefined;
}

/** A validated, always-quoted identifier, optionally qualified (`"so"."amount_total"`). */
export interface IdentNode {
  readonly kind: 'ident';
  readonly parts: readonly string[];
}

/** A sequence of nodes rendered one after another. */
export interface SeqNode {
  readonly kind: 'seq';
  readonly nodes: readonly SqlNode[];
}

/** Any node of the SQL AST. */
export type SqlNode = TextNode | ParamNode | IdentNode | SeqNode;

const token: unique symbol = Symbol('SqlFragment');

/**
 * Every fragment this module created. `instanceof` alone can be fooled with `Object.create(SqlFragment.prototype)`,
 * which would let arbitrary text through as SQL, so authenticity is checked here.
 */
const genuine = new WeakSet<object>();

/**
 * A piece of SQL: an immutable AST node. Created only by the `sql` tag and its helpers, so its text parts are
 * guaranteed to come from source code. Compile it with `compile()`.
 */
export class SqlFragment {
  /** The fragment's AST. */
  readonly node: SqlNode;

  /** @internal Use the `sql` tag instead. */
  constructor(key: typeof token, node: SqlNode) {
    if (key !== token) throw new TypeError('SqlFragment is created by the sql tag, not directly.');
    this.node = node;
    Object.freeze(this);
    genuine.add(this);
  }
}

/** @internal */
export function fragment(node: SqlNode): SqlFragment {
  return new SqlFragment(token, Object.freeze(node));
}

/** True when `value` is a {@link SqlFragment} created by this package (forgeries are rejected). */
export function isSql(value: unknown): value is SqlFragment {
  return typeof value === 'object' && value !== null && genuine.has(value);
}

/**
 * Walks the AST depth-first in rendering order, calling `visitor` for every node (parents before children).
 * Used, for example, to find every table a query touches (RFC 0005 §7.7).
 */
export function visit(root: SqlFragment | SqlNode, visitor: (node: SqlNode) => void): void {
  const walk = (node: SqlNode): void => {
    visitor(node);
    if (node.kind === 'seq') for (const child of node.nodes) walk(child);
  };
  walk(isSql(root) ? root.node : root);
}
