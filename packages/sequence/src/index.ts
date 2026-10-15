/**
 * @packageDocumentation
 * `@shutro/sequence`: document numbering (RFC 0012). The definition (`defineSequence`), the number format, the
 * period key, and the SQL that allocates ranges from the `shutro_sequence` table. Core runs the allocation either in
 * the business transaction (gapless: the counter row stays locked until commit, so a rollback never leaves a hole)
 * or in a short autonomous transaction (standard: no blocking, gaps on rollback).
 */
import { type CompiledSql, compile, sql } from '@shutro/sql';

/** How often the counter restarts. */
export type SequenceReset = 'never' | 'yearly' | 'monthly' | 'daily';

/** A sequence definition. */
export interface SequenceDefinition {
  /** Unique code, referenced by `f.char({ sequence: code })`, e.g. `'sale.order'`. */
  readonly code: string;
  /** Text before the number; placeholders `{year}`, `{yy}`, `{month}`, `{day}` use the document date. */
  readonly prefix: string;
  /** Text after the number; same placeholders. */
  readonly suffix: string;
  /** Minimum digits of the number (zero-padded). */
  readonly padding: number;
  /** First number of each period. */
  readonly start: number;
  readonly step: number;
  /** No holes, ever: allocation serializes concurrent transactions until they commit. Only where the law needs it. */
  readonly gapless: boolean;
  /** One counter per company (default), or one shared counter. */
  readonly perCompany: boolean;
  readonly reset: SequenceReset;
}

/** Input of {@link defineSequence}: everything but `code` is optional. */
export interface SequenceInput {
  readonly code: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly padding?: number;
  readonly start?: number;
  readonly step?: number;
  readonly gapless?: boolean;
  readonly perCompany?: boolean;
  readonly reset?: SequenceReset;
}

/** A sequence definition that cannot be used. */
export class InvalidSequenceError extends Error {
  readonly hint: string;
  constructor(problem: string, hint: string) {
    super(`${problem} ${hint}`);
    this.name = 'InvalidSequenceError';
    this.hint = hint;
  }
}

const CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const PLACEHOLDER = /\{(year|yy|month|day)\}/g;
const RESETS: readonly SequenceReset[] = ['never', 'yearly', 'monthly', 'daily'];

/** Validates and completes a definition. @throws {InvalidSequenceError} */
export function defineSequence(input: SequenceInput): SequenceDefinition {
  if (typeof input.code !== 'string' || !CODE.test(input.code)) {
    throw new InvalidSequenceError(
      `${JSON.stringify(input.code)} is not a sequence code.`,
      "Use a dotted lower-case identifier such as 'sale.order' or 'account.move.invoice'.",
    );
  }
  const padding = input.padding ?? 5;
  if (!Number.isInteger(padding) || padding < 0 || padding > 20) {
    throw new InvalidSequenceError(
      `Sequence '${input.code}': padding ${padding} is out of range.`,
      'Use 0 to 20 digits.',
    );
  }
  const start = input.start ?? 1;
  const step = input.step ?? 1;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(step) || step < 1) {
    throw new InvalidSequenceError(
      `Sequence '${input.code}': start must be a non-negative integer and step a positive one.`,
      'E.g. { start: 1, step: 1 }.',
    );
  }
  const reset = input.reset ?? 'never';
  if (!RESETS.includes(reset)) {
    throw new InvalidSequenceError(
      `Sequence '${input.code}': reset ${JSON.stringify(reset)} is unknown.`,
      `Use one of: ${RESETS.join(', ')}.`,
    );
  }
  for (const [what, text] of [
    ['prefix', input.prefix ?? ''],
    ['suffix', input.suffix ?? ''],
  ] as const) {
    const unknown = text.match(/\{[^}]*\}/g)?.filter((p) => !/^\{(year|yy|month|day)\}$/.test(p));
    if (unknown !== undefined && unknown.length > 0) {
      throw new InvalidSequenceError(
        `Sequence '${input.code}': ${what} uses unknown placeholder(s) ${unknown.join(', ')}.`,
        'Use {year}, {yy}, {month} or {day}.',
      );
    }
  }
  return Object.freeze({
    code: input.code,
    prefix: input.prefix ?? '',
    suffix: input.suffix ?? '',
    padding,
    start,
    step,
    gapless: input.gapless ?? false,
    perCompany: input.perCompany ?? true,
    reset,
  });
}

/** The counter period a document date falls in (`''` when the sequence never resets). */
export function periodKey(definition: SequenceDefinition, date: string): string {
  const [year = '0000', month = '00', day = '00'] = date.split('-');
  switch (definition.reset) {
    case 'never':
      return '';
    case 'yearly':
      return year;
    case 'monthly':
      return `${year}-${month}`;
    case 'daily':
      return `${year}-${month}-${day}`;
  }
}

/** The formatted document number. */
export function formatNumber(definition: SequenceDefinition, number: number, date: string): string {
  const [year = '0000', month = '00', day = '00'] = date.split('-');
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER, (_, name: string) =>
      name === 'year' ? year : name === 'yy' ? year.slice(-2) : name === 'month' ? month : day,
    );
  return `${fill(definition.prefix)}${String(number).padStart(definition.padding, '0')}${fill(definition.suffix)}`;
}

/** The counter table (shared by every sequence; `company_id` 0 means a shared counter). */
export const SEQUENCE_TABLE = 'shutro_sequence';

/** DDL of the counter table, idempotent. */
export function sequenceTableStatements(): readonly CompiledSql[] {
  return [
    Object.freeze({
      text: `CREATE TABLE IF NOT EXISTS "${SEQUENCE_TABLE}" ("code" text NOT NULL, "company_id" bigint NOT NULL DEFAULT 0, "period" text NOT NULL DEFAULT '', "next" bigint NOT NULL, PRIMARY KEY ("code", "company_id", "period"))`,
      params: Object.freeze([]),
    }),
  ];
}

/**
 * The statement that reserves `count` consecutive numbers and returns the first one. Run it in the business
 * transaction for gapless sequences (the row lock is the guarantee) or in a short autonomous one otherwise.
 */
export function allocateStatement(
  definition: SequenceDefinition,
  company: number,
  period: string,
  count: number,
): CompiledSql {
  const total = count * definition.step;
  return compile(
    sql`INSERT INTO ${sql.id(SEQUENCE_TABLE)} (${sql.id('code')}, ${sql.id('company_id')}, ${sql.id('period')}, ${sql.id('next')})
      VALUES (${definition.code}, ${company}, ${period}, ${definition.start + total})
      ON CONFLICT (${sql.id('code')}, ${sql.id('company_id')}, ${sql.id('period')})
      DO UPDATE SET ${sql.id('next')} = ${sql.id(SEQUENCE_TABLE)}.${sql.id('next')} + ${total}
      RETURNING ${sql.id('next')} - ${total} AS ${sql.id('first')}`,
  );
}

/** The numbers of an allocation that returned `first`. */
export function numbersFrom(
  definition: SequenceDefinition,
  first: number,
  count: number,
): number[] {
  return Array.from({ length: count }, (_, i) => first + i * definition.step);
}
