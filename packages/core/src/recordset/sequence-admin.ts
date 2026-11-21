/**
 * Sequences administered at runtime (Kosh request #31): what a company's numbers look like and when they restart,
 * on top of the code's definitions, and the next number of a counter — never set below one it already issued.
 * Administrators (or superuser scopes) only; every change is audited. Allocation reads the formats in the business
 * transaction, so a change counts from the commit on, in every process.
 */

import {
  counterStatement,
  deleteFormatStatement,
  formatNumber,
  formatOfRow,
  formatsStatement,
  InvalidSequenceError,
  periodKey,
  type SequenceDefinition,
  type SequenceFormat,
  type SequenceReset,
  saveFormatStatement,
  setCounterStatement,
  withFormat,
} from '@shutro/sequence';
import type { ScopeInternals } from '../env/env.js';
import { AccessError, UnknownSequenceError, ValidationError } from '../errors.js';
import { trackSequenceChange } from './audit.js';
import { ensureSequenceTables } from './sequences.js';

/** A sequence as an administrator sees it for the current company. */
export interface SequenceDescription {
  readonly code: string;
  /** What the code declares. */
  readonly declared: SequenceDefinition;
  /** What the administrator changed for this company; `null`: nothing. */
  readonly format: SequenceFormat | null;
  /** What numbers are made with: the declaration with the changes. */
  readonly effective: SequenceDefinition;
  /** The counter period `date` falls in (`''` when it never restarts). */
  readonly period: string;
  /** The next number the counter of that period issues. */
  readonly next: number;
  /** That number as a document would carry it. */
  readonly preview: string;
}

/** `env.sequenceAdmin` (Kosh request #31). */
export interface SequenceAdmin {
  /** Every sequence of the registry — or the ones named — for the current company, as of `date` (today). */
  describe(options?: {
    readonly codes?: readonly string[];
    readonly date?: string;
  }): Promise<SequenceDescription[]>;
  /**
   * Changes how a sequence's numbers look for the current company — prefix, suffix, padding, when it restarts —,
   * or, with `null`, goes back to the code's. Validated like a definition.
   * @throws {InvalidSequenceError} for a format that is none
   */
  setFormat(code: string, format: SequenceFormat | null): Promise<SequenceDescription>;
  /**
   * What `setFormat` (and `setNext`, with `next`) would give, without changing anything: the screen's preview.
   * @throws {InvalidSequenceError} for a format that is none
   */
  preview(
    code: string,
    format: SequenceFormat | null,
    options?: { readonly date?: string; readonly next?: number },
  ): Promise<SequenceDescription>;
  /**
   * Sets the next number of the counter `date` (today) falls in.
   * @throws {ValidationError} when `next` is below the number the counter would issue now: it was used already
   */
  setNext(
    code: string,
    next: number,
    options?: { readonly date?: string },
  ): Promise<SequenceDescription>;
}

const RESETS: readonly SequenceReset[] = ['never', 'yearly', 'monthly', 'daily'];

/** The formats of a sequence for these companies, read through the transaction. */
export async function formatsOf(
  internals: ScopeInternals,
  code: string,
  companies: readonly number[],
): Promise<Map<number, SequenceFormat>> {
  const out = new Map<number, SequenceFormat>();
  if (companies.length === 0) return out;
  for (const row of await internals.query<Record<string, unknown>>(
    formatsStatement(code, companies),
  ))
    out.set(Number(row['company_id']), formatOfRow(row));
  return out;
}

/** A format's parts, each what it may be. @throws {InvalidSequenceError} */
function checkFormat(code: string, format: SequenceFormat | null): void {
  if (format === null) return;
  if (format.reset !== undefined && !RESETS.includes(format.reset))
    throw new InvalidSequenceError(
      `Sequence '${code}': reset ${JSON.stringify(format.reset)} is unknown.`,
      `Use one of: ${RESETS.join(', ')}.`,
    );
  for (const text of [format.prefix, format.suffix])
    if (text !== undefined && (typeof text !== 'string' || text.length > 60))
      throw new InvalidSequenceError(
        `Sequence '${code}': a prefix or suffix is text of at most 60 characters.`,
        'Shorten it.',
      );
}

export function sequenceAdmin(internals: ScopeInternals): SequenceAdmin {
  const { env } = internals;
  const allowed = (): void => {
    if (!env.su && !env.administrator)
      throw new AccessError('sequence', 'manage', {
        problem: 'only administrators can read or change document numbering.',
        hint: 'Use an administrator account (defineGroup({ administrator: true })).',
      });
  };
  const declared = (code: string): SequenceDefinition => {
    const definition = internals.registry.sequences.get(code);
    if (definition === undefined) throw new UnknownSequenceError(code, 'sequenceAdmin');
    return definition;
  };
  const companyOf = (definition: SequenceDefinition): number => {
    if (!definition.perCompany) return 0;
    const company = env.companyId;
    if (company === null || company === undefined)
      throw new ValidationError(
        'sequence',
        ['company'],
        `Sequence '${definition.code}' counts per company.`,
        'Run in a scope with a current company.',
      );
    return company;
  };
  const describeOne = async (code: string, date: string): Promise<SequenceDescription> => {
    const definition = declared(code);
    const company = companyOf(definition);
    const format = (await formatsOf(internals, code, [company])).get(company) ?? null;
    const effective = withFormat(definition, format);
    const period = periodKey(effective, date);
    const [row] = await internals.query<{ next: number | string }>(
      counterStatement(code, company, period),
    );
    const next = row === undefined ? effective.start : Number(row.next);
    return {
      code,
      declared: definition,
      format,
      effective,
      period,
      next,
      preview: formatNumber(effective, next, date),
    };
  };
  const day = (date: string | undefined): string => {
    const value = date ?? env.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new ValidationError(
        'sequence',
        ['date'],
        `'${value}' is not a date.`,
        'Use YYYY-MM-DD.',
      );
    return value;
  };
  return {
    async describe(options = {}) {
      allowed();
      await ensureSequenceTables(internals.driver);
      const date = day(options.date);
      const codes = options.codes ?? [...internals.registry.sequences.keys()].sort();
      const out: SequenceDescription[] = [];
      for (const code of codes) {
        const definition = declared(code);
        // A sequence that counts per company has nothing to show without one.
        if (definition.perCompany && (env.companyId === null || env.companyId === undefined))
          continue;
        out.push(await describeOne(code, date));
      }
      return out;
    },
    async setFormat(code, format) {
      allowed();
      await ensureSequenceTables(internals.driver);
      const definition = declared(code);
      const company = companyOf(definition);
      if (format === null) {
        await internals.query(deleteFormatStatement(code, company));
      } else {
        checkFormat(code, format);
        // Validated as the definition it makes.
        withFormat(definition, format);
        await internals.query(saveFormatStatement(code, company, format));
      }
      trackSequenceChange(internals, { kind: 'format', code, company, format });
      return describeOne(code, env.today());
    },
    async preview(code, format, options = {}) {
      allowed();
      await ensureSequenceTables(internals.driver);
      const date = day(options.date);
      const definition = declared(code);
      const company = companyOf(definition);
      checkFormat(code, format);
      const effective = withFormat(definition, format);
      const period = periodKey(effective, date);
      const [row] = await internals.query<{ next: number | string }>(
        counterStatement(code, company, period),
      );
      const current = row === undefined ? effective.start : Number(row.next);
      const next =
        options.next !== undefined && Number.isSafeInteger(options.next) && options.next >= current
          ? options.next
          : current;
      return {
        code,
        declared: definition,
        format,
        effective,
        period,
        next,
        preview: formatNumber(effective, next, date),
      };
    },
    async setNext(code, next, options = {}) {
      allowed();
      await ensureSequenceTables(internals.driver);
      const date = day(options.date);
      if (!Number.isSafeInteger(next) || next < 0)
        throw new ValidationError(
          'sequence',
          ['next'],
          `${String(next)} is not a number a document can carry.`,
          'Use a whole number, zero or more.',
        );
      const before = await describeOne(code, date);
      const company = companyOf(before.declared);
      const rows = await internals.query<{ next: number | string }>(
        setCounterStatement(code, company, before.period, next),
      );
      if (rows.length === 0 || next < before.next)
        throw new ValidationError(
          'sequence',
          ['next'],
          `Sequence '${code}' already issued numbers up to ${before.next - before.effective.step}.`,
          `The next number is ${before.next} or more: a number is never issued twice.`,
        );
      trackSequenceChange(internals, {
        kind: 'next',
        code,
        company,
        period: before.period,
        from: before.next,
        to: next,
      });
      return describeOne(code, date);
    },
  };
}
