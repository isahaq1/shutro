/**
 * Document numbering at runtime (RFC 0012 §7.2–7.4): range allocation per (company, period) group, in the business
 * transaction for gapless sequences or in a short autonomous one otherwise; filling sequence fields at create time;
 * `records.assignNumber()` for manual numbering.
 */

import type { Driver } from '@shutro/driver-pg';
import {
  allocateStatement,
  formatNumber,
  numbersFrom,
  periodKey,
  type SequenceDefinition,
  sequenceTableStatements,
} from '@shutro/sequence';
import type { ScopeInternals } from '../env/env.js';
import { UnknownSequenceError, ValidationError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { trackChange } from './audit.js';
import type { ComputeHost } from './compute.js';

/** The placeholder of a manually numbered document (RFC 0012 §7.4). */
export const UNNUMBERED = '/';

const ensured = new WeakSet<Driver>();

async function ensureTable(driver: Driver): Promise<void> {
  if (ensured.has(driver)) return;
  for (const statement of sequenceTableStatements()) await driver.query(statement);
  ensured.add(driver);
}

interface Group {
  readonly company: number;
  readonly period: string;
  readonly date: string;
  readonly members: number[]; // indexes into the request
}

function groupRequests(
  definition: SequenceDefinition,
  requests: readonly { readonly company: number | null; readonly date: string }[],
): Group[] {
  const groups = new Map<string, Group>();
  requests.forEach((request, i) => {
    const company = definition.perCompany ? (request.company ?? 0) : 0;
    const period = periodKey(definition, request.date);
    const key = `${company}|${period}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { company, period, date: request.date, members: [] };
      groups.set(key, group);
    }
    group.members.push(i);
  });
  return [...groups.values()];
}

/** Allocates one formatted number per request, in one statement per (company, period) group. */
export async function allocateNumbers(
  internals: ScopeInternals,
  definition: SequenceDefinition,
  requests: readonly { readonly company: number | null; readonly date: string }[],
): Promise<string[]> {
  const out: string[] = new Array(requests.length);
  if (requests.length === 0) return out;
  await ensureTable(internals.driver);
  for (const group of groupRequests(definition, requests)) {
    const statement = allocateStatement(
      definition,
      group.company,
      group.period,
      group.members.length,
    );
    const rows = definition.gapless
      ? await internals.query<{ first: number | string }>(statement) // row lock held until commit: no gaps
      : await internals.driver.transaction({ isolation: 'read committed' }, (conn) =>
          conn.query<{ first: number | string }>(statement),
        ); // committed at once: no blocking, gaps on rollback
    const first = Number(rows[0]?.first);
    const numbers = numbersFrom(definition, first, group.members.length);
    group.members.forEach((index, i) => {
      out[index] = formatNumber(
        definition,
        numbers[i] as number,
        requests[index]?.date ?? group.date,
      );
    });
  }
  return out;
}

/** Sequence fields of a model with their options. */
export function sequenceFields(model: AnyModel): {
  readonly key: string;
  readonly field: Field;
  readonly options: NonNullable<Field['sequence']>;
}[] {
  return Object.entries(model.fields)
    .filter(([, f]) => f.sequence !== undefined)
    .map(([key, field]) => ({
      key,
      field,
      options: field.sequence as NonNullable<Field['sequence']>,
    }));
}

function definitionOf(
  internals: ScopeInternals,
  model: AnyModel,
  key: string,
  code: string,
): SequenceDefinition {
  const definition = internals.registry.sequences.get(code);
  if (definition === undefined) throw new UnknownSequenceError(code, `${model.name}.${key}`);
  return definition;
}

function companyOf(
  model: AnyModel,
  values: Map<string, unknown>,
  internals: ScopeInternals,
): number | null {
  if (model.companyScoped === undefined) return internals.env.companyId;
  const company = values.get('company');
  return typeof company === 'number' ? company : null;
}

function dateOf(
  values: Map<string, unknown>,
  dateField: string | undefined,
  fallback: string,
): string {
  const value = dateField === undefined ? undefined : values.get(dateField);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return fallback;
}

/** Fills the `on: 'create'` sequence fields of rows that have no value (RFC 0012 §7.4). */
export async function fillSequences(
  internals: ScopeInternals,
  model: AnyModel,
  rows: readonly { readonly stored: Map<string, unknown> }[],
): Promise<void> {
  for (const { key, options } of sequenceFields(model)) {
    if (options.on === 'manual') continue;
    const definition = definitionOf(internals, model, key, options.code);
    const pending = rows.filter(
      (r) => r.stored.get(key) === null || r.stored.get(key) === undefined,
    );
    if (pending.length === 0) continue;
    const today = internals.env.today();
    const numbers = await allocateNumbers(
      internals,
      definition,
      pending.map((r) => ({
        company: companyOf(model, r.stored, internals),
        date: dateOf(r.stored, options.dateField, today),
      })),
    );
    pending.forEach((r, i) => {
      r.stored.set(key, numbers[i]);
    });
  }
}

/** `records.assignNumber(key, { date })`: numbers unnumbered records through the unit of work. */
export async function assignNumbers(
  host: ComputeHost,
  model: AnyModel,
  ids: readonly number[],
  key: string,
  options: { readonly date?: string | undefined },
): Promise<void> {
  const { internals } = host;
  const field = model.fields[key];
  if (field === undefined || field.sequence === undefined) {
    throw new ValidationError(
      model.name,
      [key],
      `'${key}' is not a sequence field.`,
      "Declare it with f.char({ sequence: { code, on: 'manual' } }).",
    );
  }
  if (ids.length === 0) return;
  const definition = definitionOf(internals, model, key, field.sequence.code);
  const needed = new Set(['id', key]);
  if (model.companyScoped !== undefined) needed.add('company');
  if (field.sequence.dateField !== undefined) needed.add(field.sequence.dateField);
  await host.load(model, ids, { fields: needed, relations: new Map() });
  const numbered = ids.filter((id) => {
    const current = host.values(model.name, id)?.get(key);
    return current !== null && current !== undefined && current !== UNNUMBERED;
  });
  if (numbered.length > 0) {
    throw new ValidationError(
      model.name,
      [key],
      `record(s) ${numbered.join(', ')} already have a number.`,
      'A document is numbered once; assignNumber() only takes unnumbered records.',
    );
  }
  const today = internals.env.today();
  const numbers = await allocateNumbers(
    internals,
    definition,
    ids.map((id) => {
      const values = host.values(model.name, id, true) as Map<string, unknown>;
      return {
        company: companyOf(model, values, internals),
        date: options.date ?? dateOf(values, field.sequence?.dateField, today),
      };
    }),
  );
  ids.forEach((id, i) => {
    const values = host.values(model.name, id, true) as Map<string, unknown>;
    internals.journal({
      kind: 'value',
      model: model.name,
      id,
      key,
      had: values.has(key),
      prev: values.get(key),
      wasDirty: internals.isDirty(model.name, id, key),
    });
    trackChange(internals, model, id, key, values.get(key), numbers[i], (k) => values.get(k));
    values.set(key, numbers[i]);
    internals.markDirty(model.name, id, key);
  });
  internals.trigger(model.name, key, ids);
}
