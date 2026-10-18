/**
 * Transactional events and jobs (RFC 0018 §7.2–§7.3). `env.emit` / `env.enqueue` insert in the business transaction,
 * so events and jobs exist if and only if their transaction committed. Workers run each event or job inside a
 * `run()` scope as the user who emitted / enqueued it; the subscription cursor advances, or the job is marked done,
 * in that same transaction: database effects of a handler happen exactly once.
 */
import type { Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';

export const OUTBOX_CHANNEL = 'shutro_outbox';
export const JOB_CHANNEL = 'shutro_job';

const DDL = [
  'CREATE TABLE IF NOT EXISTS "shutro_outbox" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "topic" text NOT NULL, "payload" jsonb NOT NULL, "created_at" timestamp with time zone NOT NULL DEFAULT now(), "uid" bigint NOT NULL, "company_id" bigint NOT NULL, "groups" text[] NOT NULL DEFAULT \'{}\')',
  'CREATE INDEX IF NOT EXISTS "shutro_outbox_topic_id_idx" ON "shutro_outbox" ("topic", "id")',
  'CREATE TABLE IF NOT EXISTS "shutro_subscription" ("name" text PRIMARY KEY, "topic" text NOT NULL, "last_id" bigint NOT NULL DEFAULT 0, "attempts" integer NOT NULL DEFAULT 0, "retry_at" timestamp with time zone, "last_error" text)',
  'CREATE TABLE IF NOT EXISTS "shutro_dead_event" ("subscription" text NOT NULL, "event_id" bigint NOT NULL, "error" text NOT NULL, "at" timestamp with time zone NOT NULL DEFAULT now(), PRIMARY KEY ("subscription", "event_id"))',
  'CREATE TABLE IF NOT EXISTS "shutro_job" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "name" text NOT NULL, "payload" jsonb NOT NULL, "key" text, "state" text NOT NULL DEFAULT \'pending\', "run_at" timestamp with time zone NOT NULL DEFAULT now(), "attempts" integer NOT NULL DEFAULT 0, "max_attempts" integer NOT NULL DEFAULT 5, "locked_at" timestamp with time zone, "last_error" text, "created_at" timestamp with time zone NOT NULL DEFAULT now(), "done_at" timestamp with time zone, "uid" bigint NOT NULL, "company_id" bigint NOT NULL, "groups" text[] NOT NULL DEFAULT \'{}\')',
  'CREATE INDEX IF NOT EXISTS "shutro_job_due_idx" ON "shutro_job" ("state", "run_at")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "shutro_job_key_idx" ON "shutro_job" ("key") WHERE "key" IS NOT NULL AND "state" IN (\'pending\', \'running\')',
];

/** Statements creating the event and job tables (also created on first use). */
export function eventTableStatements(): readonly {
  readonly text: string;
  readonly params: readonly [];
}[] {
  return DDL.map((text) => ({ text, params: [] as [] }));
}

type Query = <R extends Record<string, unknown>>(q: {
  text: string;
  params: readonly unknown[];
}) => Promise<readonly R[]>;

const ensured = new WeakSet<object>();

/** Creates the tables once per driver (or per query function). */
export async function ensureEventTables(owner: object, query: Query): Promise<void> {
  if (ensured.has(owner)) return;
  for (const text of DDL) await query({ text, params: [] });
  ensured.add(owner);
}

/** Who emitted / enqueued: handlers run as them. */
export interface Actor {
  readonly uid: number;
  readonly companyId: number;
  readonly groups: readonly string[];
}

const TOPIC = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

function assertName(kind: string, name: string): void {
  if (!TOPIC.test(name))
    throw new TypeError(
      `${JSON.stringify(name)} is not a valid ${kind} name. Use dotted snake_case, e.g. 'invoice.posted'.`,
    );
}

/** `env.emit`: inserts the event in the current transaction. */
export async function emitEvent(
  query: Query,
  actor: Actor,
  topic: string,
  payload: unknown,
): Promise<number> {
  assertName('topic', topic);
  const [row] = await query<{ id: number }>(
    compile(
      sql`INSERT INTO shutro_outbox (topic, payload, uid, company_id, groups) VALUES (${topic}, (${sql.param(JSON.stringify(payload ?? null), 'text')})::jsonb, ${actor.uid}, ${actor.companyId}, ${sql.array([...actor.groups], 'text')}) RETURNING id`,
    ),
  );
  await query(compile(sql`SELECT pg_notify(${OUTBOX_CHANNEL}, ${topic})`));
  return Number(row?.id);
}

/** Options of `env.enqueue`. */
export interface EnqueueOptions {
  /** Not before this instant. */
  readonly runAt?: Date;
  /** Deduplication: while a job with this key is pending or running, enqueueing it again does nothing. */
  readonly key?: string;
  /** Attempts before the job is marked `dead` (default 5). */
  readonly attempts?: number;
}

/** `env.enqueue`: inserts the job in the current transaction. Returns its id, or `null` when deduplicated. */
export async function enqueueJob(
  query: Query,
  actor: Actor,
  name: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<number | null> {
  assertName('job', name);
  const attempts = options.attempts ?? 5;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new TypeError('attempts must be a positive integer.');
  const rows = await query<{ id: number }>(
    compile(
      sql`INSERT INTO shutro_job (name, payload, key, run_at, max_attempts, uid, company_id, groups)
          VALUES (${name}, (${sql.param(JSON.stringify(payload ?? null), 'text')})::jsonb, ${options.key ?? null}, ${options.runAt ?? new Date(0)}, ${attempts}, ${actor.uid}, ${actor.companyId}, ${sql.array([...actor.groups], 'text')})
          ON CONFLICT ("key") WHERE "key" IS NOT NULL AND "state" IN ('pending', 'running') DO NOTHING RETURNING id`,
    ),
  );
  await query(compile(sql`SELECT pg_notify(${JOB_CHANNEL}, ${name})`));
  return rows[0] === undefined ? null : Number(rows[0].id);
}

/** Exponential backoff with a cap, in milliseconds (attempt 1 → 1 s, 2 → 2 s, … ≤ 10 min). */
export function backoffMs(attempt: number): number {
  return Math.min(600_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Releases jobs whose worker died while running them (locked longer than `staleMs`). */
export async function releaseStale(driver: Driver, staleMs: number): Promise<number> {
  const rows = await driver.query(
    compile(
      sql`UPDATE shutro_job SET state = 'pending', locked_at = NULL WHERE state = 'running' AND locked_at < now() - make_interval(secs => ${staleMs / 1000}) RETURNING id`,
    ),
  );
  return rows.length;
}
