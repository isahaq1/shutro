/**
 * PostgreSQL RLS generated from record rules (RFC 0014 §7.5): raw SQL on the application's session is bound by the
 * same rules as the ORM, including superuser scopes. Runs as a non-owner role, as production should.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  auditTableStatements,
  createShutro,
  createTableStatements,
  type Env,
  type Id,
  rlsStatements,
  type Shutro,
  toDecimal,
} from '../../src/index.js';
import { registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let owner: Driver;
let app: Driver;
let shutro: Shutro<S>;
let acme: Id<'res.partner'>;

async function as<T>(
  user: number,
  groups: readonly string[],
  fn: (env: Env<S>) => Promise<T>,
): Promise<T> {
  return shutro.run({ user, company: 1, groups }, fn);
}

beforeAll(async () => {
  pg = await startPostgres();
  owner = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await owner.query(statement);
  for (const statement of rlsStatements(registry))
    await owner.query({ text: statement, params: [] });
  for (const statement of auditTableStatements()) await owner.query(statement); // infrastructure tables belong to the owner
  // A role that owns nothing: FORCE ROW LEVEL SECURITY would bind the owner too, but superusers are exempt.
  await owner.query({ text: "CREATE ROLE app_user LOGIN PASSWORD 'app'", params: [] });
  await owner.query({ text: 'GRANT USAGE ON SCHEMA public TO app_user', params: [] });
  await owner.query({ text: 'GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user', params: [] });
  await owner.query({
    text: 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app_user',
    params: [],
  });
  await owner.query({
    text: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO app_user',
    params: [],
  });
  await owner.query(
    compile(sql`INSERT INTO res_users (login) VALUES (${'admin'}), (${'alice'}), (${'bob'})`),
  );
  const [bdt] = await owner.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await owner.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'BD'}, ${bdt?.id ?? 0})`),
  );
  const [p] = await owner.query<{ id: number }>(
    compile(sql`INSERT INTO res_partner (name) VALUES (${'Acme'}) RETURNING id`),
  );
  acme = (p?.id ?? 0) as Id<'res.partner'>;
  const url = new URL(pg.url);
  url.username = 'app_user';
  url.password = 'app';
  app = createDriver({ url: url.toString(), max: 3, parseNumeric: toDecimal });
  shutro = createShutro({ driver: app, registry });
  await as(2, ['sale.user'], async (env) => {
    await env.model('sale.order').create([
      { name: 'A1', partner: acme },
      { name: 'A2', partner: acme },
    ]);
  });
  await as(3, ['sale.user'], async (env) => {
    await env.model('sale.order').create([{ name: 'B1', partner: acme }]);
  });
}, 180_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe('row-level security', () => {
  test('raw SQL in a user session sees only what the rules allow; a superuser scope sees everything', async () => {
    await as(2, ['sale.user'], async (env) => {
      const [row] = await env.sql<{ n: number }>`SELECT count(*)::int AS n FROM sale_order`;
      expect(row?.n).toBe(2);
      const names = await env.sql<{ name: string }>`SELECT name FROM sale_order ORDER BY name`;
      expect(names.map((r) => r.name)).toEqual(['A1', 'A2']);
      // An UPDATE on another user's row affects nothing: the row is invisible to the policy.
      const updated = await env.sql<{
        id: number;
      }>`UPDATE sale_order SET note = ${'hacked'} WHERE name = ${'B1'} RETURNING id`;
      expect(updated).toHaveLength(0);
      await env.asSuperuser({ reason: 'report' }, async (su) => {
        const [all] = await su.sql<{ n: number }>`SELECT count(*)::int AS n FROM sale_order`;
        expect(all?.n).toBe(3);
      });
      const [again] = await env.sql<{ n: number }>`SELECT count(*)::int AS n FROM sale_order`;
      expect(again?.n).toBe(2); // shutro.su is reset after the scope
    });
    await as(1, ['sale.manager'], async (env) => {
      const [row] = await env.sql<{ n: number }>`SELECT count(*)::int AS n FROM sale_order`;
      expect(row?.n).toBe(3);
    });
    const [direct] = await owner.query<{ n: number }>(
      compile(sql`SELECT count(*)::int AS n FROM sale_order`),
    );
    expect(direct?.n).toBe(3); // the owner session has no settings and is a superuser: RLS does not apply
    const [hacked] = await owner.query<{ note: string | null }>(
      compile(sql`SELECT note FROM sale_order WHERE name = ${'B1'}`),
    );
    expect(hacked?.note).toBeNull();
  });
});
