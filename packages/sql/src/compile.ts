import { isSql, type SqlFragment, type SqlNode } from './ast.js';
import { SqlError } from './errors.js';

/** PostgreSQL's wire protocol carries the parameter count as a 16-bit integer. */
export const MAX_PARAMS = 65_535;

/** SQL ready for the driver: text with `$n` placeholders, plus the values in order. */
export interface CompiledSql {
  /** SQL text. Contains no values, so identical query shapes give identical text (plan and prepared-statement reuse). */
  readonly text: string;
  /** Values for `$1..$n`, in order. */
  readonly params: readonly unknown[];
}

/**
 * Renders a fragment to parameterized SQL. Parameters are numbered `$1..$n` in order of appearance, and
 * identifiers are always double-quoted.
 *
 * @throws {SqlError} `SQL_NOT_A_FRAGMENT` if `sql` was not created by the `sql` tag; `SQL_TOO_MANY_PARAMS` above
 * {@link MAX_PARAMS} parameters.
 */
export function compile(sql: SqlFragment): CompiledSql {
  if (!isSql(sql)) {
    throw new SqlError(
      'SQL_NOT_A_FRAGMENT',
      'compile() was given something that is not a sql fragment.',
      'Build queries with sql`...` and its helpers; fragments cannot be constructed by hand.',
    );
  }
  const text: string[] = [];
  const params: unknown[] = [];

  const render = (node: SqlNode): void => {
    switch (node.kind) {
      case 'text':
        text.push(node.text);
        return;
      case 'ident':
        text.push(node.parts.map((p) => `"${p}"`).join('.'));
        return;
      case 'param':
        if (params.length === MAX_PARAMS) {
          throw new SqlError(
            'SQL_TOO_MANY_PARAMS',
            `The query has more than ${MAX_PARAMS} parameters, the PostgreSQL protocol limit.`,
            'Pass lists as one array parameter instead, e.g. id = ANY(<sql.array(ids, "bigint")>) or unnest(...).',
          );
        }
        params.push(node.value);
        text.push(
          node.cast === undefined ? `$${params.length}` : `$${params.length}::${node.cast}`,
        );
        return;
      case 'seq':
        for (const child of node.nodes) render(child);
        return;
    }
  };

  render(sql.node);
  return Object.freeze({ text: text.join(''), params: Object.freeze(params) });
}
