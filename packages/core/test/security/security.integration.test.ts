/**
 * Adversarial access tests on PostgreSQL (RFC 0014): every path a user could take around the rules — relations,
 * searches and filters on hidden fields, bulk writes with one forbidden id, x2many commands, creation out of scope,
 * superuser scopes, and encrypted fields with and without the keys.
 */
import { randomBytes } from 'node:crypto';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  AccessError,
  createKeyRing,
  createShutro,
  createTableStatements,
  EncryptionError,
  type Env,
  type Id,
  InvalidDomainError,
  MissingRecordError,
  readTrail,
  type Shutro,
  toDecimal,
} from '../../src/index.js';
import { registry, type S } from './fixtures.js';

let pg: StartedPostgres;
let driver: Driver;
let shutro: Shutro<S>;
const k1 = randomBytes(32);
const k2 = randomBytes(32);
let ids: { bdt: Id<'res.currency'>; acme: Id<'res.partner'>; globex: Id<'res.partner'> };
const USERS = { admin: 1, alice: 2, bob: 3, nobody: 4, hr: 5 } as const;
const GROUPS: Record<keyof typeof USERS, readonly string[]> = {
  admin: ['sale.manager'],
  alice: ['sale.user'],
  bob: ['sale.user'],
  nobody: [],
  hr: ['hr.manager'],
};

async function as<T>(
  who: keyof typeof USERS,
  fn: (env: Env<S>) => Promise<T>,
  companies: readonly number[] = [1],
): Promise<T> {
  return shutro.run(
    { user: USERS[who], company: companies[0] ?? 1, companies, groups: GROUPS[who] },
    fn,
  );
}

const order = (name: string) => ({ name, partner: ids.acme });

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 5, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  shutro = createShutro({ driver, registry, keys: createKeyRing({ current: 'k1', keys: { k1 } }) });
  await driver.query(
    compile(
      sql`INSERT INTO res_users (login) VALUES (${'admin'}), (${'alice'}), (${'bob'}), (${'nobody'}), (${'hr'})`,
    ),
  );
  const [bdt] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_currency (name, rounding) VALUES (${'BDT'}, ${'0.01'}) RETURNING id`,
    ),
  );
  await driver.query(
    compile(
      sql`INSERT INTO res_company (name, currency_id) VALUES (${'BD'}, ${bdt?.id ?? 0}), (${'SG'}, ${bdt?.id ?? 0})`,
    ),
  );
  const [acme, globex] = await driver.query<{ id: number }>(
    compile(
      sql`INSERT INTO res_partner (name, secret) VALUES (${'Acme'}, ${'acme-secret'}), (${'Globex'}, ${'globex-secret'}) RETURNING id`,
    ),
  );
  ids = {
    bdt: (bdt?.id ?? 0) as Id<'res.currency'>,
    acme: (acme?.id ?? 0) as Id<'res.partner'>,
    globex: (globex?.id ?? 0) as Id<'res.partner'>,
  };
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('model ACL', () => {
  test('default deny: a user without groups can do nothing; a superuser scope can', async () => {
    await as('nobody', async (env) => {
      await expect(env.model('sale.order').search()).rejects.toBeInstanceOf(AccessError);
      await expect(env.model('sale.order').create([order('X')])).rejects.toBeInstanceOf(
        AccessError,
      );
      await expect(env.model('res.partner').browse([ids.acme]).load()).rejects.toBeInstanceOf(
        AccessError,
      );
      expect(env.access.can('sale.order', 'read')).toBe(false);
      await env.asSuperuser({ reason: 'test' }, async (su) => {
        expect((await su.model('res.partner').search()).length).toBe(2);
      });
    });
  });

  test('permissions per group with inheritance; export is an application check', async () => {
    await as('alice', async (env) => {
      expect(env.access.can('sale.order', 'create')).toBe(true);
      expect(env.access.can('sale.order', 'unlink')).toBe(false);
      expect(env.access.can('sale.order', 'export')).toBe(false);
      expect(env.access.can('res.users', 'read')).toBe(true); // via sale.user → base.user
      expect(() => env.access.check('sale.order', 'export')).toThrow(AccessError);
    });
    await as('admin', async (env) => {
      expect(env.access.can('sale.order', 'export')).toBe(true);
      expect(env.access.can('res.partner', 'unlink')).toBe(false); // manager of sales, not of HR
    });
  });
});

describe('record rules', () => {
  test('a salesperson sees and edits only their orders; a manager sees all', async () => {
    const [a1, b1] = await Promise.all([
      as(
        'alice',
        async (env) => (await env.model('sale.order').create([order('A1'), order('A2')])).ids,
      ),
      as('bob', async (env) => (await env.model('sale.order').create([order('B1')])).ids),
    ]);
    const aliceId = a1[0] as number;
    const bobId = b1[0] as number;
    await as('alice', async (env) => {
      expect((await env.model('sale.order').search({ order: ['name'] })).mapped('name')).toEqual([
        'A1',
        'A2',
      ]);
      expect(
        (await env.model('sale.order').search({ where: { id: bobId as Id<'sale.order'> } })).ids,
      ).toEqual([]);
      const denied = await env
        .model('sale.order')
        .browse([bobId])
        .load()
        .catch((e: unknown) => e);
      expect(denied).toBeInstanceOf(AccessError);
      expect((denied as AccessError).records).toEqual([bobId]);
      await expect(env.model('sale.order').browse([999_999]).load()).rejects.toBeInstanceOf(
        MissingRecordError,
      );
      // Bulk: one forbidden id poisons the whole write; nothing changes.
      const both = await env
        .model('sale.order')
        .browse([aliceId, bobId])
        .load()
        .catch(() => undefined);
      expect(both).toBeUndefined();
      await expect(
        env
          .model('sale.order')
          .browse([aliceId, bobId])
          .load([])
          .then((s) => s.write({ note: 'x' })),
      ).rejects.toBeInstanceOf(AccessError);
      await expect(
        env
          .model('sale.order')
          .browse([aliceId])
          .load()
          .then((s) => s.unlink()),
      ).rejects.toBeInstanceOf(AccessError); // no unlink in the ACL
    });
    const [row] = await driver.query<{ note: string | null }>(
      compile(sql`SELECT note FROM sale_order WHERE id = ${aliceId}`),
    );
    expect(row?.note).toBeNull();
    await as('admin', async (env) => {
      expect((await env.model('sale.order').search({ order: ['name'] })).mapped('name')).toEqual([
        'A1',
        'A2',
        'B1',
      ]);
      const bobs = await env.model('sale.order').browse([bobId]).load();
      await bobs.write({ note: 'seen by manager' });
      await env.flush();
    });
  });

  test('create rules reject rows out of scope and roll the transaction back', async () => {
    const before = (
      await driver.query<{ n: number }>(compile(sql`SELECT count(*)::int AS n FROM sale_order`))
    )[0]?.n;
    const error = await as('alice', async (env) => {
      await env.model('sale.order').create([{ ...order('OUT'), company: 2 as Id<'res.company'> }]);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessError);
    expect((error as AccessError).perm).toBe('create');
    const after = (
      await driver.query<{ n: number }>(compile(sql`SELECT count(*)::int AS n FROM sale_order`))
    )[0]?.n;
    expect(after).toBe(before);
  });

  test('no bypass through relations: loading a forbidden parent through a line is denied', async () => {
    const lineId = await as('bob', async (env) => {
      const so = (await env.model('sale.order').search({ where: { name: 'B1' } })).first();
      await so.write({ lines: { create: [{ name: 'bob line' }] } });
      await env.flush();
      return (await so.lines.load()).ids[0] as number;
    });
    await as('alice', async (env) => {
      const line = (await env.model('sale.order.line').browse([lineId]).load()).first(); // lines have no rules
      expect(line.name).toBe('bob line');
      await expect(
        env.model('sale.order.line').browse([lineId]).load({ order: true }),
      ).rejects.toBeInstanceOf(AccessError);
      // and through commands: deleting lines needs unlink on the line model
      const mine = (await env.model('sale.order').search({ where: { name: 'A1' } })).first();
      await expect(
        mine.write({ lines: { delete: [lineId as Id<'sale.order.line'>] } }),
      ).rejects.toBeInstanceOf(AccessError);
    });
  });
});

describe('field groups', () => {
  test('restricted fields are hidden from loads, filters, sorts, reads and writes', async () => {
    await as('alice', async (env) => {
      const partner = (await env.model('res.partner').browse([ids.acme]).load()).first();
      expect(partner.name).toBe('Acme');
      expect(() => partner.secret).toThrow(AccessError); // not in the default projection, and not readable
      await expect(
        env.model('res.partner').browse([ids.acme]).load(['secret']),
      ).rejects.toBeInstanceOf(AccessError);
      await expect(
        env.model('res.partner').search({ where: { secret: { ilike: 'acme%' } } }),
      ).rejects.toBeInstanceOf(AccessError);
      await expect(env.model('res.partner').search({ order: ['secret'] })).rejects.toBeInstanceOf(
        AccessError,
      );
      await expect(partner.write({ secret: 'x' })).rejects.toBeInstanceOf(AccessError);
      const so = (await env.model('sale.order').search({ where: { name: 'A1' } })).first();
      await expect(so.write({ margin: '1' })).rejects.toBeInstanceOf(AccessError);
      await expect(so.load({ partner: ['secret'] })).rejects.toBeInstanceOf(AccessError); // through a relation
    });
    await as('hr', async (env) => {
      const partner = (await env.model('res.partner').browse([ids.acme]).load(['secret'])).first();
      expect(partner.secret).toBe('acme-secret');
    });
  });
});

describe('encrypted fields', () => {
  test('ciphertext at rest, plaintext through the ORM, masked in the audit trail, not filterable', async () => {
    await as('hr', async (env) => {
      const partner = (await env.model('res.partner').browse([ids.acme]).load()).first();
      await partner.write({ ssn: '123-45-6789' });
      await env.flush();
      expect((await env.model('res.partner').browse([ids.acme]).load(['ssn'])).first().ssn).toBe(
        '123-45-6789',
      );
      await expect(
        env.model('res.partner').search({ where: { ssn: '123-45-6789' } }),
      ).rejects.toBeInstanceOf(InvalidDomainError);
    });
    const [row] = await driver.query<{ ssn: string }>(
      compile(sql`SELECT ssn FROM res_partner WHERE id = ${ids.acme}`),
    );
    expect(row?.ssn.startsWith('shutro1:k1:')).toBe(true);
    const [trail] = await readTrail(driver, {
      model: 'res.partner',
      recordIds: [ids.acme],
      field: 'ssn',
    });
    expect(trail?.new).toBe('[encrypted]');
  });

  test('key rotation reads old values with the old key; a ring without it fails loudly', async () => {
    const rotated = createShutro({
      driver,
      registry,
      keys: createKeyRing({ current: 'k2', keys: { k1, k2 } }),
    });
    await rotated.run({ user: USERS.hr, company: 1, groups: GROUPS.hr }, async (env) => {
      const p = (await env.model('res.partner').browse([ids.acme]).load(['ssn'])).first();
      expect(p.ssn).toBe('123-45-6789');
      await p.write({ ssn: '987-65-4321' });
      await env.flush();
    });
    const [row] = await driver.query<{ ssn: string }>(
      compile(sql`SELECT ssn FROM res_partner WHERE id = ${ids.acme}`),
    );
    expect(row?.ssn.startsWith('shutro1:k2:')).toBe(true);
    const lost = createShutro({
      driver,
      registry,
      keys: createKeyRing({ current: 'k1', keys: { k1 } }),
    });
    await expect(
      lost.run({ user: USERS.hr, company: 1, groups: GROUPS.hr }, async (env) =>
        env.model('res.partner').browse([ids.acme]).load(['ssn']),
      ),
    ).rejects.toBeInstanceOf(EncryptionError);
  });
});
