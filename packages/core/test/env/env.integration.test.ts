/**
 * Environment & transaction context (RFC 0003) on real PostgreSQL 18 through @shutro/driver-pg.
 */
import {
  createDriver,
  type Driver,
  ReadOnlyTransactionError,
  SerializationFailureError,
} from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  CompanyNotAllowedError,
  ConcurrentUpdateError,
  createShutro,
  type Env,
  FlagNotAllowedError,
  InvalidIdentityError,
  NoEnvironmentError,
  type Shutro,
  TransactionScopeError,
  toDecimal,
} from '../../src/index.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro;
const hookErrors: unknown[] = [];

const identity = { user: 7, company: 1, companies: [1, 2] } as const;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 10, parseNumeric: toDecimal });
  shutro = createShutro({
    driver,
    retry: { attempts: 3, backoffMs: () => 0 },
    onHookError: (e) => hookErrors.push(e),
  });
  await driver.query(
    compile(
      sql`CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL, n int NOT NULL DEFAULT 0)`,
    ),
  );
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

beforeEach(async () => {
  hookErrors.length = 0;
  await driver.query(compile(sql`TRUNCATE notes RESTART IDENTITY`));
});

const count = async (): Promise<number> => {
  const [row] = await driver.query<{ n: number }>(
    compile(sql`SELECT count(*)::int AS n FROM notes`),
  );
  return row?.n ?? -1;
};

describe('run(): one transaction per unit of work', () => {
  test('commits and returns the result', async () => {
    const result = await shutro.run(identity, async (env) => {
      await env.sql`INSERT INTO notes (body) VALUES (${'hello'})`;
      return 'done';
    });
    expect(result).toBe('done');
    expect(await count()).toBe(1);
  });

  test('rolls back and rethrows the original error', async () => {
    const boom = new Error('business rule failed');
    await expect(
      shutro.run(identity, async (env) => {
        await env.sql`INSERT INTO notes (body) VALUES (${'x'})`;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await count()).toBe(0);
  });

  test('runs at repeatable read with the identity in SET LOCAL settings and UTC', async () => {
    await shutro.run(identity, async (env) => {
      const [row] = await env.sql<{ iso: string; uid: string; cids: string; tz: string }>`
        SELECT current_setting('transaction_isolation') AS iso,
               current_setting('shutro.user_id') AS uid,
               current_setting('shutro.company_ids') AS cids,
               current_setting('TimeZone') AS tz`;
      expect(row).toEqual({ iso: 'repeatable read', uid: '7', cids: '{1,2}', tz: 'UTC' });
    });
  });

  test('read-only runs reject writes (not retried)', async () => {
    let attempts = 0;
    await expect(
      shutro.run({ ...identity, readOnly: true }, async (env) => {
        attempts++;
        await env.sql`INSERT INTO notes (body) VALUES (${'x'})`;
      }),
    ).rejects.toBeInstanceOf(ReadOnlyTransactionError);
    expect(attempts).toBe(1);
  });

  test('now() is the transaction timestamp, stable within an attempt', async () => {
    await shutro.run(identity, async (env) => {
      const first = env.now();
      await new Promise((r) => setTimeout(r, 20));
      expect(env.now().getTime()).toBe(first.getTime());
      const [row] = await env.sql<{ now: Date }>`SELECT now() AS now`;
      expect(row?.now.getTime()).toBe(first.getTime());
      first.setFullYear(1999); // mutating a returned Date does not affect the env
      expect(env.now().getFullYear()).not.toBe(1999);
      expect(env.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe('hooks', () => {
  test('afterCommit runs after commit (data visible outside); onRollback does not', async () => {
    const events: string[] = [];
    await shutro.run(identity, async (env) => {
      await env.sql`INSERT INTO notes (body) VALUES (${'a'})`;
      env.afterCommit(async () => {
        events.push(`after:${await count()}`);
      });
      env.onRollback(() => {
        events.push('rollback');
      });
    });
    expect(events).toEqual(['after:1']);
  });

  test('onRollback runs on failure; afterCommit does not', async () => {
    const events: string[] = [];
    await shutro
      .run(identity, async (env) => {
        env.afterCommit(() => {
          events.push('after');
        });
        env.onRollback(() => {
          events.push('rollback');
        });
        throw new Error('fail');
      })
      .catch(() => undefined);
    expect(events).toEqual(['rollback']);
  });

  test('a failing afterCommit hook is reported, not thrown (the transaction already committed)', async () => {
    const result = await shutro.run(identity, async (env) => {
      env.afterCommit(() => {
        throw new Error('mailer down');
      });
      return 42;
    });
    expect(result).toBe(42);
    expect(hookErrors).toHaveLength(1);
  });
});

describe('env.transaction(): nested scopes are savepoints', () => {
  test('a failing savepoint rolls back only its own work and discards its afterCommit hooks', async () => {
    const events: string[] = [];
    await shutro.run(identity, async (env) => {
      await env.sql`INSERT INTO notes (body) VALUES (${'outer'})`;
      await expect(
        env.transaction(async (sp) => {
          await sp.sql`INSERT INTO notes (body) VALUES (${'inner-failed'})`;
          sp.afterCommit(() => {
            events.push('from failed savepoint');
          });
          throw new Error('inner');
        }),
      ).rejects.toThrow('inner');
      await env.transaction(async (sp) => {
        await sp.sql`INSERT INTO notes (body) VALUES (${'inner-ok'})`;
        sp.afterCommit(() => {
          events.push('from released savepoint');
        });
      });
    });
    const rows = await driver.query<{ body: string }>(
      compile(sql`SELECT body FROM notes ORDER BY id`),
    );
    expect(rows.map((r) => r.body)).toEqual(['outer', 'inner-ok']);
    expect(events).toEqual(['from released savepoint']);
  });

  test('using the parent env while its savepoint is active is an error', async () => {
    await shutro.run(identity, async (env) => {
      await env.transaction(async () => {
        await expect(env.sql`SELECT 1`).rejects.toBeInstanceOf(TransactionScopeError);
      });
      await env.sql`SELECT 1`; // fine again once the savepoint ended
    });
  });
});

describe('retries (RFC 0003 §7.5)', () => {
  /** Makes the first attempt of `fn` hit a serialization failure, using a concurrent run. */
  async function conflictingRun(
    options: { retry?: false } = {},
  ): Promise<{ attempts: number; error?: unknown }> {
    await driver.query(compile(sql`INSERT INTO notes (body) VALUES (${'counter'})`));
    let attempts = 0;
    const events: string[] = [];
    try {
      await shutro.run({ ...identity, ...options }, async (env) => {
        attempts++;
        env.onRollback(() => {
          events.push(`rollback#${env.attempt}`);
        });
        env.afterCommit(() => {
          events.push(`commit#${env.attempt}`);
        });
        await env.sql`SELECT n FROM notes WHERE body = ${'counter'}`;
        if (env.attempt === 1) {
          await shutro.run(
            identity,
            (other) => other.sql`UPDATE notes SET n = n + 1 WHERE body = ${'counter'}`,
          );
        }
        await env.sql`UPDATE notes SET n = n + 10 WHERE body = ${'counter'}`;
      });
      return { attempts, error: undefined, ...{ events } };
    } catch (error) {
      return { attempts, error, ...{ events } };
    }
  }

  test('a serialization failure re-runs the whole function with a fresh scope', async () => {
    const result = await conflictingRun();
    expect(result.error).toBeUndefined();
    expect(result.attempts).toBe(2);
    expect((result as unknown as { events: string[] }).events).toEqual(['rollback#1', 'commit#2']);
    const [row] = await driver.query<{ n: number }>(
      compile(sql`SELECT n FROM notes WHERE body = ${'counter'}`),
    );
    expect(row?.n).toBe(11); // 1 from the concurrent run + 10 from the successful retry
  });

  test('retry: false surfaces the driver error immediately', async () => {
    const result = await conflictingRun({ retry: false });
    expect(result.attempts).toBe(1);
    expect(result.error).toBeInstanceOf(SerializationFailureError);
  });

  test('exhausted retries become ConcurrentUpdateError with the last error as cause', async () => {
    await driver.query(compile(sql`INSERT INTO notes (body) VALUES (${'hot'})`));
    let attempts = 0;
    const error = await shutro
      .run(identity, async (env) => {
        attempts++;
        await env.sql`SELECT n FROM notes WHERE body = ${'hot'}`;
        await shutro.run(identity, (o) => o.sql`UPDATE notes SET n = n + 1 WHERE body = ${'hot'}`);
        await env.sql`UPDATE notes SET n = n + 10 WHERE body = ${'hot'}`;
      })
      .catch((e: unknown) => e);
    expect(attempts).toBe(3);
    expect(error).toBeInstanceOf(ConcurrentUpdateError);
    expect((error as ConcurrentUpdateError).cause).toBeInstanceOf(SerializationFailureError);
    expect((error as ConcurrentUpdateError).hint.length).toBeGreaterThan(10);
  });
});

describe('scope tracking (AsyncLocalStorage)', () => {
  test('currentEnv() finds the active env through async boundaries', async () => {
    await shutro.run(identity, async (env) => {
      await new Promise((r) => setTimeout(r, 5));
      const found = await Promise.resolve().then(() => shutro.currentEnv());
      expect(found.uid).toBe(env.uid);
      await env.transaction(async (sp) => {
        expect(shutro.currentEnv()).toBe(sp);
      });
    });
  });

  test('currentEnv() outside a run is NoEnvironmentError with a hint', () => {
    expect(() => shutro.currentEnv()).toThrow(NoEnvironmentError);
  });

  test('an env used after its run ended is TransactionScopeError', async () => {
    let leaked: Env | undefined;
    await shutro.run(identity, async (env) => {
      leaked = env;
    });
    if (leaked === undefined) throw new Error('env was not captured');
    const ended = leaked;
    await expect(ended.sql`SELECT 1`).rejects.toBeInstanceOf(TransactionScopeError);
    expect(() => ended.afterCommit(() => undefined)).toThrow(TransactionScopeError);
  });

  test("an env from another open transaction is TransactionScopeError ('different transaction')", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let envA: Env | undefined;
    const runA = shutro.run(identity, async (env) => {
      envA = env;
      await gate;
    });
    await new Promise((r) => setTimeout(r, 50));
    await shutro.run(identity, async () => {
      if (envA === undefined) throw new Error('env A was not captured');
      const error = await envA.sql`SELECT 1`.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransactionScopeError);
      expect((error as TransactionScopeError).message).toMatch(/different transaction/);
    });
    release();
    await runA;
  });
});

describe('derived environments', () => {
  test('withCompany within allowed companies; otherwise CompanyNotAllowedError', async () => {
    await shutro.run(identity, async (env) => {
      expect(env.withCompany(2).companyId).toBe(2);
      expect(env.companyId).toBe(1); // envs are immutable
      expect(() => env.withCompany(3)).toThrow(CompanyNotAllowedError);
    });
  });

  test('asSuperuser is scoped and requires a reason', async () => {
    await shutro.run(identity, async (env) => {
      const seen = await env.asSuperuser({ reason: 'payment webhook' }, async (su) => {
        expect(su.su).toBe(true);
        expect(su.withCompany(99).companyId).toBe(99); // su may leave the allowed companies
        return su.reason;
      });
      expect(seen).toBe('payment webhook');
      expect(env.su).toBe(false);
      await expect(env.asSuperuser({ reason: ' ' }, async () => undefined)).rejects.toBeInstanceOf(
        InvalidIdentityError,
      );
    });
  });

  test('flags: defaults, overrides, and checkCompany only off under su', async () => {
    await shutro.run(identity, async (env) => {
      expect(env.flags).toEqual({ activeTest: true, tracking: true, checkCompany: true });
      expect(env.withFlags({ activeTest: false }).flags.activeTest).toBe(false);
      expect(() => env.withFlags({ checkCompany: false })).toThrow(FlagNotAllowedError);
      await env.asSuperuser({ reason: 'migration' }, async (su) => {
        expect(su.withFlags({ checkCompany: false }).flags.checkCompany).toBe(false);
      });
    });
  });

  test('withLang / withTz validate their input', async () => {
    await shutro.run({ ...identity, tz: 'Asia/Dhaka', lang: 'bn_BD' }, async (env) => {
      expect(env.tz).toBe('Asia/Dhaka');
      expect(env.withLang('en_US').lang).toBe('en_US');
      expect(() => env.withLang('english')).toThrow(InvalidIdentityError);
      expect(() => env.withTz('Mars/Olympus')).toThrow(InvalidIdentityError);
    });
  });
});

describe('identity validation happens before any transaction', () => {
  test.each([
    [{ user: 0, company: 1 }],
    [{ user: 1.5, company: 1 }],
    [{ user: 1, company: -1 }],
    [{ user: 1, company: 1, companies: [2, 3] }], // current company must be allowed
    [{ user: 1, company: 1, tz: 'Nowhere/City' }],
    [{ user: 1, company: 1, lang: 'EN' }],
  ])('%j', async (bad) => {
    let ran = false;
    const error = await shutro
      .run(bad, async () => {
        ran = true;
      })
      .catch((e: unknown) => e);
    expect(ran).toBe(false);
    expect(error).toBeInstanceOf(InvalidIdentityError);
  });
});
