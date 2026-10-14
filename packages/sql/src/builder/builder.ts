/**
 * The typed query builder (RFC 0005 §7.7): select / insert / update / delete over a schema interface
 * (`{ table: { column: type } }`, the shape `shutro generate` will emit). Every query compiles through the `sql`
 * fragment AST, so values only ever become parameters and identifiers are always validated and quoted.
 */
import type { SqlFragment } from '../ast.js';
import { type CompiledSql, compile } from '../compile.js';
import { SqlError } from '../errors.js';
import { sql } from '../tag.js';
import {
  type AliasedExpression,
  type ColumnTypeOf,
  columnRef,
  compare,
  type Expression,
  type ExpressionBuilder,
  expressionBuilder,
  type Fragmentable,
  isExpression,
  type ListOperator,
  type NullOperator,
  type Operator,
  type ValueOperator,
} from './expression.js';

// ---------------------------------------------------------------------------------------------------- types

/** A schema: table name → row type. Plain interfaces work too; this alias only documents the shape. */
export type Schema = Record<string, Record<string, unknown>>;
type TableName<DB> = keyof DB & string;
/** `'table'` or `'table as alias'`. */
export type TableExpr<DB> = TableName<DB> | `${TableName<DB>} as ${string}`;
/** Alias → table name, for the tables a query can see. */
export type Scope = Record<string, string>;
type Parsed<E extends string> = E extends `${infer T} as ${infer A}`
  ? { table: T; alias: A }
  : { table: E; alias: E };
/** Adds a table (with its alias) to a scope. */
export type AddTable<S, E extends string> = S & {
  readonly [K in Parsed<E>['alias']]: Parsed<E>['table'];
};
/** `'alias.column'` or bare `'column'` for every table in scope. */
export type ColumnRef<DB, S> = {
  [A in keyof S & string]: S[A] extends keyof DB
    ? `${A}.${keyof DB[S[A]] & string}` | (keyof DB[S[A]] & string)
    : never;
}[keyof S & string];
/** A column reference, optionally renamed: `'so.name as reference'`. */
export type SelectRef<DB, S> = ColumnRef<DB, S> | `${ColumnRef<DB, S>} as ${string}`;
type SelectedKey<E extends string> = E extends `${string} as ${infer A}`
  ? A
  : E extends `${string}.${infer C}`
    ? C
    : E;
type SelectedType<DB, S, E extends string> = E extends `${infer R} as ${string}`
  ? ColumnTypeOf<DB, S, R>
  : ColumnTypeOf<DB, S, E>;
type SelectedRow<DB, S, E extends string> = { [X in E as SelectedKey<X>]: SelectedType<DB, S, X> };
type AliasedRow<A extends AliasedExpression<unknown, string>> = {
  [X in A as X['alias']]: X extends AliasedExpression<infer T, string> ? T : never;
};
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
type ScopeRow<DB, S> = UnionToIntersection<
  { [A in keyof S]: S[A] extends keyof DB ? DB[S[A]] : never }[keyof S]
>;
type Simplify<T> = { [K in keyof T]: T[K] } & NonNullable<unknown>;
type Empty = Record<never, never>;
type Eb<DB, S> = ExpressionBuilder<DB, S, ColumnRef<DB, S>>;
type Rhs<DB, S, R extends string> = ColumnTypeOf<DB, S, R> | Expression<ColumnTypeOf<DB, S, R>>;

/** Any compiled query; `O` is its row type. */
export interface Query<O = unknown> extends Fragmentable {
  /** Phantom. */
  readonly '~row'?: O;
  compile(): CompiledSql;
}
/** The row type of a query. */
export type RowOf<Q> = Q extends Query<infer O> ? Simplify<O> : never;

// -------------------------------------------------------------------------------------------------- runtime

interface Cte {
  readonly name: string;
  readonly query: Fragmentable;
}
interface Source {
  readonly table: string;
  readonly alias: string | undefined;
}
interface Join {
  readonly kind: 'INNER' | 'LEFT';
  readonly source: Source;
  readonly on: Expression<boolean>;
}
interface OrderTerm {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
  readonly nulls: 'first' | 'last' | undefined;
}

function parseTable(expression: string): Source {
  if (typeof expression !== 'string') {
    throw new SqlError(
      'SQL_INVALID_IDENTIFIER',
      'A table reference must be a string.',
      "Use 'table' or 'table as alias'.",
    );
  }
  const at = expression.indexOf(' as ');
  if (at < 0) {
    sql.id(expression);
    return { table: expression, alias: undefined };
  }
  const table = expression.slice(0, at);
  const alias = expression.slice(at + 4);
  sql.id(table);
  sql.id(alias);
  return { table, alias };
}

function renderSource(source: Source): SqlFragment {
  return source.alias === undefined
    ? sql.id(source.table)
    : sql`${sql.id(source.table)} AS ${sql.id(source.alias)}`;
}

function renderCtes(ctes: readonly Cte[]): SqlFragment {
  if (ctes.length === 0) return sql.empty;
  return sql`WITH ${sql.join(ctes.map((c) => sql`${sql.id(c.name)} AS (${c.query.fragment()})`))} `;
}

function renderWhere(
  keyword: SqlFragment,
  conditions: readonly Expression<boolean>[],
): SqlFragment {
  if (conditions.length === 0) return sql.empty;
  return sql` ${keyword} ${sql.join(
    conditions.map((c) => c.fragment),
    sql` AND `,
  )}`;
}

function renderReturning(columns: readonly string[]): SqlFragment {
  if (columns.length === 0) return sql.empty;
  return sql` RETURNING ${sql.join(columns.map(columnRef))}`;
}

function selectItem(item: string): SqlFragment {
  const at = item.indexOf(' as ');
  if (at < 0) return columnRef(item);
  return sql`${columnRef(item.slice(0, at))} AS ${sql.id(item.slice(at + 4))}`;
}

function value(v: unknown): SqlFragment {
  return isExpression(v) ? v.fragment : sql`${v}`;
}

function condition(args: readonly unknown[]): Expression<boolean> {
  const [first, op, rhs] = args;
  if (typeof first === 'function')
    return (first as (eb: unknown) => Expression<boolean>)(expressionBuilder);
  return compare(first as string, op as Operator, rhs);
}

function count(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new SqlError(
      'SQL_INVALID_PARAM',
      `${what} must be a non-negative integer, got ${String(n)}.`,
      `Pass e.g. ${what}(80).`,
    );
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------- select

interface SelectState {
  readonly ctes: readonly Cte[];
  readonly from: Source;
  readonly joins: readonly Join[];
  readonly columns: readonly SqlFragment[];
  readonly selectAll: boolean;
  readonly where: readonly Expression<boolean>[];
  readonly groupBy: readonly string[];
  readonly groupingSets: readonly (readonly string[])[] | undefined;
  readonly having: readonly Expression<boolean>[];
  readonly orderBy: readonly OrderTerm[];
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

/** A `SELECT` query. Immutable: every method returns a new query. */
export class SelectQuery<DB, S extends Scope, O> implements Query<O> {
  /** Phantom. */
  declare readonly '~row'?: O;
  readonly #state: SelectState;

  /** @internal */
  constructor(state: SelectState) {
    this.#state = Object.freeze(state);
  }

  #with(changes: Partial<SelectState>): SelectQuery<DB, S, O> {
    return new SelectQuery<DB, S, O>({ ...this.#state, ...changes });
  }

  /** Selects columns: `'so.id'`, `'so.name as reference'`, or bare `'state'`. */
  select<const C extends readonly SelectRef<DB, S>[]>(
    columns: C,
  ): SelectQuery<DB, S, O & SelectedRow<DB, S, C[number]>>;
  /** Selects expressions, each named with `.as()`. */
  select<const A extends readonly AliasedExpression<unknown, string>[]>(
    build: (eb: Eb<DB, S>) => A,
  ): SelectQuery<DB, S, O & AliasedRow<A[number]>>;
  select(
    arg: readonly string[] | ((eb: Eb<DB, S>) => readonly AliasedExpression<unknown, string>[]),
  ): SelectQuery<DB, S, O> {
    const items =
      typeof arg === 'function'
        ? arg(expressionBuilder as unknown as Eb<DB, S>).map(
            (a) => sql`${a.expression.fragment} AS ${sql.id(a.alias)}`,
          )
        : arg.map(selectItem);
    return this.#with({ columns: [...this.#state.columns, ...items] });
  }

  /** `SELECT *`. */
  selectAll(): SelectQuery<DB, S, O & ScopeRow<DB, S>> {
    return this.#with({ selectAll: true }) as SelectQuery<DB, S, O & ScopeRow<DB, S>>;
  }

  innerJoin<
    E extends TableExpr<DB>,
    L extends ColumnRef<DB, AddTable<S, E>>,
    R extends ColumnRef<DB, AddTable<S, E>>,
  >(table: E, left: L, right: R): SelectQuery<DB, AddTable<S, E>, O>;
  innerJoin<E extends TableExpr<DB>>(
    table: E,
    on: (eb: Eb<DB, AddTable<S, E>>) => Expression<boolean>,
  ): SelectQuery<DB, AddTable<S, E>, O>;
  innerJoin<E extends TableExpr<DB>>(
    table: E,
    ...on: readonly unknown[]
  ): SelectQuery<DB, AddTable<S, E>, O> {
    return this.#join<AddTable<S, E>>('INNER', table, on);
  }

  leftJoin<
    E extends TableExpr<DB>,
    L extends ColumnRef<DB, AddTable<S, E>>,
    R extends ColumnRef<DB, AddTable<S, E>>,
  >(table: E, left: L, right: R): SelectQuery<DB, AddTable<S, E>, O>;
  leftJoin<E extends TableExpr<DB>>(
    table: E,
    on: (eb: Eb<DB, AddTable<S, E>>) => Expression<boolean>,
  ): SelectQuery<DB, AddTable<S, E>, O>;
  leftJoin<E extends TableExpr<DB>>(
    table: E,
    ...on: readonly unknown[]
  ): SelectQuery<DB, AddTable<S, E>, O> {
    return this.#join<AddTable<S, E>>('LEFT', table, on);
  }

  #join<S2 extends Scope>(
    kind: 'INNER' | 'LEFT',
    table: string,
    on: readonly unknown[],
  ): SelectQuery<DB, S2, O> {
    const [a, b] = on;
    const expression =
      typeof a === 'function'
        ? (a as (eb: unknown) => Expression<boolean>)(expressionBuilder)
        : compare(a as string, '=', expressionBuilder.col(b as string));
    return new SelectQuery<DB, S2, O>({
      ...this.#state,
      joins: [...this.#state.joins, { kind, source: parseTable(table), on: expression }],
    });
  }

  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ValueOperator,
    rhs: Rhs<DB, S, R>,
  ): SelectQuery<DB, S, O>;
  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ListOperator,
    rhs: readonly ColumnTypeOf<DB, S, R>[] | Fragmentable,
  ): SelectQuery<DB, S, O>;
  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: NullOperator,
    rhs: null | boolean,
  ): SelectQuery<DB, S, O>;
  where(build: (eb: Eb<DB, S>) => Expression<boolean>): SelectQuery<DB, S, O>;
  where(...args: readonly unknown[]): SelectQuery<DB, S, O> {
    return this.#with({ where: [...this.#state.where, condition(args)] });
  }

  groupBy(columns: readonly ColumnRef<DB, S>[]): SelectQuery<DB, S, O> {
    for (const c of columns) columnRef(c);
    return this.#with({ groupBy: [...this.#state.groupBy, ...columns], groupingSets: undefined });
  }

  /** `GROUP BY GROUPING SETS ((a, b), (a), ())`. Replaces `groupBy`. */
  groupingSets(sets: readonly (readonly ColumnRef<DB, S>[])[]): SelectQuery<DB, S, O> {
    for (const set of sets) for (const c of set) columnRef(c);
    return this.#with({ groupingSets: sets.map((s) => [...s]), groupBy: [] });
  }

  having<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ValueOperator,
    rhs: Rhs<DB, S, R>,
  ): SelectQuery<DB, S, O>;
  having(build: (eb: Eb<DB, S>) => Expression<boolean>): SelectQuery<DB, S, O>;
  having(...args: readonly unknown[]): SelectQuery<DB, S, O> {
    return this.#with({ having: [...this.#state.having, condition(args)] });
  }

  orderBy(
    column: ColumnRef<DB, S>,
    direction: 'asc' | 'desc' = 'asc',
    options?: { readonly nulls?: 'first' | 'last' },
  ): SelectQuery<DB, S, O> {
    columnRef(column);
    return this.#with({
      orderBy: [...this.#state.orderBy, { column, direction, nulls: options?.nulls }],
    });
  }

  limit(n: number): SelectQuery<DB, S, O> {
    return this.#with({ limit: count(n, 'limit') });
  }

  offset(n: number): SelectQuery<DB, S, O> {
    return this.#with({ offset: count(n, 'offset') });
  }

  fragment(): SqlFragment {
    const s = this.#state;
    if (!s.selectAll && s.columns.length === 0) {
      throw new SqlError(
        'SQL_EMPTY_SELECT',
        'The select query has no columns.',
        'Call .select([...]) or .selectAll() before compiling.',
      );
    }
    const parts: SqlFragment[] = [
      sql`${renderCtes(s.ctes)}SELECT ${s.selectAll ? sql`*` : sql.join(s.columns)} FROM ${renderSource(s.from)}`,
    ];
    for (const j of s.joins)
      parts.push(
        sql` ${j.kind === 'INNER' ? sql`INNER JOIN` : sql`LEFT JOIN`} ${renderSource(j.source)} ON ${j.on.fragment}`,
      );
    parts.push(renderWhere(sql`WHERE`, s.where));
    if (s.groupingSets !== undefined) {
      parts.push(
        sql` GROUP BY GROUPING SETS (${sql.join(s.groupingSets.map((set) => sql`(${sql.join(set.map(columnRef))})`))})`,
      );
    } else if (s.groupBy.length > 0) {
      parts.push(sql` GROUP BY ${sql.join(s.groupBy.map(columnRef))}`);
    }
    parts.push(renderWhere(sql`HAVING`, s.having));
    if (s.orderBy.length > 0) {
      parts.push(
        sql` ORDER BY ${sql.join(
          s.orderBy.map(
            (o) =>
              sql`${columnRef(o.column)} ${o.direction === 'desc' ? sql`DESC` : sql`ASC`}${
                o.nulls === undefined
                  ? sql.empty
                  : o.nulls === 'first'
                    ? sql` NULLS FIRST`
                    : sql` NULLS LAST`
              }`,
          ),
        )}`,
      );
    }
    if (s.limit !== undefined) parts.push(sql` LIMIT ${s.limit}`);
    if (s.offset !== undefined) parts.push(sql` OFFSET ${s.offset}`);
    return sql.join(parts, sql.empty);
  }

  compile(): CompiledSql {
    return compile(this.fragment());
  }
}

// ---------------------------------------------------------------------------------------------------- insert

interface InsertState {
  readonly ctes: readonly Cte[];
  readonly table: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly returning: readonly string[];
}

/** An `INSERT` query. */
export class InsertQuery<DB, T extends TableName<DB>, O> implements Query<O> {
  declare readonly '~row'?: O;
  readonly #state: InsertState;

  /** @internal */
  constructor(state: InsertState) {
    this.#state = Object.freeze(state);
  }

  /** Rows to insert. Keys missing from a row (or `undefined`) become `DEFAULT`. */
  values(
    rows: readonly { readonly [K in keyof DB[T]]?: DB[T][K] | Expression<DB[T][K]> | undefined }[],
  ): InsertQuery<DB, T, O> {
    return new InsertQuery<DB, T, O>({ ...this.#state, rows: [...this.#state.rows, ...rows] });
  }

  returning<const C extends readonly (keyof DB[T] & string)[]>(
    columns: C,
  ): InsertQuery<DB, T, O & Pick<DB[T], C[number]>> {
    return new InsertQuery<DB, T, O & Pick<DB[T], C[number]>>({
      ...this.#state,
      returning: [...this.#state.returning, ...columns],
    });
  }

  fragment(): SqlFragment {
    const s = this.#state;
    if (s.rows.length === 0) {
      throw new SqlError(
        'SQL_EMPTY_VALUES',
        'The insert has no rows.',
        'Call .values([...]) with at least one row before compiling.',
      );
    }
    const columns: string[] = [];
    for (const row of s.rows)
      for (const key of Object.keys(row))
        if (row[key] !== undefined && !columns.includes(key)) columns.push(key);
    if (columns.length === 0) {
      throw new SqlError(
        'SQL_EMPTY_VALUES',
        'The insert rows have no values.',
        'Give at least one column a value, or insert defaults with a raw sql`INSERT ... DEFAULT VALUES`.',
      );
    }
    const rows = s.rows.map(
      (row) =>
        sql`(${sql.join(columns.map((c) => (row[c] === undefined ? sql`DEFAULT` : value(row[c]))))})`,
    );
    return sql`${renderCtes(s.ctes)}INSERT INTO ${sql.id(s.table)} (${sql.join(columns.map((c) => sql.id(c)))}) VALUES ${sql.join(rows)}${renderReturning(s.returning)}`;
  }

  compile(): CompiledSql {
    return compile(this.fragment());
  }
}

// ---------------------------------------------------------------------------------------------------- update

interface UpdateState {
  readonly ctes: readonly Cte[];
  readonly target: Source;
  readonly sets: readonly (readonly [string, unknown])[];
  readonly where: readonly Expression<boolean>[];
  readonly returning: readonly string[];
}

/** Columns to set; `undefined` entries are skipped. */
type SetValues<DB, T extends keyof DB> = {
  readonly [K in keyof DB[T]]?: DB[T][K] | Expression<DB[T][K]> | undefined;
};

/** An `UPDATE` query. */
export class UpdateQuery<DB, S extends Scope, T extends TableName<DB>, O> implements Query<O> {
  declare readonly '~row'?: O;
  readonly #state: UpdateState;

  /** @internal */
  constructor(state: UpdateState) {
    this.#state = Object.freeze(state);
  }

  set(values: SetValues<DB, T>): UpdateQuery<DB, S, T, O>;
  set(build: (eb: Eb<DB, S>) => SetValues<DB, T>): UpdateQuery<DB, S, T, O>;
  set(arg: SetValues<DB, T> | ((eb: Eb<DB, S>) => SetValues<DB, T>)): UpdateQuery<DB, S, T, O> {
    const values = typeof arg === 'function' ? arg(expressionBuilder as unknown as Eb<DB, S>) : arg;
    const sets = Object.entries(values).filter(
      (entry): entry is [string, unknown] => entry[1] !== undefined,
    );
    for (const [column] of sets) sql.id(column);
    return new UpdateQuery<DB, S, T, O>({ ...this.#state, sets: [...this.#state.sets, ...sets] });
  }

  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ValueOperator,
    rhs: Rhs<DB, S, R>,
  ): UpdateQuery<DB, S, T, O>;
  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ListOperator,
    rhs: readonly ColumnTypeOf<DB, S, R>[] | Fragmentable,
  ): UpdateQuery<DB, S, T, O>;
  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: NullOperator,
    rhs: null | boolean,
  ): UpdateQuery<DB, S, T, O>;
  where(build: (eb: Eb<DB, S>) => Expression<boolean>): UpdateQuery<DB, S, T, O>;
  where(...args: readonly unknown[]): UpdateQuery<DB, S, T, O> {
    return new UpdateQuery<DB, S, T, O>({
      ...this.#state,
      where: [...this.#state.where, condition(args)],
    });
  }

  returning<const C extends readonly ColumnRef<DB, S>[]>(
    columns: C,
  ): UpdateQuery<DB, S, T, O & SelectedRow<DB, S, C[number]>> {
    return new UpdateQuery<DB, S, T, O & SelectedRow<DB, S, C[number]>>({
      ...this.#state,
      returning: [...this.#state.returning, ...columns],
    });
  }

  fragment(): SqlFragment {
    const s = this.#state;
    if (s.sets.length === 0) {
      throw new SqlError(
        'SQL_EMPTY_VALUES',
        'The update sets no columns.',
        'Call .set({ column: value }) before compiling.',
      );
    }
    const sets = sql.join(s.sets.map(([column, v]) => sql`${sql.id(column)} = ${value(v)}`));
    return sql`${renderCtes(s.ctes)}UPDATE ${renderSource(s.target)} SET ${sets}${renderWhere(sql`WHERE`, s.where)}${renderReturning(s.returning)}`;
  }

  compile(): CompiledSql {
    return compile(this.fragment());
  }
}

// ---------------------------------------------------------------------------------------------------- delete

interface DeleteState {
  readonly ctes: readonly Cte[];
  readonly target: Source;
  readonly where: readonly Expression<boolean>[];
  readonly returning: readonly string[];
}

/** A `DELETE` query. */
export class DeleteQuery<DB, S extends Scope, O> implements Query<O> {
  declare readonly '~row'?: O;
  readonly #state: DeleteState;

  /** @internal */
  constructor(state: DeleteState) {
    this.#state = Object.freeze(state);
  }

  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ValueOperator,
    rhs: Rhs<DB, S, R>,
  ): DeleteQuery<DB, S, O>;
  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: ListOperator,
    rhs: readonly ColumnTypeOf<DB, S, R>[] | Fragmentable,
  ): DeleteQuery<DB, S, O>;
  where<R extends ColumnRef<DB, S>>(
    lhs: R,
    op: NullOperator,
    rhs: null | boolean,
  ): DeleteQuery<DB, S, O>;
  where(build: (eb: Eb<DB, S>) => Expression<boolean>): DeleteQuery<DB, S, O>;
  where(...args: readonly unknown[]): DeleteQuery<DB, S, O> {
    return new DeleteQuery<DB, S, O>({
      ...this.#state,
      where: [...this.#state.where, condition(args)],
    });
  }

  returning<const C extends readonly ColumnRef<DB, S>[]>(
    columns: C,
  ): DeleteQuery<DB, S, O & SelectedRow<DB, S, C[number]>> {
    return new DeleteQuery<DB, S, O & SelectedRow<DB, S, C[number]>>({
      ...this.#state,
      returning: [...this.#state.returning, ...columns],
    });
  }

  fragment(): SqlFragment {
    const s = this.#state;
    return sql`${renderCtes(s.ctes)}DELETE FROM ${renderSource(s.target)}${renderWhere(sql`WHERE`, s.where)}${renderReturning(s.returning)}`;
  }

  compile(): CompiledSql {
    return compile(this.fragment());
  }
}

// ----------------------------------------------------------------------------------------------- entry point

/** Starts queries against a schema. Obtain one with {@link createQueryBuilder}. */
export interface QueryBuilder<DB> {
  selectFrom<E extends TableExpr<DB>>(table: E): SelectQuery<DB, AddTable<Empty, E>, Empty>;
  insertInto<T extends TableName<DB>>(table: T): InsertQuery<DB, T, Empty>;
  updateTable<E extends TableExpr<DB>>(
    table: E,
  ): UpdateQuery<DB, AddTable<Empty, E>, Parsed<E>['table'] & TableName<DB>, Empty>;
  deleteFrom<E extends TableExpr<DB>>(table: E): DeleteQuery<DB, AddTable<Empty, E>, Empty>;
  /** A common table expression, usable as a table (with its row type) in the queries built from the result. */
  with<N extends string, O>(
    name: N,
    build: (qb: QueryBuilder<DB>) => Query<O>,
  ): QueryBuilder<DB & { readonly [K in N]: Simplify<O> }>;
}

function builder<DB>(ctes: readonly Cte[]): QueryBuilder<DB> {
  const self: QueryBuilder<DB> = {
    selectFrom: (table) =>
      new SelectQuery({
        ctes,
        from: parseTable(table),
        joins: [],
        columns: [],
        selectAll: false,
        where: [],
        groupBy: [],
        groupingSets: undefined,
        having: [],
        orderBy: [],
        limit: undefined,
        offset: undefined,
      }),
    insertInto: (table) => {
      sql.id(table);
      return new InsertQuery({ ctes, table, rows: [], returning: [] });
    },
    updateTable: (table) =>
      new UpdateQuery({ ctes, target: parseTable(table), sets: [], where: [], returning: [] }),
    deleteFrom: (table) =>
      new DeleteQuery({ ctes, target: parseTable(table), where: [], returning: [] }),
    with: (name, build) => {
      sql.id(name);
      return builder([...ctes, { name, query: build(self) }]);
    },
  };
  return Object.freeze(self);
}

/**
 * Creates a query builder for a schema.
 *
 * @example
 * ```ts
 * interface Db { sale_order: { id: number; name: string; state: string; partner_id: number } }
 * const qb = createQueryBuilder<Db>();
 * qb.selectFrom('sale_order as so').select(['so.id', 'so.name']).where('so.state', '=', 'sale').compile();
 * // { text: 'SELECT "so"."id", "so"."name" FROM "sale_order" AS "so" WHERE "so"."state" = $1', params: ['sale'] }
 * ```
 */
export function createQueryBuilder<DB>(): QueryBuilder<DB> {
  return builder<DB>([]);
}
