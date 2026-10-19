/**
 * `shutro serve` (the web client and its API, RFC 0020) and `shutro users` (sign-in, roles and companies).
 */
import { dirname } from 'node:path';
import type { base } from '@shutro/apps';
import { createShutro, type Registry, type SchemaOfModule, toDecimal } from '@shutro/core';
import { createDriver } from '@shutro/driver-pg';
import { createServer, MIN_PASSWORD, setMembership, setPassword } from '@shutro/server';
import { compile, sql } from '@shutro/sql';
import { CliError } from './errors.js';
import { appManaged, appsOf, databaseUrl, loadProject, withDriver } from './project.js';
import { resolvePackageEntry } from './resolve.js';
import type { Ui } from './ui.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** The built web client shipped with the CLI, if any. */
function webDist(fromDir: string): string | undefined {
  try {
    return dirname(resolvePackageEntry('@shutro/web/dist', fromDir));
  } catch {
    return undefined;
  }
}

/** Options of {@link serve}. */
export interface ServeFlags {
  readonly port: number;
  readonly host: string;
  /** Allow non-Secure cookies off loopback (behind a TLS proxy that strips HTTPS, never on the open internet). */
  readonly insecureCookies: boolean;
}

/** Runs the server until `until` resolves (tests) or the process is interrupted. */
export async function serve(
  configFile: string,
  flags: ServeFlags,
  ui: Ui,
  env: Readonly<Record<string, string | undefined>>,
  until?: Promise<void>,
): Promise<number> {
  const project = await loadProject(configFile);
  if (!appManaged(project))
    throw new CliError(
      'shutro serve needs an app-managed project (install in shutro.config.ts).',
      'Run "shutro init" to create one.',
    );
  const url = databaseUrl(project.config, env);
  const starting = ui.task('Starting the server…');
  const driver = createDriver({ url, max: 10, parseNumeric: toDecimal });
  try {
    const apps = appsOf(project, driver);
    const registry = await apps.registry();
    if (registry.loadOrder.length === 0)
      throw new CliError(
        'No apps are installed in this database.',
        'Run "shutro init" (or "shutro apps install settings").',
      );
    const shutro = createShutro({ driver, registry, catalog: project.modules });
    const staticDir = webDist(project.dir);
    const server = createServer({
      shutro,
      driver,
      apps,
      ...(staticDir === undefined ? {} : { staticDir }),
      secureCookies: !(LOOPBACK.has(flags.host) || flags.insecureCookies),
    });
    const listening = await server.listen(flags.port, flags.host);
    const address = `http://${flags.host.includes(':') ? `[${flags.host}]` : flags.host}:${listening.port}`;
    starting.done(`Listening on ${address}`);
    ui.json({ type: 'listening', url: address, port: listening.port });
    ui.line();
    ui.box(
      [
        ui.style('bold', address),
        staticDir === undefined
          ? ui.style('yellow', 'API only: the web client is not installed (@shutro/web).')
          : 'Sign in with a user who has a password (shutro users).',
        ui.style('dim', 'Press Ctrl+C to stop.'),
      ],
      { title: `${ui.mode === 'fancy' ? '🌐' : ui.symbols.ok} Shutro is running`, color: 'green' },
    );
    await (until ??
      new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      }));
    const stopping = ui.task('Stopping…');
    await listening.close();
    stopping.done('Stopped.');
    return 0;
  } catch (error) {
    starting.fail('The server did not start');
    throw error;
  } finally {
    await driver.end();
  }
}

/** Flags of `shutro users`. */
export interface UsersFlags {
  readonly roles?: string | undefined;
  readonly companies?: string | undefined;
  readonly name?: string | undefined;
}

const list = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

/** `shutro users [list] | add <login> | passwd <login> | set <login>`. */
export async function users(
  configFile: string,
  sub: string | undefined,
  login: string | undefined,
  flags: UsersFlags,
  ui: Ui,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const project = await loadProject(configFile);
  return withDriver(databaseUrl(project.config, env), async (driver) => {
    const registry = await appsOf(project, driver).registry();
    const usersTable = registry.get('res.users').model.table;
    const companiesTable = registry.get('res.company').model.table;
    const allCompanies = async (): Promise<number[]> =>
      (
        await driver.query<{ id: string | number }>(
          compile(sql`SELECT id FROM ${sql.id(companiesTable)} ORDER BY id`),
        )
      ).map((r) => Number(r.id));
    const userId = async (name: string): Promise<number> => {
      const [row] = await driver.query<{ id: string | number }>(
        compile(sql`SELECT id FROM ${sql.id(usersTable)} WHERE login = ${name}`),
      );
      if (row === undefined)
        throw new CliError(
          `No user has the login '${name}'.`,
          'Run "shutro users" to list them, or add one with "shutro users add <login>".',
        );
      return Number(row.id);
    };
    const askPassword = async (who: string): Promise<string> => {
      const fromEnv = env['SHUTRO_PASSWORD'];
      if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
      for (;;) {
        const first = await ui.secret(`New password for ${who} (${MIN_PASSWORD}+ characters)`);
        if (first === undefined)
          throw new CliError(
            'A password is needed, but there is no terminal to ask.',
            'Set SHUTRO_PASSWORD for this command.',
          );
        if (first.length < MIN_PASSWORD) {
          ui.warn(`At least ${MIN_PASSWORD} characters, please.`);
          continue;
        }
        if ((await ui.secret('Again, to confirm')) === first) return first;
        ui.warn('The two passwords differ. Try again.');
      }
    };
    const roles = (r: Registry): string[] => {
      const wanted = list(flags.roles);
      const unknown = wanted.filter((g) => !r.security.groups.has(g));
      if (unknown.length > 0)
        throw new CliError(
          `Unknown role(s): ${unknown.join(', ')}.`,
          `Roles: ${[...r.security.groups.keys()].sort().join(', ')}.`,
        );
      return wanted;
    };

    switch (sub) {
      case undefined:
      case 'list': {
        const rows = await driver
          .query<{
            login: string;
            name: string;
            groups: string[] | null;
            companies: (string | number)[] | null;
            has_password: boolean | null;
            active: boolean | null;
          }>(
            compile(
              sql`SELECT u.login, u.name, k.groups, k.companies, k.password_hash IS NOT NULL AS has_password, k.active
                FROM ${sql.id(usersTable)} u LEFT JOIN "kosh_user" k ON k.user_id = u.id ORDER BY u.login`,
            ),
          )
          .catch(async (error: unknown) => {
            // Before the first sign-in setup there is no kosh_user table yet.
            if (String(error).includes('kosh_user'))
              return (
                await driver.query<{ login: string; name: string }>(
                  compile(sql`SELECT login, name FROM ${sql.id(usersTable)} ORDER BY login`),
                )
              ).map((r) => ({
                ...r,
                groups: null,
                companies: null,
                has_password: null,
                active: null,
              }));
            throw error;
          });
        if (ui.mode === 'json') {
          ui.json(rows);
          return 0;
        }
        ui.heading('Users', '👤');
        ui.table([
          [
            ui.style('dim', 'login'),
            ui.style('dim', 'name'),
            ui.style('dim', 'roles'),
            ui.style('dim', 'companies'),
            ui.style('dim', 'sign-in'),
          ],
          ...rows.map((r) => [
            ui.style('bold', r.login),
            r.name,
            (r.groups ?? []).join(', ') || ui.style('dim', '—'),
            (r.companies ?? []).join(', ') || ui.style('dim', '—'),
            r.has_password === true
              ? r.active === false
                ? ui.style('yellow', 'disabled')
                : ui.style('green', 'ready')
              : ui.style('dim', 'no password'),
          ]),
        ]);
        return 0;
      }
      case 'add': {
        if (login === undefined)
          throw new CliError(
            'users add needs a login.',
            'E.g. shutro users add alice --name "Alice" --roles sale.user',
          );
        // Through the ORM, so the new user is validated and audited like any record.
        const shutro = createShutro({
          driver,
          registry: registry as Registry<SchemaOfModule<typeof base>>,
        });
        const id = await shutro.bootstrap({ reason: 'shutro users add' }, async (e) => {
          const [created] = await e
            .model('res.users')
            .create([{ login, name: flags.name ?? login }]);
          return Number(created?.id);
        });
        await setMembership(driver, id, {
          groups: flags.roles === undefined ? ['base.user'] : roles(registry),
          grants: [],
          companies:
            flags.companies === undefined
              ? await allCompanies()
              : list(flags.companies).map(Number),
        });
        await setPassword(driver, id, await askPassword(login));
        ui.ok(`${ui.style('bold', login)} can sign in.`);
        return 0;
      }
      case 'passwd': {
        if (login === undefined)
          throw new CliError('users passwd needs a login.', 'E.g. shutro users passwd admin');
        const id = await userId(login);
        await setPassword(driver, id, await askPassword(login));
        ui.ok(
          `Password of ${ui.style('bold', login)} changed; their other sessions are signed out.`,
        );
        return 0;
      }
      case 'set': {
        if (login === undefined)
          throw new CliError(
            'users set needs a login.',
            'E.g. shutro users set alice --roles sale.manager',
          );
        const id = await userId(login);
        const [current] = await driver
          .query<{ groups: string[]; companies: (string | number)[] }>(
            compile(sql`SELECT groups, companies FROM "kosh_user" WHERE user_id = ${id}`),
          )
          .catch(() => []);
        await setMembership(driver, id, {
          groups: flags.roles === undefined ? (current?.groups ?? ['base.user']) : roles(registry),
          grants: [],
          companies:
            flags.companies === undefined
              ? (current?.companies.map(Number) ?? (await allCompanies()))
              : list(flags.companies).map(Number),
        });
        ui.ok(`${ui.style('bold', login)} updated.`);
        return 0;
      }
      default:
        throw new CliError(`Unknown users command '${sub}'.`, 'Use list, add, passwd or set.');
    }
  });
}
