/**
 * `createServer()` (RFC 0020 §7.1): the JSON API of the web client and the static files of the client itself.
 *
 * Every API call runs in `shutro.run()` as the signed-in user, so security is the ORM's, never the browser's. Writes
 * need the session's CSRF token in `x-csrf-token` and a same-origin `Origin`; bodies are JSON only.
 */
import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Env, type Registry, SECURITY_CHANNEL, type Shutro } from '@shutro/core';
import type { Driver } from '@shutro/driver-pg';
import { type AppManager, MODULES_CHANNEL } from '@shutro/migrate';
import { compile, sql } from '@shutro/sql';
import {
  ensureAuthTables,
  resolveSession,
  type Session,
  setPassword,
  signIn,
  signOut,
  switchCompany,
  verifyPassword,
} from './auth.js';
import { type DynamicEnv, dynamic } from './dynamic.js';
import { badRequest, HttpError, unauthorized } from './errors.js';
import {
  type Ctx,
  parseCookies,
  Router,
  readJson,
  SECURITY_HEADERS,
  sendJson,
  serveStatic,
  toHttp,
} from './http.js';
import { buildMeta, type Meta, type ModelMeta } from './meta.js';
import * as records from './records.js';

/** The channel the server announces committed changes on (live updates across processes). */
export const CHANGES_CHANNEL = 'kosh_changes';
const COOKIE = 'kosh_session';

/** Options of {@link createServer}. */
export interface ServerOptions {
  readonly shutro: Shutro;
  readonly driver: Driver;
  /** Enables the app store API and keeps `shutro` on the installed set (`apps.attach`). */
  readonly apps?: AppManager;
  /** The built web client (`@shutro/web` dist) to serve under `/`. */
  readonly staticDir?: string;
  /** `Secure` cookies (default true): turn off only for plain-HTTP development on localhost. */
  readonly secureCookies?: boolean;
  /** The users model (default `res.users`). */
  readonly usersModel?: string;
  /** Unexpected errors (500s), for the server log. Default: `process.emitWarning`. */
  readonly onError?: (error: unknown) => void;
}

/** A running server. */
export interface ShutroServer {
  /** The Node request handler, to mount in another server. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** Listens on `port` (0 = any free port). */
  listen(port: number, host?: string): Promise<{ readonly port: number; close(): Promise<void> }>;
}

interface Client {
  readonly session: Session;
  readonly res: ServerResponse;
  readonly models: ReadonlySet<string>;
}

/** Creates the API server. */
export function createServer(options: ServerOptions): ShutroServer {
  const { shutro, driver } = options;
  const secure = options.secureCookies ?? true;
  const onError =
    options.onError ??
    ((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.emitWarning(`Shutro server error: ${message}`, { code: 'SHUTRO_SERVER_ERROR' });
    });
  const usersModel = options.usersModel ?? 'res.users';
  const registry = (): Registry => {
    const current = shutro.registry;
    if (current === undefined)
      throw new HttpError(503, 'NO_REGISTRY', 'The server has no models.', 'Install apps first.');
    return current;
  };
  const usersTable = (): string => registry().get(usersModel).model.table;

  // ---- startup: tables, following installs and security changes
  const clients = new Set<Client>();
  const metaCache = new Map<
    string,
    { registry: Registry; models: Readonly<Record<string, ModelMeta>> }
  >();
  let ready: Promise<void> | undefined;
  const start = (): Promise<void> => {
    ready ??= (async () => {
      await ensureAuthTables(driver);
      if (options.apps !== undefined) await options.apps.attach(shutro);
      const forget = (): void => metaCache.clear();
      await driver.listen(MODULES_CHANNEL, forget);
      await driver.listen(SECURITY_CHANNEL, forget);
      await driver.listen(CHANGES_CHANNEL, (payload) => {
        let change: { model?: unknown };
        try {
          change = JSON.parse(payload) as { model?: unknown };
        } catch {
          return;
        }
        if (typeof change.model !== 'string') return;
        for (const client of clients)
          if (client.models.has(change.model))
            client.res.write(`event: change\ndata: ${payload}\n\n`);
      });
    })();
    return ready;
  };

  // ---- sessions
  const sessionOf = async (ctx: Ctx): Promise<{ token: string; session: Session }> => {
    const token = ctx.cookies[COOKIE] ?? '';
    const session = token === '' ? undefined : await resolveSession(driver, token);
    if (session === undefined) throw unauthorized();
    return { token, session };
  };
  const writeGuard = (ctx: Ctx, session: Session): void => {
    const origin = ctx.req.headers.origin;
    const host = ctx.req.headers.host;
    const originHost = ((): string | undefined => {
      try {
        return origin === undefined ? undefined : new URL(origin).host;
      } catch {
        return ''; // a malformed Origin is never this site
      }
    })();
    if (originHost !== undefined && host !== undefined && originHost !== host)
      throw new HttpError(
        403,
        'CROSS_ORIGIN',
        'Requests from other sites are refused.',
        'Use the application itself.',
      );
    if (ctx.req.headers['x-csrf-token'] !== session.csrf)
      throw new HttpError(
        403,
        'CSRF',
        'The request is missing its security token.',
        'Reload the page and try again.',
      );
  };
  const run = <T>(session: Session, fn: (env: DynamicEnv, raw: Env) => Promise<T>): Promise<T> =>
    shutro.run(
      {
        user: session.userId,
        company: session.company,
        companies: session.companies,
        groups: session.groups,
        grants: session.grants,
        lang: session.lang,
        tz: session.tz,
      },
      (env) => fn(dynamic(env as Env), env as Env),
    );
  /** The models this user may see: built once per registry and role set, reused by every request. */
  const modelsFor = (env: DynamicEnv, session: Session): Readonly<Record<string, ModelMeta>> => {
    const reg = registry();
    const key = `${[...session.groups].sort().join(',')}|${[...session.grants].sort().join(',')}|${session.lang}`;
    const cached = metaCache.get(key);
    if (cached !== undefined && cached.registry === reg) return cached.models;
    const { models } = buildMeta(reg, env, {
      user: { name: '', login: '' },
      companies: [],
      apps: [],
    });
    if (metaCache.size > 200) metaCache.clear();
    metaCache.set(key, { registry: reg, models });
    return models;
  };
  const announce = async (
    model: string,
    ids: readonly number[],
    op: string,
    by: number,
  ): Promise<void> => {
    await driver.query(
      compile(
        sql`SELECT pg_notify(${CHANGES_CHANNEL}, ${JSON.stringify({ model, ids, op, by, id: randomUUID() })})`,
      ),
    );
  };
  const cookie = (value: string, maxAge: number): string =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  // ---- routes
  const router = new Router();
  router.add('GET', '/api/health', async () => ({ ok: true }));

  router.add('POST', '/api/auth/login', async (ctx) => {
    const body = (await ctx.body()) as { login?: unknown; password?: unknown } | undefined;
    if (typeof body?.login !== 'string' || typeof body.password !== 'string')
      throw badRequest('Send a login and a password.', '{ "login": "...", "password": "..." }');
    const { token, session } = await signIn(driver, {
      usersTable: usersTable(),
      login: body.login,
      password: body.password,
      ip: ctx.ip,
      userAgent: String(ctx.req.headers['user-agent'] ?? ''),
    });
    sendJson(ctx.res, 200, { csrf: session.csrf }, { 'set-cookie': cookie(token, 14 * 86_400) });
    return HANDLED;
  });

  router.add('POST', '/api/auth/logout', async (ctx) => {
    const { token, session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    await signOut(driver, token);
    sendJson(ctx.res, 204, undefined, { 'set-cookie': cookie('', 0) });
    return HANDLED;
  });

  router.add('GET', '/api/auth/session', async (ctx) => {
    const { session } = await sessionOf(ctx);
    return { csrf: session.csrf, user: session.userId, company: session.company };
  });

  router.add('POST', '/api/auth/company', async (ctx) => {
    const { token, session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    const company = Number(((await ctx.body()) as { company?: unknown } | undefined)?.company);
    await switchCompany(driver, token, session, company);
    return { company };
  });

  router.add('POST', '/api/auth/password', async (ctx) => {
    const { session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    const body = (await ctx.body()) as { current?: unknown; next?: unknown } | undefined;
    if (typeof body?.current !== 'string' || typeof body.next !== 'string')
      throw badRequest(
        'Send the current and the new password.',
        '{ "current": "...", "next": "..." }',
      );
    const [row] = await driver.query<{ password_hash: string | null }>(
      compile(sql`SELECT password_hash FROM "kosh_user" WHERE user_id = ${session.userId}`),
    );
    if (row?.password_hash == null || !(await verifyPassword(body.current, row.password_hash)))
      throw new HttpError(
        403,
        'INVALID_CREDENTIALS',
        'The current password is wrong.',
        'Check it and try again.',
        ['current'],
      );
    await setPassword(driver, session.userId, body.next); // ends every session, this one too
    sendJson(ctx.res, 200, { signedOut: true }, { 'set-cookie': cookie('', 0) });
    return HANDLED;
  });

  router.add('GET', '/api/meta', async (ctx) => {
    const { session } = await sessionOf(ctx);
    const apps = options.apps === undefined ? [] : await options.apps.list();
    return run(session, async (env) => {
      const users = registry().get(usersModel).model;
      const [user] = (
        await env.model(usersModel).browse([session.userId]).load(['name', 'login'])
      ).read(['name', 'login']);
      const companyModel = env.access.can('res.company', 'read') ? 'res.company' : undefined;
      const companies =
        companyModel === undefined
          ? session.companies.map((id) => ({ id, name: `#${id}` }))
          : (
              await env
                .model(companyModel)
                .browse([...session.companies])
                .load(['name'])
            )
              .read(['name'])
              .map((c) => ({ id: Number(c['id']), name: String(c['name']) }));
      const meta: Meta = buildMeta(registry(), env, {
        user: { name: String(user?.['name'] ?? ''), login: String(user?.['login'] ?? users.name) },
        companies,
        apps,
      });
      return meta;
    });
  });

  const model = (ctx: Ctx, env: DynamicEnv, session: Session): ModelMeta =>
    records.modelOf(modelsFor(env, session), ctx.params['model'] ?? '');
  const idOf = (ctx: Ctx): number => Number(ctx.params['id']);

  router.add('POST', '/api/records/:model/search', async (ctx) => {
    const { session } = await sessionOf(ctx);
    const body = await ctx.body();
    return run(session, (env) =>
      records.search(env, modelsFor(env, session), model(ctx, env, session), body),
    );
  });
  router.add('POST', '/api/records/:model/group', async (ctx) => {
    const { session } = await sessionOf(ctx);
    const body = await ctx.body();
    return run(session, async (env) => ({
      groups: await records.group(env, model(ctx, env, session), body),
    }));
  });
  router.add('GET', '/api/records/:model/names', async (ctx) => {
    const { session } = await sessionOf(ctx);
    return run(session, async (env) => ({
      names: await records.names(env, model(ctx, env, session), ctx.query.get('q') ?? ''),
    }));
  });
  router.add('POST', '/api/records/:model/onchange', async (ctx) => {
    const { session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    const body = await ctx.body();
    // Onchange computes a draft: nothing it does is kept.
    return shutroDraft(session, (env) =>
      records.onchange(env, modelsFor(env, session), model(ctx, env, session), body),
    );
  });
  router.add('POST', '/api/records/:model', async (ctx) => {
    const { session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    const body = await ctx.body();
    const created = await run(session, (env) =>
      records.create(env, model(ctx, env, session), body),
    );
    await announce(ctx.params['model'] ?? '', [created.id], 'create', session.userId);
    sendJson(ctx.res, 201, created);
    return HANDLED;
  });
  router.add('GET', '/api/records/:model/:id', async (ctx) => {
    const { session } = await sessionOf(ctx);
    const fields = ctx.query
      .get('fields')
      ?.split(',')
      .filter((f) => f !== '');
    return run(session, (env) =>
      records.read(env, modelsFor(env, session), model(ctx, env, session), idOf(ctx), fields),
    );
  });
  router.add('PATCH', '/api/records/:model/:id', async (ctx) => {
    const { session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    const body = await ctx.body();
    await run(session, (env) => records.write(env, model(ctx, env, session), idOf(ctx), body));
    await announce(ctx.params['model'] ?? '', [idOf(ctx)], 'write', session.userId);
    return { ok: true };
  });
  router.add('DELETE', '/api/records/:model/:id', async (ctx) => {
    const { session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    await run(session, (env) => records.remove(env, model(ctx, env, session), idOf(ctx)));
    await announce(ctx.params['model'] ?? '', [idOf(ctx)], 'unlink', session.userId);
    sendJson(ctx.res, 204, undefined);
    return HANDLED;
  });
  router.add('POST', '/api/records/:model/:id/transition/:name', async (ctx) => {
    const { session } = await sessionOf(ctx);
    writeGuard(ctx, session);
    await run(session, (env) =>
      records.transition(env, model(ctx, env, session), idOf(ctx), ctx.params['name'] ?? ''),
    );
    await announce(ctx.params['model'] ?? '', [idOf(ctx)], 'write', session.userId);
    return { ok: true };
  });
  router.add('GET', '/api/records/:model/:id/trail', async (ctx) => {
    const { session } = await sessionOf(ctx);
    const before = ctx.query.get('before');
    return run(session, async (env) => ({
      entries: await records.trail(
        env,
        model(ctx, env, session),
        idOf(ctx),
        before === null ? undefined : Number(before),
      ),
    }));
  });

  router.add('GET', '/api/events', async (ctx) => {
    const { session } = await sessionOf(ctx);
    const models = await run(session, async (env) => new Set(Object.keys(modelsFor(env, session))));
    ctx.res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    ctx.res.write('retry: 3000\n\n');
    const client: Client = { session, res: ctx.res, models };
    clients.add(client);
    const beat = setInterval(() => ctx.res.write(': keep-alive\n\n'), 25_000);
    beat.unref();
    ctx.req.on('close', () => {
      clearInterval(beat);
      clients.delete(client);
    });
    return HANDLED;
  });

  // ---- apps (administrators only)
  const admin = async (
    ctx: Ctx,
    write: boolean,
  ): Promise<{ apps: AppManager; session: Session }> => {
    const { session } = await sessionOf(ctx);
    if (write) writeGuard(ctx, session);
    if (options.apps === undefined)
      throw new HttpError(
        404,
        'NO_APPS',
        'This server does not manage apps.',
        'Pass apps to createServer.',
      );
    const isAdmin = await run(session, async (env) => env.administrator);
    if (!isAdmin)
      throw new HttpError(
        403,
        'ACCESS',
        'Only administrators manage apps.',
        'Ask an administrator.',
      );
    return { apps: options.apps, session };
  };
  const names = (body: unknown): string[] => {
    const list = (body as { apps?: unknown } | undefined)?.apps;
    if (!Array.isArray(list) || !list.every((a) => typeof a === 'string'))
      throw badRequest('Send the apps as a list of names.', '{ "apps": ["purchase"] }');
    return list;
  };
  router.add('GET', '/api/apps', async (ctx) => ({
    apps: await (await admin(ctx, false)).apps.list(),
  }));
  router.add('POST', '/api/apps/plan', async (ctx) => {
    const { apps } = await admin(ctx, true);
    const body = (await ctx.body()) as
      | { operation?: unknown; cascade?: unknown; purge?: unknown }
      | undefined;
    const list = names(body);
    return body?.operation === 'uninstall'
      ? apps.planUninstall(list, { cascade: body.cascade === true, purge: body.purge === true })
      : apps.planInstall(list);
  });
  router.add('POST', '/api/apps/install', async (ctx) => {
    const { apps, session } = await admin(ctx, true);
    const result = await apps.install(names(await ctx.body()), {
      actor: `user:${session.userId}`,
      company: session.company,
    });
    shutro.useRegistry(result.registry);
    metaCache.clear();
    return { plan: result.plan, warnings: result.warnings, ms: result.ms };
  });
  router.add('POST', '/api/apps/uninstall', async (ctx) => {
    const { apps, session } = await admin(ctx, true);
    const body = (await ctx.body()) as { cascade?: unknown; purge?: unknown } | undefined;
    const result = await apps.uninstall(names(body), {
      actor: `user:${session.userId}`,
      cascade: body?.cascade === true,
      purge: body?.purge === true,
    });
    shutro.useRegistry(result.registry);
    metaCache.clear();
    return { plan: result.plan, warnings: result.warnings, ms: result.ms };
  });

  /** Runs `fn` in a transaction that is always rolled back (onchange drafts). */
  const DRAFT = Symbol('draft');
  async function shutroDraft<T>(session: Session, fn: (env: DynamicEnv) => Promise<T>): Promise<T> {
    let out: T | undefined;
    try {
      await run(session, async (env) => {
        out = await fn(env);
        throw DRAFT;
      });
    } catch (error) {
      if (error !== DRAFT) throw error;
    }
    return out as T;
  }

  // ---- dispatch
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      try {
        await start();
        const route = router.match(method, url.pathname);
        if (route === undefined) {
          if (url.pathname.startsWith('/api/')) {
            throw router.knows(url.pathname)
              ? new HttpError(
                  405,
                  'METHOD_NOT_ALLOWED',
                  `${method} is not allowed here.`,
                  'Check the method.',
                )
              : new HttpError(
                  404,
                  'NOT_FOUND',
                  `${url.pathname} does not exist.`,
                  'Check the address.',
                );
          }
          if (
            (method === 'GET' || method === 'HEAD') &&
            options.staticDir !== undefined &&
            serveStatic(options.staticDir, url.pathname, res)
          )
            return;
          throw new HttpError(
            404,
            'NOT_FOUND',
            `${url.pathname} does not exist.`,
            'Check the address.',
          );
        }
        let parsed: Promise<unknown> | undefined;
        const ctx: Ctx = {
          req,
          res,
          method,
          path: url.pathname,
          query: url.searchParams,
          params: route.params,
          cookies: parseCookies(req.headers.cookie),
          ip: req.socket.remoteAddress ?? '',
          body: () => {
            parsed ??= readJson(req);
            return parsed;
          },
        };
        const result = await route.handler(ctx);
        if (result !== HANDLED) sendJson(res, 200, result);
      } catch (error) {
        const http = toHttp(error);
        if (http.status >= 500) onError(error);
        if (res.headersSent) {
          res.end();
          return;
        }
        sendJson(res, http.status, {
          code: http.code,
          message: http.message,
          hint: http.hint,
          fields: http.fields,
        });
      }
    })();
  };

  return {
    handle,
    async listen(port, host = '127.0.0.1') {
      await start();
      const server = createHttpServer(handle);
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      return {
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((resolve) => {
            for (const client of clients) client.res.end();
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      };
    },
  };
}

/** Returned by handlers that wrote the response themselves. */
const HANDLED = Symbol('handled');
