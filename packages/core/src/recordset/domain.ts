/**
 * Compiles a search domain (RFC 0005 §7.1 subset: fields of the model itself, ANDed) plus automatic scoping
 * (`active`, companies) into a WHERE fragment. Relation paths, `or` / `not`, `any` / `all` / `none` and record
 * rules come with the full domain compiler.
 */

import { type SqlFragment, sql } from '@shutro/sql';
import { Decimal as DecimalJs } from 'decimal.js';
import type { Env } from '../env/env.js';
import { InvalidDomainError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';

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
): SqlFragment[] {
  const conditions: SqlFragment[] = [];
  for (const [key, value] of Object.entries(where ?? {})) {
    if (value === undefined) continue;
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
