/**
 * Event subscribers and job workers (RFC 0018 §7.2–§7.3). Both claim work with row locks (`SKIP LOCKED`), run the
 * handler in a `run()` scope as the emitting / enqueuing user, and record success in the handler's transaction.
 * Failures are retried with exponential backoff; after the attempts run out, events go to `shutro_dead_event` and
 * jobs to state `dead`.
 */
import type { Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import type { Env, RunOptions } from '../env/env.js';
import { SYSTEM_UID } from '../env/identity.js';
import { backoffMs, ensureEventTables, JOB_CHANNEL, OUTBOX_CHANNEL } from './events.js';

/** A committed event as subscribers receive it. */
export interface DeliveredEvent {
  readonly id: number;
  readonly topic: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly uid: number;
  readonly companyId: number;
}

/** A job as handlers receive it. */
export interface RunningJob {
  readonly id: number;
  readonly name: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** A subscriber or worker: `drain()` processes what is due now; `start()` keeps processing until `stop()`. */
export interface Worker {
  /** Processes everything due now; resolves with the number of events / jobs handled (successfully or not). */
  drain(): Promise<number>;
  /** Processes in the background: woken by NOTIFY, and polling every `pollMs` for retries and scheduled work. */
  start(): void;
  stop(): Promise<void>;
}

/** What workers need from a Shutro instance. */
export interface WorkerHost {
  readonly driver: Driver;
  run<T>(options: RunOptions, fn: (env: Env) => Promise<T>): Promise<T>;
  bootstrap<T>(
    options: { readonly reason: string; readonly company?: number },
    fn: (env: Env) => Promise<T>,
  ): Promise<T>;
}

const SKIPPED = Symbol('skipped');

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `fn` as the actor of an event or job (the system for bootstrap-time work). */
function asActor<T>(
  host: WorkerHost,
  actor: { uid: number; companyId: number; groups: readonly string[] },
  reason: string,
  fn: (env: Env) => Promise<T>,
): Promise<T> {
  if (actor.uid === SYSTEM_UID)
    return host.bootstrap(
      { reason, ...(actor.companyId > 0 ? { company: actor.companyId } : {}) },
      fn,
    );
  return host.run({ user: actor.uid, company: actor.companyId, groups: actor.groups, reason }, fn);
}

function loop(
  host: WorkerHost,
  channel: string,
  pollMs: number,
  step: () => Promise<boolean>,
): Worker {
  let running = false;
  let current: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unlisten: (() => Promise<void>) | undefined;
  let wake = false;
  const drain = async (): Promise<number> => {
    let n = 0;
    while (await step()) n++;
    return n;
  };
  const tick = (): void => {
    if (!running) return;
    current = drain()
      .catch(() => 0)
      .finally(() => {
        if (!running) return;
        if (wake) {
          wake = false;
          tick();
        } else timer = setTimeout(tick, pollMs);
      });
  };
  return {
    drain,
    start() {
      if (running) return;
      running = true;
      void host.driver
        .listen(channel, () => {
          wake = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
            tick();
          }
        })
        .then((stop) => {
          unlisten = stop;
        });
      tick();
    },
    async stop() {
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      await current;
      await unlisten?.();
    },
  };
}

/**
 * Delivers events of `topic` to `handler`, in id order, at least once; the cursor advances in the handler's
 * transaction (exactly once for its database work). One active delivery per subscription name across processes.
 */
export function subscribe(
  host: WorkerHost,
  name: string,
  topic: string,
  handler: (event: DeliveredEvent, env: Env) => Promise<void>,
  options: { readonly attempts?: number; readonly pollMs?: number } = {},
): Worker {
  const attempts = options.attempts ?? 10;
  const step = async (): Promise<boolean> => {
    await ensureEventTables(host.driver, (q) => host.driver.query(q));
    await host.driver.query(
      compile(
        sql`INSERT INTO shutro_subscription (name, topic) VALUES (${name}, ${topic}) ON CONFLICT (name) DO NOTHING`,
      ),
    );
    const [sub] = await host.driver.query<{
      last_id: string | number;
      attempts: number;
      due: boolean;
    }>(
      compile(
        sql`SELECT last_id, attempts, (retry_at IS NULL OR retry_at <= now()) AS due FROM shutro_subscription WHERE name = ${name}`,
      ),
    );
    if (sub === undefined || !sub.due) return false;
    const lastId = Number(sub.last_id);
    const [row] = await host.driver.query<{
      id: string | number;
      payload: unknown;
      created_at: Date;
      uid: string | number;
      company_id: string | number;
      groups: string[];
    }>(
      compile(
        sql`SELECT id, payload, created_at, uid, company_id, groups FROM shutro_outbox WHERE topic = ${topic} AND id > ${lastId} ORDER BY id LIMIT 1`,
      ),
    );
    if (row === undefined) return false;
    const event: DeliveredEvent = {
      id: Number(row.id),
      topic,
      payload: row.payload,
      createdAt: row.created_at,
      uid: Number(row.uid),
      companyId: Number(row.company_id),
    };
    try {
      await asActor(
        host,
        { uid: event.uid, companyId: event.companyId, groups: row.groups },
        `event ${name}`,
        async (env) => {
          const [locked] = await env.sql<{
            last_id: string | number;
          }>`SELECT last_id FROM shutro_subscription WHERE name = ${name} FOR UPDATE SKIP LOCKED`;
          if (locked === undefined || Number(locked.last_id) !== lastId) throw SKIPPED; // another process has it
          await handler(event, env);
          await env.sql`UPDATE shutro_subscription SET last_id = ${event.id}, attempts = 0, retry_at = NULL, last_error = NULL WHERE name = ${name}`;
        },
      );
      return true;
    } catch (error) {
      if (error === SKIPPED) return false;
      const tries = sub.attempts + 1;
      if (tries >= attempts) {
        await host.driver.transaction({ isolation: 'read committed' }, async (conn) => {
          await conn.query(
            compile(
              sql`INSERT INTO shutro_dead_event (subscription, event_id, error) VALUES (${name}, ${event.id}, ${message(error)}) ON CONFLICT DO NOTHING`,
            ),
          );
          await conn.query(
            compile(
              sql`UPDATE shutro_subscription SET last_id = ${event.id}, attempts = 0, retry_at = NULL, last_error = ${message(error)} WHERE name = ${name}`,
            ),
          );
        });
        return true;
      }
      await host.driver.query(
        compile(
          sql`UPDATE shutro_subscription SET attempts = ${tries}, retry_at = now() + make_interval(secs => ${backoffMs(tries) / 1000}), last_error = ${message(error)} WHERE name = ${name}`,
        ),
      );
      return false;
    }
  };
  return loop(host, OUTBOX_CHANNEL, options.pollMs ?? 1000, step);
}

/**
 * Runs due jobs with the given handlers (any number of workers and processes: `FOR UPDATE SKIP LOCKED`). A job is
 * marked done in its handler's transaction; a failure is retried with backoff until its attempts run out (`dead`).
 */
export function work(
  host: WorkerHost,
  handlers: Readonly<
    Record<string, (payload: unknown, env: Env, job: RunningJob) => Promise<void>>
  >,
  options: { readonly pollMs?: number } = {},
): Worker {
  const names = Object.keys(handlers);
  const step = async (): Promise<boolean> => {
    await ensureEventTables(host.driver, (q) => host.driver.query(q));
    const [job] = await host.driver.query<{
      id: string | number;
      name: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
      uid: string | number;
      company_id: string | number;
      groups: string[];
    }>(
      compile(
        sql`UPDATE shutro_job SET state = 'running', attempts = attempts + 1, locked_at = now()
            WHERE id = (SELECT id FROM shutro_job WHERE state = 'pending' AND run_at <= now() AND name = ANY(${sql.array(names, 'text')}) ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING id, name, payload, attempts, max_attempts, uid, company_id, groups`,
      ),
    );
    if (job === undefined) return false;
    const id = Number(job.id);
    const handler = handlers[job.name];
    try {
      await asActor(
        host,
        { uid: Number(job.uid), companyId: Number(job.company_id), groups: job.groups },
        `job ${job.name}`,
        async (env) => {
          await handler?.(job.payload, env, {
            id,
            name: job.name,
            attempt: job.attempts,
            maxAttempts: job.max_attempts,
          });
          await env.sql`UPDATE shutro_job SET state = 'done', done_at = now(), locked_at = NULL, last_error = NULL WHERE id = ${id}`;
        },
      );
    } catch (error) {
      const dead = job.attempts >= job.max_attempts;
      await host.driver.query(
        compile(
          sql`UPDATE shutro_job SET state = ${dead ? 'dead' : 'pending'}, locked_at = NULL, last_error = ${message(error)}, run_at = now() + make_interval(secs => ${backoffMs(job.attempts) / 1000}) WHERE id = ${id}`,
        ),
      );
    }
    return true;
  };
  return loop(host, JOB_CHANNEL, options.pollMs ?? 1000, step);
}
