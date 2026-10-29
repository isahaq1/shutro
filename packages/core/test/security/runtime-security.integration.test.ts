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
  fields: { body: f.char({ required: true }), cost: f.char() },
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

test('field security at runtime: hide or lock a field for everyone but some roles', async () => {
  const shutro = app();
  await driver.query(compile(sql`INSERT INTO x_note (body, cost) VALUES (${'memo'}, ${'100'})`));
  const asUser = (groups: string[]) =>
    shutro.run({ user: 1, company: 1, groups }, async (env) => ({
      read: env.access.canField('x.note', 'cost', 'read'),
      writeBody: env.access.canField('x.note', 'body', 'write'),
      cost: await (await env.model('x.note').search({}))
        .load(['cost'])
        .then((r) => r.mapped('cost'))
        .catch((e: unknown) => (e instanceof AccessError ? 'denied' : e)),
      filter: await env
        .model('x.note')
        .search({ where: { cost: '100' } })
        .then((r) => r.length)
        .catch((e: unknown) => (e instanceof AccessError ? 'denied' : e)),
      body: (await (await env.model('x.note').search({})).load(['body'])).mapped('body'),
    }));
  expect(await asUser(['base.user'])).toMatchObject({ read: true, cost: ['100'], filter: 1 });

  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    await env.securityAdmin.saveRole({
      code: 'x.finance',
      label: 'Finance',
      implies: ['base.user'],
    });
    await env.securityAdmin.setFieldGroups('x.note', 'cost', { read: ['x.finance'] });
    await env.securityAdmin.setFieldGroups('x.note', 'body', { write: ['x.finance'] });
  });
  // Hidden from plain users (also as a filter: matching would leak it); read-only body.
  expect(await asUser(['base.user'])).toEqual({
    read: false,
    writeBody: false,
    cost: 'denied',
    filter: 'denied',
    body: ['memo'],
  });
  expect(await asUser(['x.finance'])).toEqual({
    read: true,
    writeBody: true,
    cost: ['100'],
    filter: 1,
    body: ['memo'],
  });

  // A role in use by field security cannot be deleted (that would change who sees the field).
  await expect(
    shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, (env) =>
      env.securityAdmin.deleteRole('x.finance'),
    ),
  ).rejects.toBeInstanceOf(InvalidModuleError);
  await expect(
    shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, (env) =>
      env.securityAdmin.setFieldGroups('x.note', 'nope', { read: ['x.finance'] }),
    ),
  ).rejects.toBeInstanceOf(InvalidModuleError);
  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    await env.securityAdmin.setFieldGroups('x.note', 'cost', {});
    await env.securityAdmin.setFieldGroups('x.note', 'body', {});
    await env.securityAdmin.deleteRole('x.finance');
  });
  expect(await asUser(['base.user'])).toMatchObject({ read: true, writeBody: true, cost: ['100'] });
});

test('administratorGroups: code administrator groups and runtime roles that are or imply one', async () => {
  const shutro = app();
  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    await env.securityAdmin.saveRole({ code: 'x.boss', label: 'Boss', implies: ['base.admin'] });
    await env.securityAdmin.saveRole({ code: 'x.root', label: 'Root', administrator: true });
    await env.securityAdmin.saveRole({ code: 'x.clerk', label: 'Clerk', implies: ['base.user'] });
  });
  const codes = await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, async (env) => [
    ...env.access.administratorGroups(),
  ]);
  expect(codes.sort()).toEqual(['base.admin', 'x.boss', 'x.root']);
  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    for (const code of ['x.boss', 'x.root', 'x.clerk']) await env.securityAdmin.deleteRole(code);
  });
});

test('describe: the runtime additions as stored, read through the transaction; administrators only', async () => {
  const shutro = app();
  const described = await shutro.run(
    { user: 3, company: 1, groups: ['base.admin'] },
    async (env) => {
      const admin = env.securityAdmin;
      await admin.saveRole({ code: 'x.auditor', label: 'Auditor', implies: ['base.user'] });
      await admin.setAccess('x.auditor', 'x.secret', ['read']);
      await admin.saveRule({
        name: 'auditor_own',
        role: 'x.auditor',
        model: 'x.secret',
        perms: ['read'],
        domain: { user: { $env: 'uid' } },
      });
      await admin.grantPermission('x.auditor', 'x.approve');
      await admin.setFieldGroups('x.secret', 'text', { read: ['x.auditor'] });
      return admin.describe(); // in the same transaction: the changes above show
    },
  );
  expect(described.roles).toContainEqual({
    code: 'x.auditor',
    label: 'Auditor',
    implies: ['base.user'],
    administrator: false,
  });
  expect(described.access).toContainEqual({
    role: 'x.auditor',
    model: 'x.secret',
    perms: ['read'],
  });
  expect(described.rules).toContainEqual({
    name: 'auditor_own',
    role: 'x.auditor',
    model: 'x.secret',
    perms: ['read'],
    domain: { user: { $env: 'uid' } },
  });
  expect(described.permissions).toContainEqual({ role: 'x.auditor', permission: 'x.approve' });
  expect(described.fields).toContainEqual({
    model: 'x.secret',
    field: 'text',
    read: ['x.auditor'],
    write: [],
  });
  await expect(
    shutro.run({ user: 1, company: 1, groups: ['base.user'] }, (env) =>
      env.securityAdmin.describe(),
    ),
  ).rejects.toBeInstanceOf(AccessError);
  await shutro.run({ user: 3, company: 1, groups: ['base.admin'] }, async (env) => {
    await env.securityAdmin.setFieldGroups('x.secret', 'text', {});
    await env.securityAdmin.deleteRole('x.auditor');
  });
});
