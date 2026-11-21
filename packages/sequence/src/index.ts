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

// ---- formats and counters changed at runtime (Kosh request #31)

/** What an administrator may change of a sequence, per company: how its numbers look and when they restart. */
export interface SequenceFormat {
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
  readonly padding?: number | undefined;
  readonly reset?: SequenceReset | undefined;
}

/** The table of runtime formats (`company_id` 0: a shared sequence). A missing column value keeps the code's. */
export const SEQUENCE_FORMAT_TABLE = 'shutro_sequence_format';

/** DDL of the format table, idempotent. */
export function sequenceFormatTableStatements(): readonly CompiledSql[] {
  return [
    Object.freeze({
      text: `CREATE TABLE IF NOT EXISTS "${SEQUENCE_FORMAT_TABLE}" ("code" text NOT NULL, "company_id" bigint NOT NULL DEFAULT 0, "prefix" text, "suffix" text, "padding" integer, "reset" text, PRIMARY KEY ("code", "company_id"))`,
      params: Object.freeze([]),
    }),
  ];
}

/**
 * The definition numbers are made with: the code's, with what the administrator changed. Validated like a
 * definition. @throws {InvalidSequenceError}
 */
export function withFormat(
  definition: SequenceDefinition,
  format: SequenceFormat | null | undefined,
): SequenceDefinition {
  if (format === null || format === undefined) return definition;
  return defineSequence({
    ...definition,
    prefix: format.prefix ?? definition.prefix,
    suffix: format.suffix ?? definition.suffix,
    padding: format.padding ?? definition.padding,
    reset: format.reset ?? definition.reset,
  });
}

/** The runtime formats of a sequence for some companies. */
export function formatsStatement(code: string, companies: readonly number[]): CompiledSql {
  return compile(
    sql`SELECT ${sql.id('company_id')}, ${sql.id('prefix')}, ${sql.id('suffix')}, ${sql.id('padding')}, ${sql.id('reset')}
      FROM ${sql.id(SEQUENCE_FORMAT_TABLE)}
      WHERE ${sql.id('code')} = ${code} AND ${sql.id('company_id')} = ANY(${sql.array([...companies], 'bigint')})`,
  );
}

/** A stored format row, as read. */
export function formatOfRow(row: Readonly<Record<string, unknown>>): SequenceFormat {
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const padding = row['padding'];
  return {
    prefix: text(row['prefix']),
    suffix: text(row['suffix']),
    padding: padding === null || padding === undefined ? undefined : Number(padding),
    reset: text(row['reset']) as SequenceReset | undefined,
  };
}

/** Saves the runtime format of a sequence for a company (replacing the one there). */
export function saveFormatStatement(
  code: string,
  company: number,
  format: SequenceFormat,
): CompiledSql {
  return compile(
    sql`INSERT INTO ${sql.id(SEQUENCE_FORMAT_TABLE)} (${sql.id('code')}, ${sql.id('company_id')}, ${sql.id('prefix')}, ${sql.id('suffix')}, ${sql.id('padding')}, ${sql.id('reset')})
      VALUES (${code}, ${company}, ${format.prefix ?? null}, ${format.suffix ?? null}, ${format.padding ?? null}, ${format.reset ?? null})
      ON CONFLICT (${sql.id('code')}, ${sql.id('company_id')})
      DO UPDATE SET ${sql.id('prefix')} = EXCLUDED.${sql.id('prefix')}, ${sql.id('suffix')} = EXCLUDED.${sql.id('suffix')}, ${sql.id('padding')} = EXCLUDED.${sql.id('padding')}, ${sql.id('reset')} = EXCLUDED.${sql.id('reset')}`,
  );
}

/** Removes the runtime format: the sequence is the code's again. */
export function deleteFormatStatement(code: string, company: number): CompiledSql {
  return compile(
    sql`DELETE FROM ${sql.id(SEQUENCE_FORMAT_TABLE)} WHERE ${sql.id('code')} = ${code} AND ${sql.id('company_id')} = ${company}`,
  );
}

/** The next number of a counter, if it has issued any. */
export function counterStatement(code: string, company: number, period: string): CompiledSql {
  return compile(
    sql`SELECT ${sql.id('next')} FROM ${sql.id(SEQUENCE_TABLE)}
      WHERE ${sql.id('code')} = ${code} AND ${sql.id('company_id')} = ${company} AND ${sql.id('period')} = ${period}`,
  );
}

/**
 * Sets the next number of a counter — never below the one it would issue now, so no number is issued twice: the
 * statement returns no row when `next` is lower. The row is locked until the transaction ends.
 */
export function setCounterStatement(
  code: string,
  company: number,
  period: string,
  next: number,
): CompiledSql {
  return compile(
    sql`INSERT INTO ${sql.id(SEQUENCE_TABLE)} (${sql.id('code')}, ${sql.id('company_id')}, ${sql.id('period')}, ${sql.id('next')})
      VALUES (${code}, ${company}, ${period}, ${next})
      ON CONFLICT (${sql.id('code')}, ${sql.id('company_id')}, ${sql.id('period')})
      DO UPDATE SET ${sql.id('next')} = EXCLUDED.${sql.id('next')}
      WHERE ${sql.id(SEQUENCE_TABLE)}.${sql.id('next')} <= EXCLUDED.${sql.id('next')}
      RETURNING ${sql.id('next')}`,
  );
}
