/**
 * Compiles a search domain (RFC 0005 §7.1) plus automatic scoping (`active`, companies) into WHERE fragments:
 * field conditions ANDed, `or` / `and` / `not`, dotted relation paths (`'partner.name'`, `'order.user'`) and
 * `{ lines: { any | none: domain } }` on x2many fields. Relations compile to sub-selects, never joins, so rows are
 * never duplicated (RFC 0005 R8).
 */

import { type SqlFragment, sql } from '@shutro/sql';
import { Decimal as DecimalJs } from 'decimal.js';
import type { Env } from '../env/env.js';
import { InvalidDomainError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { junctionTable } from './relations.js';

/** Resolves a model by name (the registry), needed for relation paths. */
export type ModelResolver = (name: string) => AnyModel;

const OPERATORS = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'notIn',
  'isNull',
  'like',
  'ilike',
]);

function bind(value: unknown): unknown {
  if (DecimalJs.isDecimal(value)) return (value as DecimalJs).toFixed();
  return value;
}

/** The environment language and the source language (RFC 0011). */
export interface TranslationScope {
  readonly lang: string;
  readonly source: string;
}

function column(
  model: AnyModel,
  key: string,
  translation?: TranslationScope,
): { readonly field: Field; readonly column: SqlFragment } {
  const field = model.fields[key];
  const col = model.columns[key];
  if (field === undefined) {
    throw new InvalidDomainError(
      `'${key}' is not a field of ${model.name}.`,
      `Fields: ${Object.keys(model.fields).join(', ')}.`,
    );
  }
  if (field.encrypted) {
    throw new InvalidDomainError(
      `'${key}' of ${model.name} is encrypted and cannot be filtered or sorted on.`,
      'Encrypted values are opaque to the database; filter in memory after loading, or store a searchable hash in another field.',
    );
  }
  if (col === undefined) {
    throw new InvalidDomainError(
      `'${key}' of ${model.name} is a ${field.kind} field and cannot be filtered on directly.`,
      'Filter x2many relations with any / all / none (full domain compiler), and non-stored computes in memory.',
    );
  }
  if (field.translate && translation !== undefined) {
    // COALESCE(col->>lang, col->>source): what readers see, so filters and sorts match reads (RFC 0005 §7.4).
    return {
      field,
      column: sql`COALESCE(${sql.id(col)}->>${translation.lang}, ${sql.id(col)}->>${translation.source})`,
    };
  }
  return { field, column: sql.id(col) };
}

function condition(col: SqlFragment, op: string, value: unknown, key: string): SqlFragment {
  switch (op) {
    case 'eq':
      return value === null ? sql`${col} IS NULL` : sql`${col} = ${bind(value)}`;
    case 'ne':
      return value === null ? sql`${col} IS NOT NULL` : sql`${col} IS DISTINCT FROM ${bind(value)}`;
    case 'lt':
      return sql`${col} < ${bind(value)}`;
    case 'lte':
      return sql`${col} <= ${bind(value)}`;
    case 'gt':
      return sql`${col} > ${bind(value)}`;
    case 'gte':
      return sql`${col} >= ${bind(value)}`;
    case 'in': {
      if (!Array.isArray(value))
        throw new InvalidDomainError(
          `'${key}': in needs an array.`,
          "Use { in: ['draft', 'sale'] }.",
        );
      return value.length === 0 ? sql`FALSE` : sql`${col} = ANY(${value.map(bind)})`;
    }
    case 'notIn': {
      if (!Array.isArray(value))
        throw new InvalidDomainError(
          `'${key}': notIn needs an array.`,
          "Use { notIn: ['cancel'] }.",
        );
      return value.length === 0
        ? sql`TRUE`
        : sql`(${col} IS NULL OR ${col} <> ALL(${value.map(bind)}))`;
    }
    case 'isNull':
      return value === true ? sql`${col} IS NULL` : sql`${col} IS NOT NULL`;
    case 'like':
      return sql`${col} LIKE ${value}`;
    case 'ilike':
      return sql`${col} ILIKE ${value}`;
    default:
      throw new InvalidDomainError(
        `'${op}' is not a domain operator (field '${key}').`,
        `Use one of: ${[...OPERATORS].join(', ')}.`,
      );
  }
}

function isOperators(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !DecimalJs.isDecimal(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Compiles the user's domain into conditions (ANDed). */
export function compileDomain(
  model: AnyModel,
  where: Readonly<Record<string, unknown>> | undefined,
  translation?: TranslationScope,
  resolve?: ModelResolver,
): SqlFragment[] {
  const conditions: SqlFragment[] = [];
  for (const [key, value] of Object.entries(where ?? {})) {
    if (value === undefined) continue;
    if (key === 'or' || key === 'and') {
      if (!Array.isArray(value))
        throw new InvalidDomainError(
          `'${key}' needs an array of domains.`,
          "Use { or: [{ state: 'draft' }, { user: 7 }] }.",
        );
      const parts = value.map((d) => {
        const inner = compileDomain(model, d as Record<string, unknown>, translation, resolve);
        return inner.length === 0 ? sql`TRUE` : sql`(${sql.join(inner, sql` AND `)})`;
      });
      if (parts.length > 0)
        conditions.push(sql`(${sql.join(parts, key === 'or' ? sql` OR ` : sql` AND `)})`);
      continue;
    }
    if (key === 'not') {
      const inner = compileDomain(model, value as Record<string, unknown>, translation, resolve);
      if (inner.length > 0) conditions.push(sql`NOT (${sql.join(inner, sql` AND `)})`);
      continue;
    }
    const dot = key.indexOf('.');
    if (dot > 0) {
      // 'partner.name': the condition on the related model, as a sub-select.
      conditions.push(
        relation(
          model,
          key.slice(0, dot),
          { [key.slice(dot + 1)]: value },
          'any',
          translation,
          resolve,
        ),
      );
      continue;
    }
    const relField = model.fields[key];
    if (relField !== undefined && (relField.kind === 'one2many' || relField.kind === 'many2many')) {
      if (!isOperators(value) || Object.keys(value).some((k) => k !== 'any' && k !== 'none'))
        throw new InvalidDomainError(
          `'${key}' is a ${relField.kind}: filter it with { any: domain } or { none: domain }.`,
          `E.g. { ${key}: { any: { quantity: { gt: 10 } } } }.`,
        );
      for (const mode of ['any', 'none'] as const) {
        const inner = value[mode];
        if (inner !== undefined)
          conditions.push(
            relation(model, key, inner as Record<string, unknown>, mode, translation, resolve),
          );
      }
      continue;
    }
    const { column: col } = column(model, key, translation);
    if (isOperators(value)) {
      for (const [op, operand] of Object.entries(value)) {
        if (operand === undefined) continue;
        if (!OPERATORS.has(op)) {
          throw new InvalidDomainError(
            `'${op}' is not a domain operator (field '${key}').`,
            `Use one of: ${[...OPERATORS].join(', ')}.`,
          );
        }
        conditions.push(condition(col, op, operand, key));
      }
    } else {
      conditions.push(condition(col, 'eq', value, key));
    }
  }
  return conditions;
}

/**
 * A condition through relation `key`: records related to at least one (`any`) or no (`none`) record of the target
 * matching `inner`.
 */
function relation(
  model: AnyModel,
  key: string,
  inner: Readonly<Record<string, unknown>>,
  mode: 'any' | 'none',
  translation: TranslationScope | undefined,
  resolve: ModelResolver | undefined,
): SqlFragment {
  const field = model.fields[key];
  const targetName = (field as { target?: string } | undefined)?.target;
  if (field === undefined || targetName === undefined) {
    throw new InvalidDomainError(
      `'${key}' is not a relation of ${model.name}, so it cannot start a path.`,
      `Paths go through many2one, one2many or many2many fields of ${model.name}.`,
    );
  }
  if (resolve === undefined) {
    throw new InvalidDomainError(
      `Relation path '${key}.…' needs the registry.`,
      'This compiler call has no model resolver.',
    );
  }
  const target = resolve(targetName);
  const conditions = compileDomain(target, inner, translation, resolve);
  const where =
    conditions.length === 0 ? sql.empty : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
  const targets = sql`SELECT ${sql.id('id')} FROM ${sql.id(target.table)}${where}`;
  let match: SqlFragment;
  if (field.kind === 'many2one') {
    const col = sql.id(model.columns[key] ?? '');
    return mode === 'any'
      ? sql`${col} IN (${targets})`
      : sql`(${col} IS NULL OR ${col} NOT IN (${targets}))`;
  }
  if (field.kind === 'one2many') {
    const inverse = sql.id(
      target.columns[(field as { inverseField?: string }).inverseField ?? ''] ?? '',
    );
    const and = conditions.length === 0 ? sql.empty : sql` AND ${sql.join(conditions, sql` AND `)}`;
    match = sql`SELECT ${inverse} FROM ${sql.id(target.table)} WHERE ${inverse} IS NOT NULL${and}`;
  } else {
    const j = junctionTable(model, field, target);
    match = sql`SELECT ${sql.id(j.sourceColumn)} FROM ${sql.id(j.table)} WHERE ${sql.id(j.targetColumn)} IN (${targets})`;
  }
  return mode === 'any'
    ? sql`${sql.id('id')} IN (${match})`
    : sql`${sql.id('id')} NOT IN (${match})`;
}

/** Conditions the environment adds to every search (RFC 0005 §7.4): archived records and company scope. */
export function scopingConditions(model: AnyModel, env: Env): SqlFragment[] {
  const conditions: SqlFragment[] = [];
  if (model.archivable && env.flags.activeTest) {
    const active = model.columns['active'];
    if (active !== undefined) conditions.push(sql`${sql.id(active)} = TRUE`);
  }
  if (model.companyScoped !== undefined && env.flags.checkCompany) {
    const company = model.columns['company'];
    if (company !== undefined) {
      const inCompanies = sql`${sql.id(company)} = ANY(${[...env.companyIds]})`;
      conditions.push(
        model.companyScoped.required
          ? inCompanies
          : sql`(${inCompanies} OR ${sql.id(company)} IS NULL)`,
      );
    }
  }
  return conditions;
}

/** `ORDER BY` from `'field'`, `'field asc'`, `'field desc'` entries, with an `id` tiebreaker. */
export function compileOrder(
  model: AnyModel,
  order: readonly string[] | undefined,
  translation?: TranslationScope,
): SqlFragment {
  const terms: SqlFragment[] = [];
  const specs = order ?? model.order.map((o) => `${o.field} ${o.direction}`);
  let hasId = false;
  for (const spec of specs) {
    const [key, direction = 'asc', ...rest] = spec.split(' ');
    if (key === undefined || rest.length > 0 || (direction !== 'asc' && direction !== 'desc')) {
      throw new InvalidDomainError(
        `order entry '${spec}' is malformed.`,
        "Use 'field', 'field asc' or 'field desc'.",
      );
    }
    const { column: col } = column(model, key, translation);
    if (key === 'id') hasId = true;
    terms.push(direction === 'desc' ? sql`${col} DESC` : sql`${col} ASC`);
  }
  if (!hasId) terms.push(sql`${sql.id('id')} ASC`);
  return sql.join(terms);
}
