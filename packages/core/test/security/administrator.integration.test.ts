/**
 * Administrators and feature permissions (RFC 0014 §7.9): members of an administrator group need no grant on any
 * model, record or field, nor any feature permission, in the ORM and in RLS mode; everyone else stays default-deny.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  createShutro,
  createTableStatements,
  defineGroup,
  defineModel,
  defineModule,
  definePermission,
  type Env,
  f,
  type Id,
  InvalidModuleError,
  rlsStatements,
  SecurityDefinitionError,
  type Shutro,
  toDecimal,
} from '../../src/index.js';

const Users = defineModel('res.users', {
  access: { 'base.user': ['read'] },
  fields: { login: f.char({ required: true }) },
});
const Currency = defineModel('res.currency', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    rounding: f.decimal({ scale: 6, required: true, default: '0.01' }),
  },
});
const Company = defineModel('res.company', {
  access: { 'base.user': ['read'] },
  fields: {
    name: f.char({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
  },
});
// No grant at all for administrators; users only see their own notes and never the cost.
const Note = defineModel('x.note', {
  access: { 'base.user': ['read', 'create'], 'x.manager': ['read', 'write'] },
  rules: {
    own: {
      groups: ['base.user'],
      perms: ['read', 'write', 'unlink'],
      domain: { user: { $env: 'uid' } },
    },
  },
  fields: {
    body: f.char({ required: true }),
    user: f.many2one('res.users', { required: true }),
    cost: f.decimal({ scale: 2, groups: ['x.manager'] }),
    state: f.state({
      states: { draft: 'Draft', approved: 'Approved' },
      initial: 'draft',
      transitions: { approve: { from: ['draft'], to: 'approved', requires: 'x.approve' } },
    }),
  },
});
// A transaction: entries more than 2 days in the past need 'x.backdate'.
const Move = defineModel('x.move', {
  access: { 'base.user': ['read', 'write', 'create'] },
  backdate: { field: 'date', permission: 'x.backdate', graceDays: 2 },
  fields: { date: f.date({ required: true }), ref: f.char() },
});
const groups = [
  defineGroup({ code: 'base.user' }),
  defineGroup({ code: 'x.manager', implies: ['base.user'] }),
  defineGroup({ code: 'base.admin', label: 'Administrator', administrator: true }),
  defineGroup({ code: 'it.root', implies: ['base.admin'] }), // administrators through implies too
];
const permissions = [
  definePermission({ code: 'x.approve', label: 'Approve notes', groups: ['x.manager'] }),
  definePermission({ code: 'x.backdate', label: 'Back-dated entries', groups: ['x.manager'] }),
];
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups,
      permissions,
      models: [Users, Currency, Company, Note, Move],
    }),
  ],
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let owner: Driver;
let shutro: Shutro<S>;
const as = <T>(
  user: number,
  g: readonly string[],
  fn: (env: Env<S>) => Promise<T>,
  grants: readonly string[] = [],
): Promise<T> => shutro.run({ user, company: 1, groups: g, grants }, fn);
const daysAgo = (env: Env<S>, n: number): string =>
  new Date(Date.parse(`${env.today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  pg = await startPostgres();
  owner = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await owner.query(statement);
  await owner.query(
    compile(sql`INSERT INTO res_users (login) VALUES (${'alice'}), (${'bob'}), (${'root'})`),
  );
  const [bdt] = await owner.query<{ id: number }>(
    compile(sql`INSERT INTO res_currency (name) VALUES (${'BDT'}) RETURNING id`),
  );
  await owner.query(
    compile(sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0})`),
  );
  shutro = createShutro({ driver: owner, registry });
  await as(1, ['base.user'], (env) =>
    env.model('x.note').create([{ body: 'alice', user: 1 as Id<'res.users'> }]),
  );
  await as(2, ['base.user'], (env) =>
    env.model('x.note').create([{ body: 'bob', user: 2 as Id<'res.users'> }]),
  );
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await pg?.stop();
});

describe('administrators', () => {
  test('need no grant: every model, record, field and operation', async () => {
    for (const g of [['base.admin'], ['it.root']]) {
      await as(3, g, async (env) => {
        expect(env.administrator).toBe(true);
        const notes = env.model('x.note');
        expect((await notes.search({ order: ['id'] })).map((n) => n.body)).toEqual([
          'alice',
          'bob',
        ]); // past the rule
        const [mine] = await notes.create([
          { body: 'root', user: 3 as Id<'res.users'>, cost: '9.50' },
        ]);
        await mine?.write({ cost: '10' });
        expect(String((await notes.search({ where: { body: 'root' } })).first().cost)).toBe('10'); // restricted field
        const [totals] = await notes.aggregate({
          measures: { n: 'count', total: { sum: 'cost' } },
        });
        expect([totals?.n, String(totals?.total)]).toEqual([3, '10']);
        await mine?.approve(); // needs x.approve
        expect(env.access.can('x.note', 'unlink')).toBe(true);
        expect(env.access.has('x.approve')).toBe(true);
        await mine?.unlink();
      });
    }
  });

  test('everyone else stays default-deny', async () => {
    await as(1, ['base.user'], async (env) => {
      expect(env.administrator).toBe(false);
      const notes = env.model('x.note');
      expect((await notes.search()).map((n) => n.body)).toEqual(['alice']);
      await expect(notes.search({ where: { cost: '1' } })).rejects.toBeInstanceOf(AccessError);
      await expect(notes.search().then((n) => n.unlink())).rejects.toBeInstanceOf(AccessError);
      expect(env.access.has('x.approve')).toBe(false);
      expect(() => env.access.require('x.approve')).toThrow(AccessError);
      await expect((await notes.search()).first().approve()).rejects.toBeInstanceOf(AccessError);
      expect(() => env.access.has('x.typo')).toThrow(SecurityDefinitionError);
    });
  });
});

describe('feature permissions', () => {
  test('granted by groups (implied ones count); transitions can require them', async () => {
    await as(1, ['x.manager'], async (env) => {
      expect(env.access.has('x.approve')).toBe(true);
      const note = (await env.model('x.note').search({ where: { body: 'alice' } })).first();
      await note.approve();
      expect((await env.model('x.note').search({ where: { body: 'alice' } })).first().state).toBe(
        'approved',
      );
    });
  });

  test('undeclared groups or permissions are definition errors', () => {
    expect(() =>
      buildRegistry({
        modules: [
          defineModule({
            name: 'y',
            groups,
            permissions: [definePermission({ code: 'y.p', groups: ['y.nobody'] })],
            models: [Users],
          }),
        ],
      }),
    ).toThrow(InvalidModuleError);
    const Bad = defineModel('y.doc', {
      fields: {
        state: f.state({
          states: { a: 'A', b: 'B' },
          initial: 'a',
          transitions: { go: { from: ['a'], to: 'b', requires: 'y.missing' } },
        }),
      },
    });
    expect(() =>
      buildRegistry({ modules: [defineModule({ name: 'y', groups, models: [Users, Bad] })] }),
    ).toThrow(/requires the permission 'y.missing'/);
    expect(() => definePermission({ code: 'Bad Code', groups: [] })).toThrow(
      SecurityDefinitionError,
    );
  });
});

test('RLS mode: administrators pass the policies, users only see their rows', async () => {
  for (const s of rlsStatements(registry)) await owner.query({ text: s, params: [] });
  await owner.query({ text: "CREATE ROLE admin_app LOGIN PASSWORD 'p'", params: [] });
  await owner.query({ text: 'GRANT ALL ON ALL TABLES IN SCHEMA public TO admin_app', params: [] });
  await owner.query({
    text: 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO admin_app',
    params: [],
  });
  const url = new URL(pg.url);
  url.username = 'admin_app';
  url.password = 'p';
  const app = createDriver({ url: url.toString(), max: 2, parseNumeric: toDecimal });
  try {
    const rls = createShutro({ driver: app, registry });
    const count = (user: number, g: readonly string[]): Promise<number> =>
      rls.run(
        { user, company: 1, groups: g },
        async (env) =>
          (await env.sql<{ n: number }>`SELECT count(*)::int AS n FROM x_note`)[0]?.n ?? -1,
      );
    expect(await count(2, ['base.user'])).toBe(1);
    expect(await count(3, ['base.admin'])).toBe(2);
    // asSuperuser inside an administrator scope must not drop the administrator's RLS pass afterwards.
    expect(
      await rls.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
        await env.asSuperuser({ reason: 'test' }, async () => 1);
        return (await env.sql<{ n: number }>`SELECT count(*)::int AS n FROM x_note`)[0]?.n;
      }),
    ).toBe(2);
  } finally {
    await app.end();
  }
});

describe('special permissions per user', () => {
  test('a grant adds one model operation or feature permission to one user, without a role', async () => {
    await expect(
      as(1, ['base.user'], async (env) => (await env.model('x.note').search()).unlink()),
    ).rejects.toBeInstanceOf(AccessError);
    await as(
      1,
      ['base.user'],
      async (env) => {
        expect(env.access.can('x.note', 'unlink')).toBe(true);
        expect(env.access.has('x.approve')).toBe(true);
        expect(env.access.can('x.note', 'write')).toBe(false); // only what was granted
        const [n] = await env
          .model('x.note')
          .create([{ body: 'temp', user: 1 as Id<'res.users'> }]);
        await n?.unlink();
      },
      ['x.note:unlink', 'x.approve'],
    );
    await expect(as(1, ['base.user'], async () => 1, ['not a grant'])).rejects.toThrow(
      /is not a grant/,
    );
  });

  test('with an identity loader, grants come from the user record and cannot be claimed', async () => {
    const loaded = createShutro({
      driver: owner,
      registry,
      identity: async (uid) =>
        uid === 1 ? { companies: [1], groups: ['base.user'], grants: ['x.backdate'] } : null,
    });
    expect(await loaded.run({ user: 1, company: 1 }, async (env) => [...env.grants])).toEqual([
      'x.backdate',
    ]);
    await expect(
      loaded.run({ user: 1, company: 1, grants: ['x.approve'] }, async () => 1),
    ).rejects.toThrow(/does not have the grant/);
  });
});

describe('back-dated entries', () => {
  test('within the grace days is free; earlier needs the permission (role, grant or administrator)', async () => {
    await as(1, ['base.user'], async (env) => {
      const moves = env.model('x.move');
      await moves.create([{ date: env.today() }, { date: daysAgo(env, 2) }]);
      await expect(moves.create([{ date: daysAgo(env, 3) }])).rejects.toThrow(
        /dated before .* need the permission 'x.backdate'/,
      );
      const m = (await moves.create([{ date: env.today(), ref: 'now' }])).first();
      await expect(m.write({ date: daysAgo(env, 30) })).rejects.toBeInstanceOf(AccessError);
    });
    await as(1, ['x.manager'], (env) =>
      env.model('x.move').create([{ date: daysAgo(env, 30), ref: 'manager' }]),
    );
    await as(
      1,
      ['base.user'],
      (env) => env.model('x.move').create([{ date: daysAgo(env, 30), ref: 'grant' }]),
      ['x.backdate'],
    );
    await as(3, ['base.admin'], (env) =>
      env.model('x.move').create([{ date: daysAgo(env, 365), ref: 'admin' }]),
    );
    // Editing other fields of an old entry is not back-dating.
    await as(1, ['base.user'], async (env) => {
      const old = (await env.model('x.move').search({ where: { ref: 'grant' } })).first();
      await old.write({ ref: 'grant (edited)' });
      await env.flush();
    });
  });

  test('bulk COPY loads are checked too', async () => {
    await expect(
      as(1, ['base.user'], (env) => env.model('x.move').copy([{ date: daysAgo(env, 10) }]), [
        'x.move:import',
      ]),
    ).rejects.toBeInstanceOf(AccessError);
  });

  test('the option is validated', () => {
    expect(() =>
      defineModel('y.bad', {
        backdate: { field: 'ref', permission: 'y.p' },
        fields: { ref: f.char() },
      }),
    ).toThrow(/not a date or datetime field/);
    const Unknown = defineModel('y.move', {
      backdate: { field: 'date', permission: 'y.missing' },
      fields: { date: f.date() },
    });
    expect(() =>
      buildRegistry({ modules: [defineModule({ name: 'y', groups, models: [Users, Unknown] })] }),
    ).toThrow(/back-dated entries, which no module declares/);
  });
});
