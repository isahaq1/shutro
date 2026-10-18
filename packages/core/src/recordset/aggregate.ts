/**
 * `env.model(M).aggregate()` (feedback #13): grouped totals for reports, compiled to one `GROUP BY` statement with the
 * same guarantees as `search`: read ACL, field groups on every grouped, measured and filtered field, record rules,
 * archived / company scoping, relation paths with the targets' rules. Monetary measures are grouped by their currency
 * as well, so a total is never a sum of two currencies.
 */
import { compile, type SqlFragment, sql } from '@shutro/sql';
import { Decimal as DecimalJs } from 'decimal.js';
import type { ScopeInternals } from '../env/env.js';
import { InvalidDomainError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { Money } from '../money/money.js';
import { compileDomain, scopingConditions, type TranslationScope } from './domain.js';
import { assertAccess, assertDomainFields, assertFields, ruleConditions } from './security.js';

const GRANULARITIES = new Set(['day', 'week', 'month', 'quarter', 'year']);
const GROUPABLE = new Set([
  'char',
  'selection',
  'state',
  'boolean',
  'integer',
  'date',
  'datetime',
  'many2one',
]);
const NUMERIC = new Set(['integer', 'float', 'decimal', 'monetary']);
const OPS = ['sum', 'avg', 'min', 'max'] as const;
type Op = (typeof OPS)[number];

/** The untyped query `aggregate()` receives (typed in `AggregateQuery`). */
export interface AggregateQueryRaw {
  readonly where?: Readonly<Record<string, unknown>>;
  readonly groupBy?: readonly string[];
  readonly measures: Readonly<Record<string, unknown>>;
  readonly order?: readonly string[];
  readonly limit?: number;
  readonly groupingSets?: readonly (readonly string[])[];
  readonly rollup?: boolean;
  readonly cube?: boolean;
}

/** The grouping sets of a query (indexes into its groups), or `undefined` for a plain GROUP BY. */
function groupingSetsOf(
  query: AggregateQueryRaw,
  groups: readonly Group[],
): number[][] | undefined {
  const modes = [
    query.groupingSets !== undefined,
    query.rollup === true,
    query.cube === true,
  ].filter(Boolean);
  if (modes.length === 0) return undefined;
  if (modes.length > 1)
    invalid(
      'Give one of groupingSets, rollup and cube.',
      'They are alternative ways to ask for subtotals.',
    );
  const all = groups.map((_, i) => i);
  if (query.rollup === true) return all.map((_, n) => all.slice(0, all.length - n)).concat([[]]);
  if (query.cube === true) {
    if (groups.length > 6)
      invalid(
        `cube over ${groups.length} groups makes ${2 ** groups.length} groupings.`,
        'Use at most 6 groups, or explicit groupingSets.',
      );
    return Array.from({ length: 2 ** groups.length }, (_, mask) =>
      all.filter((i) => (mask & (1 << i)) !== 0),
    ).sort((a, b) => b.length - a.length);
  }
  const sets = (query.groupingSets ?? []).map((set) =>
    set.map((name) => {
      const index = groups.findIndex((g) => g.name === name);
      if (index < 0)
        invalid(
          `The grouping set [${set.join(', ')}] names '${name}', which is not in groupBy.`,
          'Each set is a subset of groupBy.',
        );
      return index;
    }),
  );
  if (sets.length === 0)
    invalid('groupingSets is empty.', 'Give at least one set; [] is the grand total.');
  return sets;
}

interface Group {
  readonly name: string;
  readonly key: string;
  readonly field: Field;
  readonly expr: SqlFragment;
}

interface Measure {
  readonly name: string;
  readonly op: Op | 'count';
  readonly key: string | undefined;
  readonly field: Field | undefined;
  readonly expr: SqlFragment;
}

/** What the aggregate runtime needs besides the scope. */
export interface AggregateHost {
  readonly internals: ScopeInternals;
  readonly translation: TranslationScope;
  currency(id: number): Promise<import('../money/currency.js').Currency>;
}

function invalid(problem: string, hint: string): never {
  throw new InvalidDomainError(problem, hint);
}

function groupOf(host: AggregateHost, model: AnyModel, name: string): Group {
  const [key = '', granularity, extra] = name.split(':');
  const field = model.fields[key];
  if (
    field === undefined ||
    extra !== undefined ||
    !GROUPABLE.has(field.kind) ||
    model.columns[key] === undefined
  )
    invalid(
      `'${name}' cannot group ${model.name}.`,
      'Group by a stored char, selection, state, boolean, integer, date, datetime or many2one field; dates take a granularity, e.g. dateOrder:month.',
    );
  if (field.translate || field.companyDependent)
    invalid(
      `'${key}' is translated or company-dependent; grouping by it is not supported.`,
      'Group by an untranslated field.',
    );
  const column = sql.id(model.columns[key] ?? '');
  if (granularity !== undefined) {
    if (!GRANULARITIES.has(granularity) || (field.kind !== 'date' && field.kind !== 'datetime'))
      invalid(
        `'${name}': only date and datetime fields take a granularity, one of day, week, month, quarter, year.`,
        'Write e.g. dateOrder:month.',
      );
    // Datetimes are bucketed in the environment's time zone: "October" is the user's October.
    const local =
      field.kind === 'datetime' ? sql`(${column} AT TIME ZONE ${host.internals.env.tz})` : column;
    return {
      name,
      key,
      field,
      expr: sql`to_char(date_trunc(${granularity}, ${local}), 'YYYY-MM-DD')`,
    };
  }
  if (field.kind === 'datetime')
    invalid(
      `'${key}' is a datetime: give a granularity.`,
      `Write e.g. ${key}:day or ${key}:month.`,
    );
  return {
    name,
    key,
    field,
    expr: field.kind === 'date' ? sql`to_char(${column}, 'YYYY-MM-DD')` : column,
  };
}

function measureOf(model: AnyModel, name: string, spec: unknown): Measure {
  if (spec === 'count')
    return { name, op: 'count', key: undefined, field: undefined, expr: sql`count(*)` };
  const entries = typeof spec === 'object' && spec !== null ? Object.entries(spec) : [];
  const [op, key] = (entries[0] ?? []) as [string | undefined, unknown];
  if (entries.length !== 1 || !OPS.includes(op as Op) || typeof key !== 'string')
    invalid(
      `Measure '${name}' must be 'count' or one of { sum | avg | min | max: field }.`,
      "Write e.g. measures: { orders: 'count', total: { sum: 'amountTotal' } }.",
    );
  const field = model.fields[key];
  if (field === undefined || !NUMERIC.has(field.kind) || model.columns[key] === undefined)
    invalid(
      `Measure '${name}': '${key}' is not a stored numeric field of ${model.name}.`,
      'Measure an integer, float, decimal or monetary field.',
    );
  const column = sql.id(model.columns[key] ?? '');
  const expr =
    op === 'sum'
      ? sql`coalesce(sum(${column}), 0)`
      : op === 'avg'
        ? sql`avg(${column})`
        : op === 'min'
          ? sql`min(${column})`
          : sql`max(${column})`;
  return { name, op: op as Op, key, field, expr };
}

/** The aggregate of a measure over `ref` (the column, or its alias in a grouping-sets subquery). */
function aggregateOf(measure: Measure, ref: SqlFragment): SqlFragment {
  switch (measure.op) {
    case 'count':
      return sql`count(*)`;
    case 'sum':
      return sql`coalesce(sum(${ref}), 0)`;
    case 'avg':
      return sql`avg(${ref})`;
    case 'min':
      return sql`min(${ref})`;
    case 'max':
      return sql`max(${ref})`;
  }
}

function convert(measure: Measure, raw: unknown, currency: Money['currency'] | undefined): unknown {
  if (measure.op === 'count') return Number(raw);
  if (raw === null || raw === undefined) return null;
  const kind = measure.field?.kind;
  if (kind === 'integer' || kind === 'float') {
    if (measure.op === 'avg') return new DecimalJs(String(raw));
    return Number(raw);
  }
  const amount = new DecimalJs(String(raw));
  if (kind === 'monetary') return currency === undefined ? null : Money.of(amount, currency);
  return amount;
}

/** Runs an aggregate query. @throws {AccessError} @throws {InvalidDomainError} */
export async function runAggregate(
  host: AggregateHost,
  model: AnyModel,
  query: AggregateQueryRaw,
): Promise<Record<string, unknown>[]> {
  const { internals } = host;
  assertAccess(internals, model, 'read');
  assertDomainFields(internals, model, query.where);
  const groups = (query.groupBy ?? []).map((name) => groupOf(host, model, name));
  const measures = Object.entries(query.measures).map(([name, spec]) =>
    measureOf(model, name, spec),
  );
  if (measures.length === 0)
    invalid('aggregate() needs at least one measure.', "Add e.g. measures: { count: 'count' }.");
  const names = new Set<string>();
  for (const n of [...groups.map((g) => g.name), ...measures.map((m) => m.name)]) {
    if (names.has(n)) invalid(`'${n}' is both a group and a measure.`, 'Rename the measure.');
    names.add(n);
  }
  assertFields(
    internals,
    model,
    [...groups.map((g) => g.key), ...measures.flatMap((m) => (m.key === undefined ? [] : [m.key]))],
    'read',
  );
  // Each monetary measure is also grouped by its currency field (never a sum across currencies).
  const currencyKeys = [
    ...new Set(
      measures.flatMap((m) =>
        m.field?.kind === 'monetary'
          ? [(m.field as Field & { currencyField: string }).currencyField]
          : [],
      ),
    ),
  ];
  for (const key of currencyKeys) {
    if (model.columns[key] === undefined)
      invalid(
        `The currency field '${key}' of ${model.name} is not stored, so monetary totals cannot be grouped by it.`,
        'Store the currency field (store: true on a related currency).',
      );
  }
  await internals.flush(); // the totals must see pending writes, including the targets of relation paths
  const sets = groupingSetsOf(query, groups);
  const conditions = [
    ...compileDomain(
      model,
      query.where,
      host.translation,
      (n) => internals.registry.get(n).model,
      (target) => ruleConditions(internals, target, 'read'),
    ),
    ...scopingConditions(model, internals.env),
    ...ruleConditions(internals, model, 'read'),
  ];
  const where =
    conditions.length === 0 ? sql.empty : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
  const from = host.translation.from?.(model) ?? sql.id(model.table);
  const limit = query.limit === undefined ? sql.empty : sql` LIMIT ${query.limit}`;
  let statement: SqlFragment;
  if (sets === undefined) {
    const select: SqlFragment[] = [
      ...groups.map((g, i) => sql`${g.expr} AS ${sql.id(`g${i}`)}`),
      ...currencyKeys.map((k, i) => sql`${sql.id(model.columns[k] ?? '')} AS ${sql.id(`c${i}`)}`),
      ...measures.map((m, i) => sql`${m.expr} AS ${sql.id(`m${i}`)}`),
    ];
    const grouping = [
      ...groups.map((_, i) => sql.id(`g${i}`)),
      ...currencyKeys.map((_, i) => sql.id(`c${i}`)),
    ];
    const groupBy = grouping.length === 0 ? sql.empty : sql` GROUP BY ${sql.join(grouping)}`;
    const order = orderOf(query.order, groups, measures, grouping);
    statement = sql`SELECT ${sql.join(select)} FROM ${from}${where}${groupBy}${order}${limit}`;
  } else {
    // Grouping sets: an inner query computes each group expression and measure input once (bind parameters such as
    // the granularity or time zone would otherwise make two copies of an expression differ), the outer one groups
    // by their names. The currency stays in every set: a subtotal is never a sum of two currencies.
    const inner: SqlFragment[] = [
      sql`1 AS ${sql.id('one')}`,
      ...groups.map((g, i) => sql`${g.expr} AS ${sql.id(`g${i}`)}`),
      ...currencyKeys.map((k, i) => sql`${sql.id(model.columns[k] ?? '')} AS ${sql.id(`c${i}`)}`),
      ...measures.flatMap((m, i) =>
        m.key === undefined
          ? []
          : [sql`${sql.id(model.columns[m.key] ?? '')} AS ${sql.id(`v${i}`)}`],
      ),
    ];
    const currencies = currencyKeys.map((_, i) => sql.id(`c${i}`));
    const select: SqlFragment[] = [
      ...groups.map((_, i) => sql`${sql.id(`g${i}`)}`),
      ...currencies,
      ...measures.map((m, i) => sql`${aggregateOf(m, sql.id(`v${i}`))} AS ${sql.id(`m${i}`)}`),
      groups.length === 0
        ? sql`0 AS ${sql.id('gl')}`
        : sql`GROUPING(${sql.join(groups.map((_, i) => sql.id(`g${i}`)))}) AS ${sql.id('gl')}`,
    ];
    const groupingSets = sql`GROUPING SETS (${sql.join(
      sets.map((set) => sql`(${sql.join([...set.map((i) => sql.id(`g${i}`)), ...currencies])})`),
    )})`;
    // Leaves first, then each subtotal level, then the grand total.
    const order = orderOf(
      query.order,
      groups,
      measures,
      [...groups.map((_, i) => sql.id(`g${i}`)), ...currencies],
      sql`${sql.id('gl')} ASC`,
    );
    statement = sql`SELECT ${sql.join(select)} FROM (SELECT ${sql.join(inner)} FROM ${from}${where}) AS ${sql.id('t')} GROUP BY ${groupingSets}${order}${limit}`;
  }
  const rows = await internals.query<Record<string, unknown>>(compile(statement));
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const result: Record<string, unknown> = {};
    if (sets !== undefined) {
      // GROUPING() sets bit (n - 1 - i) when group i is aggregated away in this row.
      const mask = groups.length === 0 ? 0 : Number(row['gl']);
      result['$groups'] = groups
        .filter((_, i) => (mask & (1 << (groups.length - 1 - i))) === 0)
        .map((g) => g.name);
    }
    groups.forEach((g, i) => {
      const value = row[`g${i}`];
      result[g.name] =
        value === null || value === undefined
          ? null
          : g.field.kind === 'many2one' || g.field.kind === 'integer'
            ? Number(value)
            : value;
    });
    for (const [i, m] of measures.entries()) {
      let currency: Money['currency'] | undefined;
      if (m.field?.kind === 'monetary') {
        const ci = currencyKeys.indexOf(
          (m.field as Field & { currencyField: string }).currencyField,
        );
        const id = row[`c${ci}`];
        currency = id === null || id === undefined ? undefined : await host.currency(Number(id));
      }
      result[m.name] = convert(m, row[`m${i}`], currency);
    }
    out.push(result);
  }
  return out;
}

function orderOf(
  order: readonly string[] | undefined,
  groups: readonly Group[],
  measures: readonly Measure[],
  grouping: readonly SqlFragment[],
  first?: SqlFragment,
): SqlFragment {
  const lead = first === undefined ? [] : [first];
  if (order === undefined || order.length === 0)
    return grouping.length === 0 && lead.length === 0
      ? sql.empty
      : sql` ORDER BY ${sql.join([...lead, ...grouping.map((g) => sql`${g} ASC NULLS LAST`)])}`;
  const terms = order.map((term) => {
    const [name = '', direction = 'asc', extra] = term.trim().split(/\s+/);
    const gi = groups.findIndex((g) => g.name === name);
    const mi = measures.findIndex((m) => m.name === name);
    if ((gi < 0 && mi < 0) || extra !== undefined || (direction !== 'asc' && direction !== 'desc'))
      invalid(
        `Cannot order the aggregate by '${term}'.`,
        "Order by a group or a measure name, optionally followed by 'asc' or 'desc'.",
      );
    const alias = sql.id(gi >= 0 ? `g${gi}` : `m${mi}`);
    return direction === 'desc' ? sql`${alias} DESC NULLS LAST` : sql`${alias} ASC NULLS LAST`;
  });
  return sql` ORDER BY ${sql.join([...lead, ...terms])}`;
}
