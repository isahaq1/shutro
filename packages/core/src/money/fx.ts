/**
 * Dated, per-company currency conversion (RFC 0006 §7.6): rates live in `res.currency.rate`, lookups take the latest
 * rate on or before the date (company-specific rows first, then shared ones), the company currency's rate is 1, and
 * results carry the rate used.
 */

import { compile, sql } from '@shutro/sql';
import type { ScopeInternals } from '../env/env.js';
import { MissingRateError } from '../errors.js';
import type { Currency } from './currency.js';
import { type Decimal, toDecimal } from './decimal.js';
import { Money } from './money.js';

/** Options of a one-off conversion. The date is mandatory (RFC 0006 §7.6). */
export interface ConvertOptions {
  /** The document date (`'YYYY-MM-DD'`), never implicitly today. */
  readonly date: string;
  /** Company whose rates apply; defaults to the environment's company. */
  readonly company?: number | undefined;
  /** Round to the target currency (default `true`). */
  readonly round?: boolean | undefined;
}

/** A conversion result: the amount plus what was used, for audit and exchange-difference entries. */
export interface Conversion {
  readonly money: Money;
  readonly from: Currency;
  readonly to: Currency;
  /** Target units per source unit. */
  readonly rate: Decimal;
  /** Date of the rate row used, `null` for an identity conversion. */
  readonly rateDate: string | null;
}

/** Rates loaded once for a date and company; `convert` is then synchronous. */
export interface PreparedRates {
  readonly date: string;
  readonly company: number;
  /** The company's currency (the rate base). */
  readonly companyCurrency: Currency;
  /**
   * A currency these rates were prepared for (or the company currency), by id: synchronous.
   * @throws {MissingRateError} for an id that was not prepared.
   */
  currency(id: number): Currency;
  /** The rate of a currency relative to the company currency (units per one unit of the company currency). */
  rate(currency: Currency | number): { readonly rate: Decimal; readonly date: string | null };
  /** Converts with the prepared rates; `to` may be a prepared currency id. */
  convert(money: Money, to: Currency | number, options?: { readonly round?: boolean }): Conversion;
}

/** `env.fx`. */
export interface Fx {
  /** Converts one amount. @throws {MissingRateError} when no rate exists on or before the date. */
  convert(money: Money, to: Currency | number, options: ConvertOptions): Promise<Conversion>;
  /** Loads the rates of several currencies in one query. */
  prepare(options: {
    readonly date: string;
    readonly currencies: readonly (Currency | number)[];
    readonly company?: number | undefined;
  }): Promise<PreparedRates>;
}

/** What the fx engine needs from the environment. */
export interface FxHost {
  readonly internals: ScopeInternals;
  currency(id: number): Promise<Currency>;
  companyCurrency(company: number): Promise<Currency>;
}

const RATE_MODEL = 'res.currency.rate';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type RateRow = {
  readonly currency: number;
  readonly rate: Decimal | string;
  readonly date: string | Date;
  readonly [column: string]: unknown;
};

function dateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function lookupRates(
  internals: ScopeInternals,
  currencies: readonly number[],
  date: string,
  company: number,
): Promise<Map<number, { rate: Decimal; date: string }>> {
  const out = new Map<number, { rate: Decimal; date: string }>();
  if (currencies.length === 0) return out;
  if (!DATE.test(date)) {
    throw new MissingRateError(
      `${JSON.stringify(date)} is not a calendar date.`,
      "Pass the document date as 'YYYY-MM-DD'.",
    );
  }
  const model = internals.registry.get(RATE_MODEL).model;
  const col = (key: string): string => {
    const column = model.columns[key];
    if (column === undefined) {
      throw new MissingRateError(
        `The model '${RATE_MODEL}' has no '${key}' field.`,
        'Define res.currency.rate with currency (many2one res.currency), company (many2one res.company, optional), date (f.date) and rate (f.decimal).',
      );
    }
    return column;
  };
  const [currency, companyCol, dateCol, rate] = [
    col('currency'),
    col('company'),
    col('date'),
    col('rate'),
  ];
  await internals.flush(model.name);
  const rows = await internals.query<RateRow>(
    compile(
      sql`SELECT DISTINCT ON (${sql.id(currency)}) ${sql.id(currency)} AS ${sql.id('currency')}, ${sql.id(rate)} AS ${sql.id('rate')}, ${sql.id(dateCol)} AS ${sql.id('date')}
        FROM ${sql.id(model.table)}
        WHERE ${sql.id(currency)} = ANY(${sql.array([...currencies], 'bigint')}) AND ${sql.id(dateCol)} <= ${date}
          AND (${sql.id(companyCol)} = ${company} OR ${sql.id(companyCol)} IS NULL)
        ORDER BY ${sql.id(currency)}, (${sql.id(companyCol)} IS NULL), ${sql.id(dateCol)} DESC`,
    ),
  );
  for (const row of rows)
    out.set(Number(row.currency), { rate: toDecimal(row.rate), date: dateString(row.date) });
  return out;
}

/** Creates `env.fx` for a scope. */
export function createFx(host: FxHost): Fx {
  const resolve = async (c: Currency | number): Promise<Currency> =>
    typeof c === 'number' ? host.currency(c) : c;

  async function prepare(options: {
    readonly date: string;
    readonly currencies: readonly (Currency | number)[];
    readonly company?: number | undefined;
  }): Promise<PreparedRates> {
    const company = options.company ?? host.internals.env.companyId;
    const companyCurrency = await host.companyCurrency(company);
    const wanted = await Promise.all(options.currencies.map(resolve));
    const ids = [
      ...new Set(wanted.map((c) => c.id).filter((id): id is number => id !== undefined)),
    ];
    const rates = await lookupRates(host.internals, ids, options.date, company);
    const byId = new Map<number, Currency>();
    for (const c of [companyCurrency, ...wanted]) if (c.id !== undefined) byId.set(c.id, c);
    const currencyOf = (id: number): Currency => {
      const found = byId.get(id);
      if (found !== undefined) return found;
      throw new MissingRateError(
        `Currency ${id} was not prepared for ${options.date}.`,
        'Pass it in prepare({ currencies }), or use env.fx.convert() for a one-off conversion.',
      );
    };
    const asCurrency = (c: Currency | number): Currency =>
      typeof c === 'number' ? currencyOf(c) : c;
    const rateOf = (
      wantedCurrency: Currency | number,
    ): { readonly rate: Decimal; readonly date: string | null } => {
      const currency = asCurrency(wantedCurrency);
      if (currency.id !== undefined) {
        const found = rates.get(currency.id);
        if (found !== undefined) return found;
      }
      if (currency.code === companyCurrency.code) return { rate: toDecimal(1), date: null };
      throw new MissingRateError(
        `No rate for ${currency.code} on or before ${options.date} for company ${company}.`,
        `Add a res.currency.rate row for ${currency.code} dated ${options.date} or earlier (company ${company} or shared), or prepare the currency.`,
      );
    };
    return {
      date: options.date,
      company,
      companyCurrency,
      currency: currencyOf,
      rate: rateOf,
      convert(money, toCurrency, opts = {}) {
        const to = asCurrency(toCurrency);
        const from = money.currency;
        if (from.code === to.code) {
          return {
            money: Money.of(money.amount, to),
            from,
            to,
            rate: toDecimal(1),
            rateDate: null,
          };
        }
        const source = rateOf(from);
        const target = rateOf(to);
        const rate = target.rate.div(source.rate);
        const amount = money.amount.times(rate);
        const result = Money.of(amount, to);
        return {
          money: opts.round === false ? result : result.round(),
          from,
          to,
          rate,
          rateDate: source.date ?? target.date,
        };
      },
    };
  }

  return {
    async convert(money, to, options) {
      const target = await resolve(to);
      const prepared = await prepare({
        date: options.date,
        currencies: [money.currency, target],
        company: options.company,
      });
      return prepared.convert(money, target, { round: options.round ?? true });
    },
    prepare,
  };
}
