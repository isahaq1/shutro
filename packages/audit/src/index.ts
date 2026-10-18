/**
 * @packageDocumentation
 * `@shutro/audit`: the append-only trail of tracked changes (RFC 0013). The table (with a trigger that refuses
 * `UPDATE` / `DELETE`), the insert statement core runs at flush points, and the queries that read a trail.
 */
import { type CompiledSql, compile, sql } from '@shutro/sql';

/** What happened. `su` rows record a superuser scope (RFC 0003 §7.6). */
export type AuditAction = 'create' | 'write' | 'unlink' | 'su' | 'elevate' | 'security';

/** One row of the trail. */
export interface AuditEntry {
  readonly id: number;
  /** The transaction timestamp (`env.now()`): every row of a transaction shares it. */
  readonly at: Date;
  /** Groups the rows of one transaction attempt. */
  readonly tx: string;
  readonly uid: number;
  readonly companyId: number;
  readonly su: boolean;
  readonly reason: string | null;
  readonly action: AuditAction;
  readonly model: string | null;
  readonly recordId: number | null;
  /** The changed field for `write` rows; `null` for record-level rows. */
  readonly field: string | null;
  /** JSON: the previous value (`write`), or the snapshot of tracked fields (`unlink`). */
  readonly old: unknown;
  /** JSON: the new value (`write`), or the snapshot of tracked fields (`create`). */
  readonly new: unknown;
}

/** A row to append (the database assigns `id`). */
export type AuditRowInput = Omit<AuditEntry, 'id'>;

/** The trail table. */
export const AUDIT_TABLE = 'shutro_audit';

/** DDL of the trail: the table, its indexes, and a trigger that makes it append-only. Idempotent. */
export function auditTableStatements(): readonly CompiledSql[] {
  const t = `"${AUDIT_TABLE}"`;
  return [
    `CREATE TABLE IF NOT EXISTS ${t} ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "at" timestamp with time zone NOT NULL, "tx" text NOT NULL, "uid" bigint NOT NULL, "company_id" bigint NOT NULL, "su" boolean NOT NULL DEFAULT false, "reason" text, "action" text NOT NULL, "model" text, "record_id" bigint, "field" text, "old" jsonb, "new" jsonb)`,
    `CREATE INDEX IF NOT EXISTS "${AUDIT_TABLE}_record_idx" ON ${t} ("model", "record_id", "id")`,
    `CREATE INDEX IF NOT EXISTS "${AUDIT_TABLE}_at_idx" ON ${t} ("at")`,
    `CREATE OR REPLACE FUNCTION "${AUDIT_TABLE}_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'shutro_audit is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$`,
    `DROP TRIGGER IF EXISTS "${AUDIT_TABLE}_immutable" ON ${t}`,
    `CREATE TRIGGER "${AUDIT_TABLE}_immutable" BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION "${AUDIT_TABLE}_immutable"()`,
  ].map((text) => Object.freeze({ text, params: Object.freeze([]) }));
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** One `INSERT ... SELECT FROM unnest(...)` for any number of rows. */
export function insertAuditStatement(rows: readonly AuditRowInput[]): CompiledSql {
  const columns = [
    'at',
    'tx',
    'uid',
    'company_id',
    'su',
    'reason',
    'action',
    'model',
    'record_id',
    'field',
    'old',
    'new',
  ];
  const arrays = [
    sql.array(
      rows.map((r) => r.at.toISOString()),
      'timestamptz',
    ),
    sql.array(
      rows.map((r) => r.tx),
      'text',
    ),
    sql.array(
      rows.map((r) => r.uid),
      'bigint',
    ),
    sql.array(
      rows.map((r) => r.companyId),
      'bigint',
    ),
    sql.array(
      rows.map((r) => r.su),
      'boolean',
    ),
    sql.array(
      rows.map((r) => r.reason),
      'text',
    ),
    sql.array(
      rows.map((r) => r.action),
      'text',
    ),
    sql.array(
      rows.map((r) => r.model),
      'text',
    ),
    sql.array(
      rows.map((r) => r.recordId),
      'bigint',
    ),
    sql.array(
      rows.map((r) => r.field),
      'text',
    ),
    sql.array(
      rows.map((r) => json(r.old)),
      'text',
    ),
    sql.array(
      rows.map((r) => json(r.new)),
      'text',
    ),
  ];
  const names = columns.map((c) => sql.id(c));
  const refs = columns.map((c) =>
    c === 'old' || c === 'new' ? sql`${sql.id('v', c)}::jsonb` : sql.id('v', c),
  );
  return compile(
    sql`INSERT INTO ${sql.id(AUDIT_TABLE)} (${sql.join(names)}) SELECT ${sql.join(refs)} FROM unnest(${sql.join(arrays)}) AS ${sql.id('v')}(${sql.join(names)})`,
  );
}

/** Filters of {@link trailQuery}. */
export interface TrailFilter {
  readonly model?: string | undefined;
  readonly recordIds?: readonly number[] | undefined;
  readonly field?: string | undefined;
  readonly uid?: number | undefined;
  readonly action?: AuditAction | undefined;
  /** Rows at or after this time. */
  readonly since?: Date | undefined;
  /** Rows older than this row id: the cursor of the next page (the `id` of the last row of the previous one). */
  readonly before?: number | undefined;
  /** Newest first; default 100. */
  readonly limit?: number | undefined;
}

/** The query that reads a trail, newest first. */
export function trailQuery(filter: TrailFilter = {}): CompiledSql {
  const conditions = [];
  if (filter.model !== undefined) conditions.push(sql`${sql.id('model')} = ${filter.model}`);
  if (filter.recordIds !== undefined)
    conditions.push(
      sql`${sql.id('record_id')} = ANY(${sql.array([...filter.recordIds], 'bigint')})`,
    );
  if (filter.field !== undefined) conditions.push(sql`${sql.id('field')} = ${filter.field}`);
  if (filter.uid !== undefined) conditions.push(sql`${sql.id('uid')} = ${filter.uid}`);
  if (filter.action !== undefined) conditions.push(sql`${sql.id('action')} = ${filter.action}`);
  if (filter.since !== undefined) conditions.push(sql`${sql.id('at')} >= ${filter.since}`);
  if (filter.before !== undefined) conditions.push(sql`${sql.id('id')} < ${filter.before}`);
  const where =
    conditions.length === 0 ? sql.empty : sql` WHERE ${sql.join(conditions, sql` AND `)}`;
  return compile(
    sql`SELECT ${sql.id('id')}, ${sql.id('at')}, ${sql.id('tx')}, ${sql.id('uid')}, ${sql.id('company_id')}, ${sql.id('su')}, ${sql.id('reason')}, ${sql.id('action')}, ${sql.id('model')}, ${sql.id('record_id')}, ${sql.id('field')}, ${sql.id('old')}, ${sql.id('new')} FROM ${sql.id(AUDIT_TABLE)}${where} ORDER BY ${sql.id('id')} DESC LIMIT ${filter.limit ?? 100}`,
  );
}

/** Anything that runs a compiled statement (a driver, a connection, a scope). */
export interface Runner {
  query<R extends Record<string, unknown>>(query: CompiledSql): Promise<readonly R[]>;
}

/** Reads a trail, newest first. */
export async function readTrail(runner: Runner, filter: TrailFilter = {}): Promise<AuditEntry[]> {
  const rows = await runner.query<Record<string, unknown>>(trailQuery(filter));
  return rows.map((r) => ({
    id: Number(r['id']),
    at: r['at'] instanceof Date ? r['at'] : new Date(String(r['at'])),
    tx: String(r['tx']),
    uid: Number(r['uid']),
    companyId: Number(r['company_id']),
    su: Boolean(r['su']),
    reason: r['reason'] === null ? null : String(r['reason']),
    action: String(r['action']) as AuditAction,
    model: r['model'] === null ? null : String(r['model']),
    recordId: r['record_id'] === null ? null : Number(r['record_id']),
    field: r['field'] === null ? null : String(r['field']),
    old: r['old'],
    new: r['new'],
  }));
}
