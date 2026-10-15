/**
 * Installing a database through the ORM (feedback #5), `enforce: 'warn'` (#19), the pool-size check for standard
 * sequences (#21) and the `sql` re-export (#7).
 */
import { createDriver, type Driver } from '@shutro/driver-pg';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  AccessError,
  buildRegistry,
  compile,
  createShutro,
  createTableStatements,
  defineGroup,
  defineModel,
  defineModule,
  defineSequence,
  f,
  type Id,
  InvalidSequenceError,
  SecurityDefinitionError,
  SYSTEM_UID,
  sql,
  toDecimal,
} from '../../src/index.js';

const Users = defineModel('res.users', {
  access: { 'base.admin': ['read', 'write', 'create'] },
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
  // No access declared: denied by default, reported (and allowed) under enforce: 'warn'.
  fields: { body: f.char({ required: true }), internal: f.char({ groups: ['base.admin'] }) },
});
const groups = [
  defineGroup({ code: 'base.user' }),
  defineGroup({ code: 'base.admin', implies: ['base.user'] }),
];
const modules = [defineModule({ name: 'base', groups, models: [Users, Currency, Company, Note] })];
const registry = buildRegistry({ modules });

let pg: StartedPostgres;
let driver: Driver;

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 3, parseNumeric: toDecimal });
  for (const statement of createTableStatements(registry)) await driver.query(statement);
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await pg?.stop();
});

describe('bootstrap', () => {
  test('the first currency, company and user are created through the ORM, without a user row', async () => {
    const shutro = createShutro({ driver, registry });
    const ids = await shutro.bootstrap({ reason: 'install' }, async (env) => {
      expect(env.uid).toBe(SYSTEM_UID);
      expect(env.su).toBe(true);
      const bdt = (await env.model('res.currency').create([{ name: 'BDT' }])).first();
      const company = (
        await env.model('res.company').create([{ name: 'Acme', currency: bdt.id }])
      ).first();
      const admin = (await env.model('res.users').create([{ login: 'admin' }])).first();
      return { company: company.id, admin: admin.id };
    });
    const [row] = await driver.query<{
      created_by_id: number | null;
      updated_by_id: number | null;
    }>(compile(sql`SELECT created_by_id, updated_by_id FROM res_users WHERE id = ${ids.admin}`));
    expect(row).toEqual({ created_by_id: null, updated_by_id: null });
    // From here on, the application runs as real users.
    const logins = await shutro.run(
      { user: Number(ids.admin), company: Number(ids.company), groups: ['base.admin'] },
      async (env) => {
        await env.model('res.users').create([{ login: 'alice' }]);
        return (await env.model('res.users').search({ order: ['id'] })).map((u) => u.login);
      },
    );
    expect(logins).toEqual(['admin', 'alice']);
    const [alice] = await driver.query<{ created_by_id: number }>(
      compile(sql`SELECT created_by_id FROM res_users WHERE login = ${'alice'}`),
    );
    expect(Number(alice?.created_by_id)).toBe(Number(ids.admin));
  });

  test('a reason is required', async () => {
    await expect(
      createShutro({ driver, registry }).bootstrap({ reason: ' ' }, async () => 1),
    ).rejects.toThrow(/reason is required/);
  });
});

describe("enforce: 'warn'", () => {
  test('missing grants are reported once and allowed; record rules and the production guard stay', async () => {
    const reports: string[] = [];
    const warn = buildRegistry({
      modules,
      security: { enforce: 'warn', onDenied: (m) => reports.push(m) },
    });
    expect(warn.security.mode).toBe('warn');
    const shutro = createShutro({ driver, registry: warn });
    const bodies = await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, async (env) => {
      await env.model('x.note').create([{ body: 'hello', internal: 'x' }]);
      await env.model('x.note').create([{ body: 'again' }]);
      return (await env.model('x.note').search({ order: ['id'] })).map((n) => n.body);
    });
    expect(bodies).toEqual(['hello', 'again']);
    expect(reports.some((m) => m.includes('create access to x.note would be denied'))).toBe(true);
    expect(reports.some((m) => m.includes('write of x.note.internal would be denied'))).toBe(true);
    expect(new Set(reports).size).toBe(reports.length); // each once
    // The default registry still denies.
    await expect(
      createShutro({ driver, registry }).run(
        { user: 1, company: 1, groups: ['base.user'] },
        (env) => env.model('x.note').search(),
      ),
    ).rejects.toBeInstanceOf(AccessError);
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      expect(() => buildRegistry({ modules, security: { enforce: 'warn' } })).toThrow(
        SecurityDefinitionError,
      );
    } finally {
      process.env['NODE_ENV'] = previous;
    }
  });
});

describe('pool size', () => {
  test('standard sequences on a one-connection pool fail fast; gapless ones are fine', async () => {
    const Doc = defineModel('x.doc', { fields: { name: f.char({ sequence: 'x.doc' }) } });
    const of = (gapless: boolean) =>
      buildRegistry({
        modules: [
          defineModule({
            name: 'x',
            groups,
            models: [Users, Currency, Company, Doc],
            sequences: [defineSequence({ code: 'x.doc', prefix: 'D', gapless })],
          }),
        ],
        security: { enforce: false },
      });
    const single = createDriver({ url: pg.url, max: 1 });
    try {
      expect(() => createShutro({ driver: single, registry: of(false) })).toThrow(
        InvalidSequenceError,
      );
      expect(() => createShutro({ driver: single, registry: of(true) })).not.toThrow();
      expect(() => createShutro({ driver, registry: of(false) })).not.toThrow();
    } finally {
      await single.end();
    }
  });
});

test('sql and compile come from @shutro/core', () => {
  const id = 7 as Id<'res.users'>;
  expect(compile(sql`SELECT ${id}`)).toEqual({ text: 'SELECT $1', params: [7] });
});
