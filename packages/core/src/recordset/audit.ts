/**
 * Collecting the audit trail (RFC 0013 §7.2–7.3): rows of tracked changes are gathered per transaction attempt,
 * coalesced per (record, field) and written at flush points in one statement, in the same transaction as the data.
 */

import {
  AUDIT_TABLE,
  type AuditEntry,
  type AuditRowInput,
  auditTableStatements,
  insertAuditStatement,
  readTrail,
  type TrailFilter,
} from '@shutro/audit';
import type { Driver } from '@shutro/driver-pg';
import { Decimal as DecimalJs } from 'decimal.js';
import type { ScopeInternals } from '../env/env.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { Money } from '../money/money.js';

const ensured = new WeakSet<Driver>();

async function ensureTable(driver: Driver): Promise<void> {
  if (ensured.has(driver)) return;
  // Created by migrations in production (the application role may not own the schema); on first use otherwise.
  const [row] = await driver.query<{ present: boolean }>({
    text: `SELECT to_regclass('${AUDIT_TABLE}') IS NOT NULL AS present`,
    params: [],
  });
  if (row?.present !== true)
    for (const statement of auditTableStatements()) await driver.query(statement);
  ensured.add(driver);
}

/** True when the model's `tracking` list or the field's `tracking` option names the field. */
export function isTracked(model: AnyModel, key: string): boolean {
  const field = model.fields[key];
  if (field === undefined || field.kind === 'one2many' || field.kind === 'many2many') return false;
  return field.tracking || model.tracking.includes(key);
}

/** Tracked field keys of a model (with the sibling currency / unit fields needed to render money). */
export function trackedKeys(model: AnyModel): Set<string> {
  const keys = new Set<string>();
  for (const key of Object.keys(model.fields)) {
    if (!isTracked(model, key)) continue;
    keys.add(key);
    const field = model.fields[key] as
      | (Field & { currencyField?: string; uomField?: string })
      | undefined;
    if (field?.currencyField !== undefined) keys.add(field.currencyField);
    if (field?.uomField !== undefined) keys.add(field.uomField);
  }
  return keys;
}

/** The JSON form of a cached value, as `read()` would return it (RFC 0013 §7.3). */
export function auditValue(
  internals: ScopeInternals,
  model: AnyModel,
  key: string,
  raw: unknown,
  siblings: (key: string) => unknown,
): unknown {
  if (raw === undefined || raw === null) return null;
  if (model.fields[key]?.encrypted) return '[encrypted]';
  const field = model.fields[key] as
    | (Field & { currencyField?: string; uomField?: string })
    | undefined;
  if (field?.kind === 'monetary' && DecimalJs.isDecimal(raw)) {
    const currencyId = siblings(field.currencyField ?? '');
    const currency =
      typeof currencyId === 'number' ? internals.cache.currencies.get(currencyId) : undefined;
    if (currency !== undefined) return Money.of(raw as DecimalJs, currency).toJSON(); // rounded like read()
    return { amount: (raw as DecimalJs).toFixed(), currency: null };
  }
  if (field?.kind === 'quantity' && DecimalJs.isDecimal(raw)) {
    const uomId = siblings(field.uomField ?? '');
    const uom = typeof uomId === 'number' ? internals.cache.uoms.get(uomId) : undefined;
    return { value: (raw as DecimalJs).toFixed(), uom: uom?.name ?? null };
  }
  if (DecimalJs.isDecimal(raw)) return (raw as DecimalJs).toFixed();
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'bigint') return raw.toString();
  return raw;
}

function base(
  internals: ScopeInternals,
): Omit<AuditRowInput, 'action' | 'model' | 'recordId' | 'field' | 'old' | 'new'> {
  const { env } = internals;
  return {
    at: env.now(),
    tx: internals.tx,
    uid: env.uid,
    companyId: env.companyId,
    su: env.su,
    reason: env.reason ?? null,
  };
}

/** Records a change of a tracked field (no-op for untracked fields or with `flags.tracking` off). */
export function trackChange(
  internals: ScopeInternals,
  model: AnyModel,
  id: number,
  key: string,
  prev: unknown,
  next: unknown,
  siblings: (key: string) => unknown,
): void {
  if (!internals.env.flags.tracking || !isTracked(model, key) || id < 0) return;
  internals.auditRows.push({
    ...base(internals),
    action: 'write',
    model: model.name,
    recordId: id,
    field: key,
    old: auditValue(internals, model, key, prev, siblings),
    new: auditValue(internals, model, key, next, siblings),
  });
}

/** Records a creation or deletion with a snapshot of the tracked fields. */
export function trackSnapshot(
  internals: ScopeInternals,
  model: AnyModel,
  id: number,
  action: 'create' | 'unlink',
  values: ReadonlyMap<string, unknown>,
): void {
  if (!internals.env.flags.tracking || id < 0) return;
  const snapshot: Record<string, unknown> = {};
  let any = false;
  for (const key of Object.keys(model.fields)) {
    if (!isTracked(model, key)) continue;
    any = true;
    snapshot[key] = values.has(key)
      ? auditValue(internals, model, key, values.get(key), (k) => values.get(k))
      : null;
  }
  if (!any) return;
  internals.auditRows.push({
    ...base(internals),
    action,
    model: model.name,
    recordId: id,
    field: null,
    old: action === 'unlink' ? snapshot : null,
    new: action === 'create' ? snapshot : null,
  });
}

/** Records a superuser scope (RFC 0003 §7.6). */
export function trackSuperuser(internals: ScopeInternals, reason: string): void {
  if (!internals.env.flags.tracking) return;
  internals.auditRows.push({
    ...base(internals),
    su: true,
    reason,
    action: 'su',
    model: null,
    recordId: null,
    field: null,
    old: null,
    new: null,
  });
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Coalesces `write` rows per (model, record, field): the first old, the last new; unchanged values are dropped. */
export function coalesceAudit(rows: readonly AuditRowInput[]): AuditRowInput[] {
  const out: AuditRowInput[] = [];
  const writes = new Map<string, number>();
  const creates = new Map<string, number>();
  for (const row of rows) {
    if (row.action !== 'write') {
      if (row.action === 'create') creates.set(`${row.model}|${row.recordId}`, out.length);
      out.push(row);
      continue;
    }
    // A value first computed or numbered in the transaction that created the record belongs to its creation.
    const created = creates.get(`${row.model}|${row.recordId}`);
    if (created !== undefined && row.field !== null && (row.old ?? null) === null) {
      const createRow = out[created] as AuditRowInput;
      const snapshot = { ...(createRow.new as Record<string, unknown>) };
      if ((snapshot[row.field] ?? null) === null) {
        snapshot[row.field] = row.new;
        out[created] = { ...createRow, new: snapshot };
        continue;
      }
    }
    const key = `${row.model}|${row.recordId}|${row.field}`;
    const at = writes.get(key);
    if (at === undefined) {
      writes.set(key, out.length);
      out.push(row);
    } else {
      const first = out[at] as AuditRowInput;
      out[at] = {
        ...first,
        new: row.new,
        uid: row.uid,
        su: first.su || row.su,
        reason: first.reason ?? row.reason,
      };
    }
  }
  return out.filter((row) => row.action !== 'write' || !same(row.old, row.new));
}

/** Writes the pending rows of `model` (or every row) in one statement. */
export async function flushAudit(internals: ScopeInternals, model?: string): Promise<void> {
  const rows = internals.auditRows;
  if (rows.length === 0) return;
  const take = model === undefined ? rows.splice(0) : [];
  if (model !== undefined) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]?.model === model) take.unshift(...rows.splice(i, 1));
    }
  }
  const coalesced = coalesceAudit(take);
  if (coalesced.length === 0) return;
  await ensureTable(internals.driver);
  await internals.query(insertAuditStatement(coalesced));
}

/** `records.trail()`: the rows of these records, newest first, after a flush. */
export async function trailOf(
  internals: ScopeInternals,
  model: AnyModel,
  ids: readonly number[],
  filter: Omit<TrailFilter, 'model' | 'recordIds'>,
): Promise<AuditEntry[]> {
  await internals.flush();
  return readTrail(
    { query: (q) => internals.query(q) },
    { ...filter, model: model.name, recordIds: ids },
  );
}
