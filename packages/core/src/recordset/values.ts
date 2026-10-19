/**
 * Value normalization shared by writes and computes: validates one value against its field and converts it to what
 * the cache holds (Decimal amounts, ids, ...), and converts cached values into what the driver binds.
 */

import { isTranslations, mergeTranslation } from '@shutro/i18n';
import { type SqlFragment, sql } from '@shutro/sql';
import { Decimal as DecimalJs } from 'decimal.js';

/** The environment language and the source language, for translatable values (RFC 0011). */
export interface TranslationContext {
  readonly lang: string;
  readonly source: string;
  /** The current company: company-dependent values are read and written for it. */
  readonly company?: number;
}

/** A company-dependent value as stored: `{ "<companyId>": value }`. */
export type CompanyValues = Readonly<Record<string, unknown>>;

/** The value of a company-dependent field for `company` (the default when the company has none). */
export function companyValue(field: Field, stored: unknown, company: number): unknown {
  const map = (stored ?? {}) as CompanyValues;
  const raw = Object.hasOwn(map, String(company))
    ? map[String(company)]
    : typeof field.default === 'function'
      ? null
      : (field.default ?? null);
  if (raw === null || raw === undefined) return null;
  if (field.kind === 'decimal') return new DecimalJs(String(raw));
  if (field.kind === 'many2one' || field.kind === 'integer' || field.kind === 'float')
    return Number(raw);
  return raw;
}

import { CurrencyMismatchError, UomMismatchError, ValidationError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { toDecimal } from '../money/decimal.js';
import { Money } from '../money/money.js';
import { Quantity } from '../money/quantity.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Throws a {@link ValidationError} for `model`. */
export function fail(
  model: AnyModel,
  fields: readonly string[],
  problem: string,
  hint: string,
): never {
  throw new ValidationError(model.name, fields, problem, hint);
}

/** The PostgreSQL array element type for a field (for `unnest($n::type[])`). */
export function arrayType(field: Field): string {
  // JSON travels as text and is cast in SQL (columnCast): array parameters of jsonb would be re-encoded by the driver.
  if (columnCast(field) !== undefined) return 'text';
  if (field.kind === 'many2one') return 'bigint';
  return field.pgType;
}

/** The SQL cast applied to a bound value before it reaches the column (`jsonb` for json and translatable fields). */
function columnCast(field: Field): 'jsonb' | undefined {
  return field.kind === 'json' || field.translate || field.companyDependent ? 'jsonb' : undefined;
}

/** A reference to the bound value of `column` in the `v` row alias, cast when needed. */
export function valueRef(field: Field, column: string): SqlFragment {
  const ref = sql.id('v', column);
  return columnCast(field) === undefined ? ref : sql`${ref}::jsonb`;
}

/** Converts a cached value into what the driver binds. */
export function bindValue(field: Field, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (DecimalJs.isDecimal(value)) return (value as DecimalJs).toFixed();
  // Inside arrays, postgres.js would type a Date as a scalar timestamptz; an ISO string lets the ::timestamptz[] cast apply.
  if (value instanceof Date) return value.toISOString();
  if (field.kind === 'json' || field.translate || field.companyDependent)
    return JSON.stringify(value);
  return value;
}

/**
 * Validates and normalizes one value for storage in the cache. `siblings` gives the record's current currency / unit
 * id for `Money` / `Quantity` checks.
 */
export function normalize(
  model: AnyModel,
  key: string,
  field: Field,
  value: unknown,
  siblings: (key: string) => unknown,
  translation?: TranslationContext,
): unknown {
  if (field.companyDependent) {
    const company = translation?.company;
    if (company === undefined)
      fail(
        model,
        [key],
        'is company-dependent but no company is known.',
        'Write it inside shutro.run({ company }).',
      );
    const plain =
      value === null
        ? null
        : normalize(
            model,
            key,
            { ...field, companyDependent: false },
            value,
            siblings,
            translation,
          );
    const existing = siblings(key);
    const map =
      typeof existing === 'object' && existing !== null ? (existing as CompanyValues) : {};
    return Object.freeze({
      ...map,
      [String(company)]: DecimalJs.isDecimal(plain) ? (plain as DecimalJs).toFixed() : plain,
    });
  }
  const bad = (what: string, hint: string): never =>
    fail(model, [key], `field '${key}' ${what}.`, hint);
  if (value === null) {
    if (field.required) bad('is required and cannot be null', 'Give the field a value.');
    return null;
  }
  switch (field.kind) {
    case 'many2one': {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
      const ids = (value as { ids?: readonly number[] }).ids;
      if (Array.isArray(ids) && ids.length === 1) return ids[0];
      return bad(
        `expects a record id (got ${typeof value})`,
        'Pass the id of the related record, or a single record.',
      );
    }
    case 'monetary': {
      if (value instanceof Money) {
        const currencyId = siblings((field as unknown as { currencyField: string }).currencyField);
        if (typeof currencyId !== 'number') {
          bad(
            "is given as Money but the record's currency is not known",
            'Load the currency field first, or write a Decimal / string amount.',
          );
        }
        if (value.currency.id !== currencyId) {
          throw new CurrencyMismatchError(
            `Cannot write ${value.toString()} to ${model.name}.${key}: the record's currency is a different one (id ${String(currencyId)}).`,
            "Convert the amount to the record's currency first (env.fx.convert with the document date), or write the record's currency field in the same write.",
          );
        }
        return value.amount;
      }
      return decimalOf(model, key, value);
    }
    case 'quantity': {
      if (value instanceof Quantity) {
        const uomId = siblings((field as unknown as { uomField: string }).uomField);
        if (value.uom.id !== uomId) {
          throw new UomMismatchError(
            `Cannot write ${value.toString()} to ${model.name}.${key}: the record's unit is a different one (id ${String(uomId)}).`,
            "Convert the quantity with .to(uom) first, or write the record's unit field in the same write.",
          );
        }
        return value.value;
      }
      return decimalOf(model, key, value);
    }
    case 'decimal':
      return decimalOf(model, key, value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
        ? value
        : bad('expects an integer', 'Pass a safe integer number.');
    case 'bigint':
      return typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))
        ? value
        : bad('expects an integer', 'Pass a bigint or a safe integer.');
    case 'boolean':
      return typeof value === 'boolean' ? value : bad('expects true or false', 'Pass a boolean.');
    case 'char':
    case 'text':
    case 'html': {
      if (field.translate) {
        if (typeof value !== 'string' && !isTranslations(value))
          return bad(
            'expects a string or a { lang: text } map',
            "Pass 'text' (written in the environment language) or { en_US: 'text', bn_BD: '...' }.",
          );
        const ctx = translation ?? { lang: 'en_US', source: 'en_US' };
        const existing = siblings(key);
        return mergeTranslation(
          isTranslations(existing) ? existing : null,
          value,
          ctx.lang,
          ctx.source,
        );
      }
      return typeof value === 'string' ? value : bad('expects a string', 'Pass a string.');
    }
    case 'date':
      return typeof value === 'string' && DATE.test(value)
        ? value
        : bad(
            "expects a 'YYYY-MM-DD' string",
            "Pass a calendar date such as '2026-10-15', never a JS Date.",
          );
    case 'datetime':
      return value instanceof Date && !Number.isNaN(value.getTime())
        ? value
        : bad('expects a Date', 'Pass a valid JS Date (stored in UTC).');
    case 'selection':
    case 'state': {
      const selection = (
        field as unknown as {
          selection: readonly (readonly [string, string])[] | (() => readonly string[]);
        }
      ).selection;
      const allowed = typeof selection === 'function' ? selection() : selection.map(([k]) => k);
      return typeof value === 'string' && allowed.includes(value)
        ? value
        : bad(`expects one of ${allowed.join(', ')}`, `Got ${JSON.stringify(value)}.`);
    }
    case 'binary':
      return value instanceof Uint8Array ? value : bad('expects bytes', 'Pass a Uint8Array.');
    default:
      return value;
  }
}

function decimalOf(model: AnyModel, key: string, value: unknown): DecimalJs {
  try {
    return toDecimal(value as never);
  } catch (e) {
    const hint =
      e instanceof Error && 'hint' in e
        ? String((e as { hint: unknown }).hint)
        : 'Pass a decimal string or a Decimal.';
    return fail(model, [key], `field '${key}' expects an exact decimal.`, hint);
  }
}
