/**
 * Expressions of the typed query builder (RFC 0005 §7.7). Every expression is a `sql` fragment underneath, so values
 * can only ever become parameters.
 */
import { isSql, type SqlFragment } from '../ast.js';
import { SqlError } from '../errors.js';
import { sql } from '../tag.js';

/** A typed SQL expression. `T` is the type of the value it produces. */
export interface Expression<T> {
  readonly '~expr': true;
  /** Phantom. */
  readonly '~type'?: T;
  readonly fragment: SqlFragment;
  /** Names the expression in a select list. */
  as<A extends string>(alias: A): AliasedExpression<T, A>;
}

/** An expression with an output name. */
export interface AliasedExpression<T, A extends string> {
  readonly expression: Expression<T>;
  readonly alias: A;
}

/** Anything with a `fragment()`: a sub-query usable in `exists` / `in`. */
export interface Fragmentable {
  fragment(): SqlFragment;
}

class Expr<T> implements Expression<T> {
  readonly '~expr' = true as const;
  readonly fragment: SqlFragment;
  constructor(fragment: SqlFragment) {
    this.fragment = fragment;
    Object.freeze(this);
  }
  as<A extends string>(alias: A): AliasedExpression<T, A> {
    sql.id(alias);
    return Object.freeze({ expression: this, alias });
  }
}

/** Wraps a fragment as an expression. */
export function expr<T>(fragment: SqlFragment): Expression<T> {
  return new Expr<T>(fragment);
}

/** True for expressions made by this module. */
export function isExpression(value: unknown): value is Expression<unknown> {
  return value instanceof Expr;
}

function isFragmentable(value: unknown): value is Fragmentable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Fragmentable).fragment === 'function'
  );
}

/** `"so"."name"` from `'so.name'`, `"name"` from `'name'`. Validates every part like `sql.id`. */
export function columnRef(ref: string): SqlFragment {
  if (typeof ref !== 'string') {
    throw new SqlError(
      'SQL_INVALID_IDENTIFIER',
      'A column reference must be a string.',
      "Use 'column' or 'alias.column'.",
    );
  }
  return sql.id(...ref.split('.'));
}

/** Comparison and pattern operators that take a value or expression on the right. */
export type ValueOperator =
  | '='
  | '<>'
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'like'
  | 'ilike'
  | 'not like'
  | 'not ilike'
  | 'is distinct from'
  | 'is not distinct from';
/** Membership operators: right side is an array (one parameter) or a sub-query. */
export type ListOperator = 'in' | 'not in';
/** Null / boolean tests. */
export type NullOperator = 'is' | 'is not';
/** Every operator. */
export type Operator = ValueOperator | ListOperator | NullOperator;

/** Operator keywords as fragments, so no runtime string ever becomes SQL text. */
const OPERATORS: Readonly<Record<ValueOperator, SqlFragment>> = {
  '=': sql`=`,
  '<>': sql`<>`,
  '!=': sql`<>`,
  '<': sql`<`,
  '<=': sql`<=`,
  '>': sql`>`,
  '>=': sql`>=`,
  like: sql`LIKE`,
  ilike: sql`ILIKE`,
  'not like': sql`NOT LIKE`,
  'not ilike': sql`NOT ILIKE`,
  'is distinct from': sql`IS DISTINCT FROM`,
  'is not distinct from': sql`IS NOT DISTINCT FROM`,
};

const TRUE: SqlFragment = sql`TRUE`;
const FALSE: SqlFragment = sql`FALSE`;

function operand(value: unknown): SqlFragment {
  if (isExpression(value)) return value.fragment;
  if (isSql(value)) return value;
  return sql`${value}`;
}

/** Builds `lhs <op> rhs` with the operator's semantics (arrays as one parameter, null tests, sub-queries). */
export function compare(
  lhs: string | Expression<unknown>,
  op: Operator,
  rhs: unknown,
): Expression<boolean> {
  const left = typeof lhs === 'string' ? columnRef(lhs) : lhs.fragment;
  if (op === 'in' || op === 'not in') {
    if (Array.isArray(rhs)) {
      if (rhs.length === 0) return expr(op === 'in' ? FALSE : TRUE);
      return expr(op === 'in' ? sql`${left} = ANY(${rhs})` : sql`${left} <> ALL(${rhs})`);
    }
    if (isFragmentable(rhs)) {
      return expr(
        op === 'in' ? sql`${left} IN (${rhs.fragment()})` : sql`${left} NOT IN (${rhs.fragment()})`,
      );
    }
    throw new SqlError(
      'SQL_INVALID_OPERATOR',
      `'${op}' needs an array or a sub-query on the right.`,
      "Pass a list: where('id', 'in', [1, 2]) or a select query.",
    );
  }
  if (op === 'is' || op === 'is not') {
    const not = op === 'is not' ? sql`NOT ` : sql.empty;
    if (rhs === null) return expr(sql`${left} IS ${not}NULL`);
    if (typeof rhs === 'boolean') return expr(sql`${left} IS ${not}${rhs ? TRUE : FALSE}`);
    throw new SqlError(
      'SQL_INVALID_OPERATOR',
      `'${op}' only tests null, true or false.`,
      "Use where('col', 'is', null) or 'is not'; compare values with '='.",
    );
  }
  const word = OPERATORS[op as ValueOperator];
  if (word === undefined) {
    throw new SqlError(
      'SQL_INVALID_OPERATOR',
      `'${String(op)}' is not a supported operator.`,
      `Use one of: ${Object.keys(OPERATORS).join(', ')}, in, not in, is, is not.`,
    );
  }
  return expr(sql`${left} ${word} ${operand(rhs)}`);
}

function combine(
  exprs: readonly Expression<boolean>[],
  separator: SqlFragment,
  empty: SqlFragment,
): Expression<boolean> {
  const only = exprs[0];
  if (only === undefined) return expr(empty);
  if (exprs.length === 1) return only;
  return expr(
    sql`(${sql.join(
      exprs.map((e) => e.fragment),
      separator,
    )})`,
  );
}

/** The type of column `R` (`'alias.column'` or `'column'`) in scope `S` of schema `DB`. */
export type ColumnTypeOf<DB, S, R extends string> = R extends `${infer A}.${infer C}`
  ? A extends keyof S
    ? S[A] extends keyof DB
      ? C extends keyof DB[S[A]]
        ? DB[S[A]][C]
        : never
      : never
    : never
  : {
      [A in keyof S]: S[A] extends keyof DB
        ? R extends keyof DB[S[A]]
          ? DB[S[A]][R]
          : never
        : never;
    }[keyof S];

/** Aggregate and other function builders. */
export interface FunctionBuilder<Col extends string, DB, S> {
  /** `count(*)`, `count("col")` or `count(DISTINCT "col")`. */
  count(column?: Col, options?: { readonly distinct?: boolean }): Expression<number>;
  sum<R extends Col>(column: R): Expression<ColumnTypeOf<DB, S, R> | null>;
  avg<R extends Col>(column: R): Expression<string | null>;
  min<R extends Col>(column: R): Expression<ColumnTypeOf<DB, S, R> | null>;
  max<R extends Col>(column: R): Expression<ColumnTypeOf<DB, S, R> | null>;
  /** `grouping("a", "b")`: which GROUPING SETS level a row belongs to. */
  grouping(columns: readonly Col[]): Expression<number>;
}

/**
 * The expression builder passed to `where`, `having`, `select` and join callbacks. Callable for comparisons;
 * `and` / `or` / `not` / `exists` / `col` / `val` / `sql` / `fn` for the rest.
 */
export interface ExpressionBuilder<DB, S, Col extends string = string> {
  <R extends Col>(
    lhs: R,
    op: ValueOperator,
    rhs: ColumnTypeOf<DB, S, R> | Expression<ColumnTypeOf<DB, S, R>>,
  ): Expression<boolean>;
  <R extends Col>(
    lhs: R,
    op: ListOperator,
    rhs: readonly ColumnTypeOf<DB, S, R>[] | Fragmentable,
  ): Expression<boolean>;
  <R extends Col>(lhs: R, op: NullOperator, rhs: null | boolean): Expression<boolean>;
  <T>(lhs: Expression<T>, op: ValueOperator, rhs: T | Expression<T>): Expression<boolean>;
  <T>(lhs: Expression<T>, op: NullOperator, rhs: null | boolean): Expression<boolean>;
  and(expressions: readonly Expression<boolean>[]): Expression<boolean>;
  or(expressions: readonly Expression<boolean>[]): Expression<boolean>;
  not(expression: Expression<boolean>): Expression<boolean>;
  exists(query: Fragmentable): Expression<boolean>;
  /** A column reference as an expression (for column-to-column comparisons). */
  col<R extends Col>(ref: R): Expression<ColumnTypeOf<DB, S, R>>;
  /** A bound value. */
  val<T>(value: T): Expression<T>;
  /** A raw `sql` fragment as an expression. */
  sql<T>(fragment: SqlFragment): Expression<T>;
  readonly fn: FunctionBuilder<Col, DB, S>;
}

function aggregate(name: SqlFragment, column: string | undefined, distinct = false): SqlFragment {
  if (column === undefined) return sql`${name}(*)`;
  return distinct
    ? sql`${name}(DISTINCT ${columnRef(column)})`
    : sql`${name}(${columnRef(column)})`;
}

const fn = Object.freeze({
  count: (column?: string, options?: { readonly distinct?: boolean }) =>
    expr<number>(aggregate(sql`count`, column, options?.distinct)),
  sum: (column: string) => expr(aggregate(sql`sum`, column)),
  avg: (column: string) => expr<string | null>(aggregate(sql`avg`, column)),
  min: (column: string) => expr(aggregate(sql`min`, column)),
  max: (column: string) => expr(aggregate(sql`max`, column)),
  grouping: (columns: readonly string[]) =>
    expr<number>(sql`grouping(${sql.join(columns.map(columnRef))})`),
}) as FunctionBuilder<string, unknown, unknown>;

/** The one, stateless expression builder; scopes only exist in the types. */
export const expressionBuilder: ExpressionBuilder<unknown, unknown, string> = Object.assign(
  ((lhs: string | Expression<unknown>, op: Operator, rhs: unknown) =>
    compare(lhs, op, rhs)) as ExpressionBuilder<unknown, unknown, string>,
  {
    and: (exprs: readonly Expression<boolean>[]) => combine(exprs, sql` AND `, TRUE),
    or: (exprs: readonly Expression<boolean>[]) => combine(exprs, sql` OR `, FALSE),
    not: (e: Expression<boolean>) => expr<boolean>(sql`NOT (${e.fragment})`),
    exists: (q: Fragmentable) => expr<boolean>(sql`EXISTS (${q.fragment()})`),
    col: (ref: string) => expr(columnRef(ref)),
    val: <T>(value: T) => expr<T>(sql`${value}`),
    sql: <T>(fragment: SqlFragment) => expr<T>(fragment),
    fn,
  },
);
