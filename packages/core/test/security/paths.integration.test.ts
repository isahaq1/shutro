/**
 * Relation paths in domains and record rules (docs/feedback.md #11) and verified identities (#6), on PostgreSQL —
 * through the ORM and through generated RLS policies.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  CompanyNotAllowedError,
  createShutro,
  createTableStatements,
  defineGroup,
  defineModel,
  defineModule,
  type Env,
  f,
  type Id,
  InvalidDomainError,
  InvalidIdentityError,
  rlsStatements,
  type Shutro,
  toDecimal,
  type VerifiedIdentity,
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
const Partner = defineModel('res.partner', {
  access: { 'base.user': ['read', 'create'] },
  fields: { name: f.char({ required: true }), secret: f.char({ groups: ['base.admin'] }) },
});
const Tag = defineModel('sale.tag', {
  access: { 'base.user': ['read', 'create'] },
  fields: { name: f.char({ required: true }) },
});
const Order = defineModel('sale.order', {
  access: { 'base.user': ['read', 'write', 'create'] },
  rules: {
    own: { groups: ['base.user'], perms: ['read', 'write'], domain: { user: { $env: 'uid' } } },
  },
  fields: {
    name: f.char({ required: true }),
    user: f.many2one('res.users', { required: true }),
    partner: f.many2one('res.partner', { required: true }),
    lines: f.one2many('sale.order.line', 'order'),
    tags: f.many2many('sale.tag'),
  },
});
const Line = defineModel('sale.order.line', {
  access: { 'base.user': ['read', 'write', 'create'] },
  // "Lines of my orders": a rule through a relation.
  rules: {
    ownOrders: {
      groups: ['base.user'],
      perms: ['read', 'write'],
      domain: { 'order.user': { $env: 'uid' } },
    },
  },
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    quantity: f.decimal({ scale: 2, required: true, default: '1' }),
  },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [
        defineGroup({ code: 'base.user' }),
        defineGroup({ code: 'base.admin', implies: ['base.user'] }),
      ],
      models: [Users, Currency, Company, Partner, Tag, Order, Line],
    }),
  ],
});
type S = typeof registry extends { readonly '~schema'?: infer X } ? NonNullable<X> : never;

let pg: StartedPostgres;
let owner: Driver;
let shutro: Shutro<S>;
const ids = { acme: 0, globex: 0, vip: 0, aliceOrder: 0, bobOrder: 0, aliceLine: 0, bobLine: 0 };

async function as<T>(
  user: number,
  fn: (env: Env<S>) => Promise<T>,
  groups: readonly string[] = ['base.user'],
): Promise<T> {
  return shutro.run({ user, company: 1, groups }, fn);
}

beforeAll(async () => {
  pg = await startPostgres();
  owner = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await owner.query(statement);
  await owner.query(compile(sql`INSERT INTO res_users (login) VALUES (${'alice'}), (${'bob'})`));
  const [bdt] = await owner.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await owner.query(
    compile(
      sql`INSERT INTO res_company (name, currency_id) VALUES (${'Co'}, ${bdt?.id ?? 0}), (${'Other'}, ${bdt?.id ?? 0})`,
    ),
  );
  const [acme, globex] = await owner.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name, secret) VALUES (${'Acme'}, ${'s1'}), (${'Globex'}, ${'s2'}) RETURNING id`,
    ),
  );
  const [vip] = await owner.query<{ id: number }>(
    compile(sql`INSERT INTO sale_tag (name) VALUES (${'vip'}) RETURNING id`),
  );
  Object.assign(ids, { acme: acme?.id, globex: globex?.id, vip: vip?.id });
  shutro = createShutro({ driver: owner, registry });
  ids.aliceOrder = await as(1, async (env) => {
    const so = (
      await env.model('sale.order').create([
        {
          name: 'A',
          user: 1 as Id<'res.users'>,
          partner: ids.acme as Id<'res.partner'>,
          tags: { link: [ids.vip as Id<'sale.tag'>] },
          lines: { create: [{ quantity: '5' }] },
        },
      ])
    ).first();
    return so.id;
  });
  ids.bobOrder = await as(
    2,
    async (env) =>
      (
        await env.model('sale.order').create([
          {
            name: 'B',
            user: 2 as Id<'res.users'>,
            partner: ids.globex as Id<'res.partner'>,
            lines: { create: [{ quantity: '50' }] },
          },
        ])
      ).first().id,
  );
  const lines = await owner.query<{ id: number; order_id: number }>(
    compile(sql`SELECT id, order_id FROM sale_order_line ORDER BY id`),
  );
  ids.aliceLine = Number(lines.find((l) => l.order_id === ids.aliceOrder)?.id);
  ids.bobLine = Number(lines.find((l) => l.order_id === ids.bobOrder)?.id);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await pg?.stop();
});

describe('relation paths in domains', () => {
  test('many2one paths, x2many any / none, many2many any, combined with or', async () => {
    await as(1, async (env) => {
      const orders = env.model('sale.order');
      expect((await orders.search({ where: { 'partner.name': 'Acme' } })).ids).toEqual([
        ids.aliceOrder,
      ]);
      expect(
        (await orders.search({ where: { lines: { any: { quantity: { gt: '1' } } } } })).ids,
      ).toEqual([ids.aliceOrder]);
      expect(
        (await orders.search({ where: { lines: { none: { quantity: { gt: '1' } } } } })).ids,
      ).toEqual([]);
      expect((await orders.search({ where: { tags: { any: { name: 'vip' } } } })).ids).toEqual([
        ids.aliceOrder,
      ]);
      expect(
        (await orders.search({ where: { or: [{ 'partner.name': 'Globex' }, { name: 'A' }] } })).ids,
      ).toEqual([ids.aliceOrder]); // B is not hers
      await expect(orders.search({ where: { lines: 5 } as never })).rejects.toBeInstanceOf(
        InvalidDomainError,
      );
      await expect(orders.search({ where: { 'name.x': 1 } })).rejects.toBeInstanceOf(
        InvalidDomainError,
      );
    });
  });

  test('a hidden field cannot be probed through a path', async () => {
    await as(1, async (env) => {
      await expect(
        env.model('sale.order').search({ where: { 'partner.secret': 's1' } }),
      ).rejects.toBeInstanceOf(AccessError);
    });
    await as(
      1,
      async (env) => {
        expect(
          (await env.model('sale.order').search({ where: { 'partner.secret': 's1' } })).ids,
        ).toEqual([ids.aliceOrder]);
      },
      ['base.admin'],
    );
  });
});

describe('record rules through relations', () => {
  test('"lines of my orders": search, browse and write follow the parent', async () => {
    await as(1, async (env) => {
      const lines = env.model('sale.order.line');
      expect((await lines.search()).ids).toEqual([ids.aliceLine]);
      await expect(lines.browse([ids.bobLine]).load()).rejects.toBeInstanceOf(AccessError);
      const both = await lines.browse([ids.aliceLine]).load();
      await both.write({ quantity: '6' });
      await expect(
        env
          .model('sale.order')
          .browse([ids.aliceOrder])
          .load({ lines: true })
          .then((o) => o.first().lines.length),
      ).resolves.toBe(1);
    });
    await as(2, async (env) => {
      expect((await env.model('sale.order.line').search()).ids).toEqual([ids.bobLine]);
    });
  });

  test('the generated RLS policy follows the path too', async () => {
    const statements = rlsStatements(registry);
    const policy = statements.find(
      (s) => s.includes('"sale_order_line_ownOrders_read"') && s.startsWith('CREATE POLICY'),
    );
    expect(policy).toContain(
      '"order_id" IN (SELECT "id" FROM "sale_order" WHERE "user_id" = current_setting(\'shutro.user_id\', true)::bigint)',
    );
    for (const s of statements) await owner.query({ text: s, params: [] });
    await owner.query({ text: "CREATE ROLE path_app LOGIN PASSWORD 'p'", params: [] });
    await owner.query({ text: 'GRANT ALL ON ALL TABLES IN SCHEMA public TO path_app', params: [] });
    await owner.query({
      text: 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO path_app',
      params: [],
    });
    const url = new URL(pg.url);
    url.username = 'path_app';
    url.password = 'p';
    const app = createDriver({ url: url.toString(), max: 2, parseNumeric: toDecimal });
    try {
      const rls = createShutro({ driver: app, registry });
      const visible = await rls.run(
        { user: 2, company: 1, groups: ['base.user'] },
        (env) => env.sql<{ id: number }>`SELECT id FROM sale_order_line`,
      );
      expect(visible.map((r) => Number(r.id))).toEqual([ids.bobLine]);
    } finally {
      await app.end();
    }
  });
});

describe('verified identities', () => {
  const directory: Readonly<Record<number, VerifiedIdentity>> = {
    1: { companies: [1], groups: ['base.user'] },
    2: { companies: [1, 2], groups: ['base.user', 'base.admin'] },
  };

  test('loaded groups apply when none are given; claims beyond the user are refused', async () => {
    const strict = createShutro({
      driver: owner,
      registry,
      identity: async (uid) => directory[uid] ?? null,
    });
    expect(
      await strict.run({ user: 2, company: 1 }, async (env) => [...env.groups].sort()),
    ).toEqual(['base.admin', 'base.user']);
    await expect(
      strict.run({ user: 1, company: 1, groups: ['base.admin'] }, async () => 1),
    ).rejects.toBeInstanceOf(InvalidIdentityError);
    await expect(strict.run({ user: 1, company: 2 }, async () => 1)).rejects.toBeInstanceOf(
      CompanyNotAllowedError,
    );
    await expect(strict.run({ user: 99, company: 1 }, async () => 1)).rejects.toThrow(
      /unknown or disabled/,
    );
    expect(
      await strict.run(
        { user: 1, company: 1 },
        async (env) => (await env.model('sale.order').search()).length,
      ),
    ).toBe(1);
  });
});
