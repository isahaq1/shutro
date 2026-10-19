/**
 * The web client's API end to end over HTTP on PostgreSQL 18 with the official apps (RFC 0020 §7.2–§7.3, §7.7):
 * sign-in and lockout, CSRF and origin checks, per-user metadata, CRUD with record rules, lost updates, validation,
 * onchange drafts, transitions, history, grouping, live events, and the app store.
 */

import { DEFAULT_APPS, officialApps, settings } from '@shutro/apps';
import { buildRegistry, createShutro, type Shutro, toDecimal } from '@shutro/core';
import { createDriver, type Driver } from '@shutro/driver-pg';
import { type AppManager, createAppManager } from '@shutro/migrate';
import { type StartedPostgres, startPostgres } from '@shutro/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, LOCKOUT, setMembership, setPassword } from '../src/index.js';

let pg: StartedPostgres;
let driver: Driver;
let apps: AppManager;
let shutro: Shutro;
let base: string;
let close: () => Promise<void>;
const users: Record<'admin' | 'alice' | 'bob' | 'carol', number> = {
  admin: 0,
  alice: 0,
  bob: 0,
  carol: 0,
};
const PASSWORD = 'a long enough passphrase';

/** A browser: cookies and the CSRF token, like the web client. */
class Browser {
  cookie = '';
  csrf = '';
  // The address is read per call: browsers created at describe time exist before the server listens.
  constructor(readonly fixedOrigin?: string) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(this.cookie === '' ? {} : { cookie: this.cookie }),
        ...(this.csrf === '' ? {} : { 'x-csrf-token': this.csrf }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: this.fixedOrigin ?? base,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie !== null) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    const json = text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>);
    return { status: res.status, json: json ?? {}, text, headers: res.headers };
  }
  async login(login: string, password = PASSWORD) {
    const r = await this.call('POST', '/api/auth/login', { login, password });
    if (r.status === 200) this.csrf = String(r.json['csrf']);
    return r;
  }
}

beforeAll(async () => {
  pg = await startPostgres();
  driver = createDriver({ url: pg.url, max: 6, parseNumeric: toDecimal });
  apps = createAppManager({ driver, modules: officialApps });
  const { registry } = await apps.install(DEFAULT_APPS, { actor: 'test' });
  shutro = createShutro({ driver, registry, catalog: officialApps });
  // The base view types the bootstrap (base is always installed).
  const typed = createShutro({ driver, registry: buildRegistry({ modules: [settings] }) });
  const company = await typed.bootstrap({ reason: 'test' }, async (env) => {
    const usd = await env.refId('res.currency', 'base.currency_usd');
    const [c] = await env.model('res.company').create([{ name: 'Paragon Ltd', currency: usd }]);
    const created = await env.model('res.users').create([
      { login: 'admin', name: 'Administrator' },
      { login: 'alice', name: 'Alice' },
      { login: 'bob', name: 'Bob' },
      { login: 'carol', name: 'Carol' },
    ]);
    const [admin = 0, alice = 0, bob = 0, carol = 0] = created.ids.map(Number);
    Object.assign(users, { admin, alice, bob, carol });
    return c?.id as number;
  });
  for (const [login, groups] of [
    ['admin', ['base.admin']],
    ['alice', ['sale.user']],
    ['bob', ['sale.user']],
    ['carol', ['sale.user']],
  ] as const) {
    await setPassword(driver, users[login], PASSWORD);
    await setMembership(driver, users[login], { groups, grants: [], companies: [company] });
  }
  const server = createServer({
    shutro,
    driver,
    apps,
    secureCookies: false,
    onError: (e) => {
      process.stderr.write(`SERVER-ERROR ${(e as Error).stack}
`);
    },
  });
  const listening = await server.listen(0);
  base = `http://127.0.0.1:${listening.port}`;
  close = listening.close;
}, 240_000);

afterAll(async () => {
  await close?.();
  await driver?.end();
  await pg?.stop();
});

describe('sign-in', () => {
  test('a wrong password and an unknown login give the same answer', async () => {
    const wrong = await new Browser().login('alice', 'not the password at all');
    const unknown = await new Browser().login('nobody-here', 'not the password at all');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json['message']).toBe(unknown.json['message']);
  });

  test('the session cookie is HttpOnly and SameSite; the API needs it', async () => {
    const browser = new Browser();
    expect((await browser.call('GET', '/api/meta')).status).toBe(401);
    const r = await browser.login('alice');
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(
      /kosh_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax/,
    );
    expect((await browser.call('GET', '/api/auth/session')).json['user']).toBe(users.alice);
  });

  test(`${LOCKOUT.maxFailures} wrong passwords lock the account; a reset unlocks it`, async () => {
    for (let i = 0; i < LOCKOUT.maxFailures; i++)
      await new Browser().login('carol', 'wrong password number');
    const locked = await new Browser().login('carol');
    expect(locked.status).toBe(423);
    expect(locked.json['code']).toBe('ACCOUNT_LOCKED');
    await setPassword(driver, users.carol, PASSWORD);
    expect((await new Browser().login('carol')).status).toBe(200);
  });

  test('responses carry the security headers, and never a password hash', async () => {
    const admin = new Browser();
    await admin.login('admin');
    const meta = await admin.call('GET', '/api/meta');
    expect(meta.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(meta.headers.get('x-content-type-options')).toBe('nosniff');
    expect(meta.text).not.toContain('scrypt$');
  });
});

describe('writes are protected', () => {
  test('without the CSRF token, or from another origin, writes are refused', async () => {
    const browser = new Browser();
    await browser.login('alice');
    const csrf = browser.csrf;
    browser.csrf = '';
    expect(
      (await browser.call('POST', '/api/records/res.partner', { values: { name: 'X' } })).json[
        'code'
      ],
    ).toBe('CSRF');
    browser.csrf = csrf;
    const evil = await browser.call(
      'POST',
      '/api/records/res.partner',
      { values: { name: 'X' } },
      { origin: 'https://evil.example' },
    );
    expect(evil.status).toBe(403);
    expect(evil.json['code']).toBe('CROSS_ORIGIN');
  });

  test('form posts are refused: the API takes JSON only', async () => {
    const browser = new Browser();
    await browser.login('alice');
    const res = await fetch(`${base}/api/records/res.partner`, {
      method: 'POST',
      headers: {
        cookie: browser.cookie,
        'x-csrf-token': browser.csrf,
        'content-type': 'application/x-www-form-urlencoded',
        origin: base,
      },
      body: 'name=X',
    });
    expect(res.status).toBe(415);
  });
});

describe('metadata', () => {
  test('each user sees the models, fields and rights their roles give', async () => {
    const admin = new Browser();
    await admin.login('admin');
    const all = (await admin.call('GET', '/api/meta')).json as {
      user: { administrator: boolean; companies: { name: string }[] };
      menus: { app: string; models: { model: string }[] }[];
      models: Record<
        string,
        { access: Record<string, boolean>; views: { list: { columns: string[] } } }
      >;
    };
    expect(all.user.administrator).toBe(true);
    expect(all.user.companies).toEqual([{ id: expect.any(Number), name: 'Paragon Ltd' }]);
    expect(all.menus.map((m) => m.app)).toEqual([
      'account',
      'project',
      'purchase',
      'sale',
      'settings',
    ]);
    expect(all.models['sale.order']?.views.list.columns.slice(0, 2)).toEqual(['name', 'partner']);

    const alice = new Browser();
    await alice.login('alice');
    const mine = (await alice.call('GET', '/api/meta')).json as typeof all;
    expect(mine.user.administrator).toBe(false);
    expect(mine.models['sale.order']?.access).toMatchObject({
      read: true,
      create: true,
      unlink: false,
    });
    expect(mine.models['account.move']).toBeUndefined(); // salespeople have no accounting access
    expect(mine.menus.map((m) => m.app)).not.toContain('account');
  });
});

describe('records', () => {
  const alice = new Browser();
  let partner: number;
  let product: number;
  let order: number;
  let updatedAt: string;

  beforeAll(async () => {
    await alice.login('alice');
  });

  test('create and search, with display names for many2one values', async () => {
    const p = await alice.call('POST', '/api/records/res.partner', {
      values: { name: 'Acme Corp', isCustomer: true },
    });
    expect(p.status).toBe(201);
    partner = Number(p.json['id']);
    const admin = new Browser();
    await admin.login('admin');
    const uom = (await admin.call('GET', '/api/records/uom.uom/names?q=Units')).json as {
      names: { id: number }[];
    };
    const pr = await admin.call('POST', '/api/records/product.product', {
      values: { name: 'Laptop', listPrice: '1000', uom: uom.names[0]?.id },
    });
    product = Number(pr.json['id']);
    const found = await alice.call('POST', '/api/records/res.partner/search', {
      where: { name: { ilike: 'acme%' } },
    });
    expect(found.json['total']).toBe(1);
  });

  test('search values are parameters: an injection attempt is just text', async () => {
    const attack = "x'; DROP TABLE res_partner; --";
    const r = await alice.call('POST', '/api/records/res.partner/search', {
      where: { name: { ilike: attack } },
    });
    expect(r.status).toBe(200);
    expect(r.json['total']).toBe(0);
    const still = await alice.call('POST', '/api/records/res.partner/search', {
      where: { name: 'Acme Corp' },
    });
    expect(still.json['total']).toBe(1);
    // Field names are checked too: an unknown key is an error, never SQL.
    const bad = await alice.call('POST', '/api/records/res.partner/search', {
      where: { 'name; DROP': 'x' },
    });
    expect(bad.status).toBe(400);
  });

  test('a validation error names the fields', async () => {
    const r = await alice.call('POST', '/api/records/sale.order', { values: { currency: 1 } });
    expect(r.status).toBe(422);
    expect(r.json['fields']).toContain('partner');
  });

  test('onchange fills the line from the product and keeps nothing', async () => {
    const r = await alice.call('POST', '/api/records/sale.order.line/onchange', {
      values: { product: { id: product, name: 'Laptop' } },
      changed: ['product'],
    });
    expect(r.status).toBe(200);
    expect(r.json['values']).toMatchObject({ name: 'Laptop', priceUnit: '1000' });
  });

  test('an order with lines: numbered, totals computed, transitions offered', async () => {
    const currency = (await alice.call('GET', '/api/records/res.currency/names?q=USD')).json as {
      names: { id: number }[];
    };
    const created = await alice.call('POST', '/api/records/sale.order', {
      values: {
        partner: { id: partner, name: 'Acme Corp' },
        currency: currency.names[0]?.id,
        lines: { create: [{ product, name: 'Laptop', quantity: '2', priceUnit: '1000' }] },
      },
    });
    expect(created.status).toBe(201);
    order = Number(created.json['id']);
    const read = await alice.call('GET', `/api/records/sale.order/${order}`);
    const row = read.json['row'] as Record<string, unknown>;
    expect(row['name']).toMatch(/^SO\/\d{4}\/00001$/);
    expect(row['partner']).toEqual({ id: partner, name: 'Acme Corp' });
    expect(row['amountTotal']).toMatchObject({ amount: '2000.00' });
    expect(read.json['transitions']).toEqual(expect.arrayContaining(['send', 'confirm', 'cancel']));
    updatedAt = String(row['updatedAt']);
  });

  test('a save based on an old version is refused (lost update)', async () => {
    expect(
      (
        await alice.call('PATCH', `/api/records/sale.order/${order}`, {
          values: { note: 'first' },
          expect: { updatedAt },
        })
      ).status,
    ).toBe(200);
    const stale = await alice.call('PATCH', `/api/records/sale.order/${order}`, {
      values: { note: 'second' },
      expect: { updatedAt },
    });
    expect(stale.status).toBe(409);
    expect(stale.json['code']).toBe('STALE_RECORD');
  });

  test('transitions run with their guards; unknown ones are not callable', async () => {
    expect(
      (await alice.call('POST', `/api/records/sale.order/${order}/transition/confirm`)).status,
    ).toBe(200);
    expect(
      (await alice.call('POST', `/api/records/sale.order/${order}/transition/unlink`)).status,
    ).toBe(404);
    const read = await alice.call('GET', `/api/records/sale.order/${order}`);
    expect((read.json['row'] as Record<string, unknown>)['state']).toBe('sale');
  });

  test("record rules: another salesperson cannot see Alice's order", async () => {
    const bob = new Browser();
    await bob.login('bob');
    expect((await bob.call('GET', `/api/records/sale.order/${order}`)).status).toBe(404);
    expect((await bob.call('POST', '/api/records/sale.order/search', {})).json['total']).toBe(0);
  });

  test('grouping and history', async () => {
    const groups = (await alice.call('POST', '/api/records/sale.order/group', { by: 'state' }))
      .json['groups'] as Record<string, unknown>[];
    expect(groups).toEqual([expect.objectContaining({ state: 'sale', count: 1 })]);
    const trail = (await alice.call('GET', `/api/records/sale.order/${order}/trail`)).json[
      'entries'
    ] as unknown[];
    expect(trail.length).toBeGreaterThan(0);
  });
});

describe('live events', () => {
  test('a change made by one user reaches another user who can read the model', async () => {
    const watcher = new Browser();
    await watcher.login('admin');
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { cookie: watcher.cookie },
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const received = (async () => {
      let text = '';
      while (!text.includes('event: change')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text;
    })();
    const alice = new Browser();
    await alice.login('alice');
    await alice.call('POST', '/api/records/res.partner', { values: { name: 'Live Ltd' } });
    const text = await received;
    controller.abort();
    expect(text).toContain('"model":"res.partner"');
    expect(text).toContain('"op":"create"');
  });
});

describe('app store', () => {
  test('only administrators manage apps; uninstall and reinstall change what the API serves', async () => {
    const alice = new Browser();
    await alice.login('alice');
    expect((await alice.call('GET', '/api/apps')).status).toBe(403);

    const admin = new Browser();
    await admin.login('admin');
    const list = (await admin.call('GET', '/api/apps')).json['apps'] as {
      name: string;
      state: string;
    }[];
    expect(list.find((a) => a.name === 'project')?.state).toBe('installed');
    const plan = (
      await admin.call('POST', '/api/apps/plan', { operation: 'uninstall', apps: ['project'] })
    ).json;
    expect((plan['modules'] as { name: string }[]).map((m) => m.name)).toEqual([
      'sale_project',
      'project',
    ]);
    expect((await admin.call('POST', '/api/apps/uninstall', { apps: ['project'] })).status).toBe(
      200,
    );
    expect((await admin.call('POST', '/api/records/project.task/search', {})).status).toBe(404);
    expect((await admin.call('POST', '/api/apps/install', { apps: ['project'] })).status).toBe(200);
    expect((await admin.call('POST', '/api/records/project.task/search', {})).status).toBe(200);
  });
});

describe('passwords', () => {
  test('changing the password ends every session', async () => {
    const one = new Browser();
    const two = new Browser();
    await one.login('bob');
    await two.login('bob');
    const r = await one.call('POST', '/api/auth/password', {
      current: PASSWORD,
      next: 'another long passphrase',
    });
    expect(r.status).toBe(200);
    expect((await two.call('GET', '/api/meta')).status).toBe(401);
    expect((await new Browser().login('bob', 'another long passphrase')).status).toBe(200);
  });
});
