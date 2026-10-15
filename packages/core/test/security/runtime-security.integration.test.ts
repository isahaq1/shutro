/**
 * Runtime security (RFC 0014 §7.10): administrators create roles, grant access, add record rules and grant feature
 * permissions while the system runs; changes are validated when saved and reach every process through NOTIFY.
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  createShutro,
  createTableStatements,
  defineGroup,
  defineModel,
  defineModule,
  definePermission,
  f,
  type Id,
  InvalidDomainError,
  InvalidModuleError,
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
const Note = defineModel('x.note', {
  access: { 'base.user': ['read'] },
  fields: { body: f.char({ required: true }) },
});
// No code grant at all: only runtime security opens it.
const Secret = defineModel('x.secret', {
  fields: { text: f.char({ required: true }), user: f.many2one('res.users', { required: true }) },
});
const registry = buildRegistry({
  modules: [
    defineModule({
      name: 'base',
      groups: [
        defineGroup({ code: 'base.user' }),
        defineGroup({ code: 'base.admin', administrator: true }),
      ],
      permissions: [definePermission({ code: 'x.approve', groups: [] })],
      models: [Users, Currency, Company, Note, Secret],
    }),
  ],
});

let pg: StartedPostgres;
let driver: Driver;
let other: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 4, parseNumeric: toDecimal });
  other = createDriver({ url: pg.url, max: 2, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
  await driver.query(
    compile(sql`INSERT INTO res_users (login) VALUES (${'alice'}), (${'bob'}), (${'root'})`),
  );
  await driver.query(
    compile(sql`INSERT INTO x_secret (text, user_id) VALUES (${'alice-1'}, 1), (${'bob-1'}, 2)`),
  );
}, 180_000);

afterAll(async () => {
  await other?.end();
  await driver?.end();
  await pg?.stop();
});

const app = () => createShutro({ driver, registry, runtimeSecurity: true });

test('an administrator opens a model to a new role at runtime, with a rule and a permission', async () => {
  const shutro = app();
  const elsewhere = createShutro({ driver: other, registry, runtimeSecurity: true }); // another process
  const asTeam = (s: typeof shutro, user: number) =>
    s.run({ user, company: 1, groups: ['x.team'] }, async (env) => ({
      secrets: (await env.model('x.secret').search({ order: ['id'] })).mapped('text'),
      notes: env.access.can('x.note', 'read'),
      approve: env.access.has('x.approve'),
    }));
  await expect(asTeam(shutro, 1)).rejects.toBeInstanceOf(AccessError);
  await elsewhere.run({ user: 3, company: 1 }, async () => 1); // loads and starts listening

  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    const admin = env.securityAdmin;
    await admin.saveRole({ code: 'x.team', label: 'Team', implies: ['base.user'] });
    await admin.setAccess('x.team', 'x.secret', ['read', 'create']);
    await admin.saveRule({
      name: 'own_secrets',
      role: 'x.team',
      model: 'x.secret',
      perms: ['read'],
      domain: { user: { $env: 'uid' } },
    });
    await admin.grantPermission('x.team', 'x.approve');
  });
  expect(await asTeam(shutro, 1)).toEqual({ secrets: ['alice-1'], notes: true, approve: true });
  expect(await asTeam(shutro, 2)).toEqual({ secrets: ['bob-1'], notes: true, approve: true });

  // The other process reloaded on NOTIFY.
  let seen: unknown;
  for (let i = 0; i < 40 && seen === undefined; i++) {
    seen = await asTeam(elsewhere, 1).catch(() => undefined);
    if (seen === undefined) await new Promise((r) => setTimeout(r, 50));
  }
  expect(seen).toEqual({ secrets: ['alice-1'], notes: true, approve: true });

  // Changes are audited.
  const [count] = await driver.query<{ n: number }>(
    compile(sql`SELECT count(*)::int AS n FROM shutro_audit WHERE action = 'security'`),
  );
  expect(count?.n).toBe(4);

  // Removing the role closes it again.
  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, (env) =>
    env.securityAdmin.deleteRole('x.team'),
  );
  await expect(asTeam(shutro, 1)).rejects.toBeInstanceOf(AccessError);
});

test('changes are validated when saved; only administrators make them', async () => {
  const shutro = app();
  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    const admin = env.securityAdmin;
    await expect(admin.setAccess('x.nobody', 'x.secret', ['read'])).rejects.toBeInstanceOf(
      InvalidModuleError,
    );
    await admin.saveRole({ code: 'x.viewer' });
    await expect(admin.setAccess('x.viewer', 'x.nothing', ['read'])).rejects.toThrow(
      /is not installed/,
    );
    await expect(admin.setAccess('x.viewer', 'x.secret', ['fly' as never])).rejects.toThrow(
      /is not a permission/,
    );
    await expect(
      admin.saveRule({
        name: 'bad',
        role: 'x.viewer',
        model: 'x.secret',
        perms: ['read'],
        domain: { nope: 1 },
      }),
    ).rejects.toBeInstanceOf(InvalidDomainError);
    await expect(admin.grantPermission('x.viewer', 'x.missing')).rejects.toThrow(
      /not declared by any module/,
    );
    await expect(admin.saveRole({ code: 'base.user' })).rejects.toThrow(/declared in code/);
  });
  await expect(
    shutro.run({ user: 1, company: 1, groups: ['base.user'] }, (env) =>
      env.securityAdmin.saveRole({ code: 'x.mine' }),
    ),
  ).rejects.toBeInstanceOf(AccessError);
  await expect(
    createShutro({ driver, registry }).run({ user: 3, company: 1, groups: ['base.admin'] }, (env) =>
      env.securityAdmin.saveRole({ code: 'x.off' }),
    ),
  ).rejects.toThrow(/not enabled/);
  void (0 as unknown as Id<'res.users'>);
});
