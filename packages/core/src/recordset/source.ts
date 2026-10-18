/** Where reads come from: the table, or the past in `env.asOf` scopes (RFC 0018 §7.4). */
import { type SqlFragment, sql } from '@shutro/sql';
import type { ScopeInternals } from '../env/env.js';
import type { AnyModel } from '../model/model.js';

/**
 * The relation `model` is read from: its table, or in `env.asOf` scopes and for models with history, the rows valid
 * at that instant (current rows unchanged since, plus archived versions), aliased as the table.
 */
export function sourceOf(internals: ScopeInternals, model: AnyModel): SqlFragment {
  const at = internals.asOf;
  if (at === undefined || !model.history) return sql.id(model.table);
  const columns = sql.join(
    [
      ...new Set([
        'id',
        ...Object.values(model.columns).filter((c): c is string => c !== undefined),
      ]),
    ].map((c) => sql.id(c)),
  );
  return sql`(SELECT ${columns} FROM ${sql.id(model.table)} WHERE ${sql.id('updated_at')} <= ${at}
    UNION ALL SELECT ${columns} FROM ${sql.id(`${model.table}_history`.slice(0, 63))} WHERE ${sql.id('valid_from')} <= ${at} AND ${sql.id('valid_to')} > ${at}) AS ${sql.id(model.table)}`;
}
