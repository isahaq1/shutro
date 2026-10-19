/**
 * `shutro init` (the guided installer, RFC 0019 §7.7) and `shutro doctor`.
 *
 * init: checks the environment, asks the few questions it must (every one has a flag), writes the project files,
 * creates the database when it is missing, installs the chosen apps atomically with live progress, and creates the
 * company and the administrator. Running it again in the same directory resumes: existing files are kept.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { type base, DEFAULT_APPS, officialApps } from '@shutro/apps';
import { createShutro, type ModuleBase, type Registry, type SchemaOfModule } from '@shutro/core';
import { createDriver, type Driver, DriverError } from '@shutro/driver-pg';
import { createAppManager, desiredSchema, migrationStatus, planMigration } from '@shutro/migrate';
import { compile, sql } from '@shutro/sql';
import { progressReporter } from './apps.js';
import { CliError } from './errors.js';
import { generate } from './generate/generate.js';
import { APPS_PACKAGE, CLI_PACKAGE, CORE_PACKAGE } from './packages.js';
import { appManaged, appsOf, databaseUrl, loadProject, withDriver } from './project.js';
import { count, duration, type Ui } from './ui.js';

/** Flags of `shutro init`. */
export interface InitFlags {
  readonly yes: boolean;
  /** Write the project files only; install later with "shutro init" again. */
  readonly noInstall: boolean;
  readonly company?: string | undefined;
  readonly currency?: string | undefined;
  readonly admin?: string | undefined;
  /** Comma-separated app names. */
  readonly apps?: string | undefined;
  readonly database?: string | undefined;
}

/** The URL without its password, for display and for the config file. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '';
    return parsed.toString().replace(/:@/, '@');
  } catch {
    return url;
  }
}

function where(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return redact(url);
  }
}

const titleize = (s: string): string =>
  s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();

const snake = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1') || 'shutro';

function nodeMajor(): number {
  return Number(process.versions.node.split('.')[0]);
}

/** Currencies the base module ships, by code. */
function shippedCurrencies(): string[] {
  const base = officialApps.find((m) => m.name === 'base');
  return (base?.data ?? [])
    .filter((r) => r.model === 'res.currency')
    .map((r) => String((r.values as { name?: unknown }).name));
}

async function serverVersion(driver: Driver): Promise<string> {
  const [row] = await driver.query<{ v: string }>(
    compile(sql`SELECT current_setting('server_version') AS v`),
  );
  return row?.v ?? '?';
}

/** Connects, creating the database when the server says it does not exist. */
async function connect(
  url: string,
  ui: Ui,
): Promise<{ driver: Driver; created: boolean; version: string }> {
  const driver = createDriver({ url, max: 3 });
  try {
    return { driver, created: false, version: await serverVersion(driver) };
  } catch (error) {
    await driver.end();
    if (!(error instanceof DriverError) || error.sqlState !== '3D000') {
      throw new CliError(
        `Cannot reach PostgreSQL at ${where(url)}: ${error instanceof Error ? error.message : String(error)}`,
        'Start PostgreSQL, check the URL (--database or SHUTRO_DATABASE_URL), or run "shutro init --no-install" to write the files only.',
      );
    }
  }
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw new CliError(
      `The database '${name}' does not exist and its name cannot be created safely.`,
      'Create it yourself (createdb), or use a lower-case snake_case name in the URL.',
    );
  ui.live(`    ${ui.style('dim', `creating database ${name}…`)}`);
  parsed.pathname = '/postgres';
  const admin = createDriver({ url: parsed.toString(), max: 1 });
  try {
    await admin.query(compile(sql`CREATE DATABASE ${sql.id(name)}`));
  } finally {
    await admin.end();
  }
  const driver2 = createDriver({ url, max: 3 });
  return { driver: driver2, created: true, version: await serverVersion(driver2) };
}

/** The package names behind the specifiers the project files import (`shutro` alone in the npm build). */
function dependencies(): string[] {
  const root = (spec: string): string =>
    spec
      .split('/')
      .slice(0, spec.startsWith('@') ? 2 : 1)
      .join('/');
  return [...new Set([CORE_PACKAGE, CLI_PACKAGE, APPS_PACKAGE].map(root))].sort();
}

function packageSource(name: string): string {
  return `${JSON.stringify(
    {
      name: snake(name).replaceAll('_', '-'),
      private: true,
      type: 'module',
      scripts: { shutro: 'shutro' },
      dependencies: Object.fromEntries(dependencies().map((d) => [d, 'latest'])),
    },
    null,
    2,
  )}\n`;
}

function configSource(apps: readonly string[], url: string | undefined): string {
  return `import { defineConfig } from '${CLI_PACKAGE}';

export default defineConfig({
  // The official apps, then your own modules: './modules/<name>/module.ts'.
  modules: ['${APPS_PACKAGE}'],
  // Installed on a fresh database. Change the installed apps with "shutro apps install | uninstall".
  install: [${apps.map((a) => `'${a}'`).join(', ')}],
  app: './app',
  migrations: './migrations',${url === undefined ? '' : `\n  // SHUTRO_DATABASE_URL overrides this (keep passwords out of the file).\n  database: '${redact(url)}',`}
});
`;
}

/** The guided installer. Returns the exit code. */
export async function guidedInit(
  dirArg: string | undefined,
  flags: InitFlags,
  ui: Ui,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const started = Date.now();
  const dir = resolve(cwd, dirArg ?? '.');
  const name = basename(dir);
  ui.line(
    `\n${ui.style('bold', `${ui.symbols.step} Shutro`)} ${ui.style('dim', '· the ORM for business software')}\n`,
  );

  // 1. Environment
  if (nodeMajor() < 24)
    throw new CliError(
      `Node.js ${process.versions.node} is too old.`,
      'Shutro needs Node.js 24 or newer.',
    );
  ui.ok(`Node.js ${process.versions.node}`);

  // 2. Questions (each has a flag; without a terminal the defaults apply)
  const configFile = join(dir, 'shutro.config.ts');
  const existing = existsSync(configFile);
  const applications = officialApps.filter((m) => m.application);
  let url = flags.database ?? env['SHUTRO_DATABASE_URL'];
  if (url === undefined && !flags.noInstall)
    url = await ui.ask('PostgreSQL URL', `postgres://postgres@localhost:5432/${snake(name)}`);
  const company = flags.company ?? (await ui.ask('Company name', titleize(name)));
  const currencies = shippedCurrencies();
  const currency = (
    flags.currency ?? (await ui.ask(`Currency (${currencies.join(', ')})`, 'USD'))
  ).toUpperCase();
  if (!currencies.includes(currency))
    throw new CliError(
      `Currency '${currency}' is not one of ${currencies.join(', ')}.`,
      'Pick one of them; add others in Settings later.',
    );
  const admin = flags.admin ?? (await ui.ask('Administrator login', 'admin'));
  let selected = (flags.apps?.split(',') ?? []).map((a) => a.trim()).filter((a) => a !== '');
  if (selected.length === 0) {
    if (ui.mode === 'fancy' && !flags.yes) {
      ui.line(`  ${ui.style('cyan', ui.symbols.ask)} Apps`);
      ui.table(
        applications.map((m) => [
          `${ui.style('green', ui.symbols.on)} ${ui.glyph(m.glyph)}${ui.style('bold', m.label)}`,
          ui.style('dim', m.name),
          ui.style('dim', m.required ? 'required' : m.summary),
        ]),
        6,
      );
    }
    const answer = await ui.ask('Apps to install (comma-separated)', DEFAULT_APPS.join(','));
    selected = answer
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '');
  }
  const unknown = selected.filter((a) => !applications.some((m) => m.name === a));
  if (unknown.length > 0)
    throw new CliError(
      `Unknown app(s): ${unknown.join(', ')}.`,
      `Apps: ${applications.map((m) => m.name).join(', ')}.`,
    );
  for (const m of applications)
    if (m.required && !selected.includes(m.name)) selected.unshift(m.name);

  // 3. Project files (kept when they exist: running init again resumes)
  ui.heading('Project');
  const needsInstall = !existsSync(join(dir, 'node_modules'));
  const files: Record<string, string> = {
    'package.json': packageSource(name),
    'shutro.config.ts': configSource(selected, url),
    'modules/README.md':
      '# Your modules\n\nOne directory per module (`modules/<name>/module.ts`, one `defineModule` export), listed in shutro.config.ts.\nExtend the official apps with `extendModel`; run `shutro generate` for typed bindings.\n',
    'migrations/.gitkeep': '',
    '.gitignore': '.shutro/\nnode_modules/\n',
  };
  for (const [file, content] of Object.entries(files)) {
    const path = join(dir, file);
    if (existsSync(path)) {
      ui.info(`${ui.style('dim', 'kept')}     ${file}`);
      continue;
    }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    ui.ok(`${ui.style('dim', 'created')}  ${file}`);
  }
  if (existing)
    ui.info('shutro.config.ts already existed: its modules and apps are used as they are.');

  if (flags.noInstall || url === undefined) {
    ui.line();
    ui.ok(ui.style('bold', 'Project files written.'));
    ui.heading('Next');
    ui.table([
      ...(relative(cwd, dir) === '' ? [] : [[`cd ${relative(cwd, dir)}`, '']]),
      ...(needsInstall
        ? [['npm install', ui.style('dim', 'the Shutro packages the project imports')]]
        : []),
      [
        'shutro init --database postgres://…',
        ui.style('dim', 'create the database and install the apps'),
      ],
    ]);
    return 0;
  }

  // 4. Database
  ui.heading('Database');
  const { driver, created, version } = await connect(url, ui);
  try {
    ui.ok(
      `PostgreSQL ${version} at ${where(url)}${created ? ui.style('green', ' (database created)') : ''}`,
    );
    if (Number(version.split('.')[0]) < 16)
      ui.warn(`PostgreSQL ${version} is old: Shutro is built and tested on PostgreSQL 18.`);

    // 5. Apps, atomically
    const catalog: readonly ModuleBase[] = officialApps;
    const apps = createAppManager({ driver, modules: catalog });
    const info = new Map((await apps.list()).map((a) => [a.name, a]));
    const plan = await apps.planInstall(selected);
    if (plan.modules.length > 0) {
      ui.heading(
        `Install plan ${ui.style('dim', `· ${plan.modules.length} modules, ${plan.statements.length} statements`)}`,
      );
      ui.table(
        plan.modules.map((m, i) => [
          `${ui.style('dim', i === plan.modules.length - 1 ? ui.symbols.last : ui.symbols.branch)} ${ui.glyph(m.glyph)}${m.application ? ui.style('bold', m.label) : m.name}`,
          ui.style('dim', m.version),
          ui.style(
            'dim',
            m.reason === 'auto'
              ? `connects ${info.get(m.name)?.depends.join(' + ') ?? ''}`
              : m.reason === 'requested' || m.reason === 'required'
                ? (info.get(m.name)?.summary ?? '')
                : 'shared by the apps',
          ),
        ]),
      );
      if (!flags.yes && (await ui.confirm('Install?', true)) === false) {
        ui.info('Cancelled: the database was not changed. Run "shutro init" again to continue.');
        return 1;
      }
      ui.heading('Installing');
      const result = await apps.install(selected, {
        actor: 'cli',
        onEvent: progressReporter(ui, info),
      });
      ui.ok(
        ui.style(
          'bold',
          `${result.plan.modules.length} modules installed in ${duration(result.ms)}`,
        ),
      );
    } else ui.ok('The apps are already installed.');

    // 6. Company and administrator
    const registry = await apps.registry();
    // Every installed set contains base (it is required), so its view types the bootstrap.
    const shutro = createShutro({
      driver,
      registry: registry as Registry<SchemaOfModule<typeof base>>,
    });
    const made = await shutro.bootstrap({ reason: 'init' }, async (env) => {
      const out = { company: false, admin: false };
      if ((await env.model('res.company').search({ limit: 1 })).length === 0) {
        const currencyId = await env.refId(
          'res.currency',
          `base.currency_${currency.toLowerCase()}`,
        );
        await env.model('res.company').create([{ name: company, currency: currencyId }]);
        out.company = true;
      }
      if (
        (await env.model('res.users').search({ where: { login: admin }, limit: 1 })).length === 0
      ) {
        await env.model('res.users').create([{ login: admin, name: 'Administrator' }]);
        out.admin = true;
      }
      return out;
    });
    ui.heading('Company');
    if (made.company) ui.ok(`${company} ${ui.style('dim', `· ${currency}`)}`);
    else ui.info('A company already exists: kept.');
    if (made.admin) ui.ok(`Administrator ${ui.style('bold', admin)}`);
    else ui.info(`User ${admin} already exists: kept.`);

    // 7. Summary
    const installed = (await apps.list()).filter((a) => a.state === 'installed');
    ui.line();
    ui.ok(
      ui.style(
        'bold',
        `Ready in ${duration(Date.now() - started)}. ${installed.filter((a) => a.application).length} apps, ${count(installed.length)} modules.`,
      ),
    );
    ui.heading('Next');
    ui.table([
      ...(relative(cwd, dir) === '' ? [] : [[`cd ${relative(cwd, dir)}`, '']]),
      ...(needsInstall
        ? [['npm install', ui.style('dim', 'the Shutro packages the project imports')]]
        : []),
      ...(new URL(url).password !== ''
        ? [
            [
              `export SHUTRO_DATABASE_URL=…`,
              ui.style('dim', 'the URL with its password (kept out of the config)'),
            ],
          ]
        : []),
      ['shutro apps list', ui.style('dim', "see what's installed")],
      ['shutro apps install <app>', ui.style('dim', 'add more apps')],
      ['shutro doctor', ui.style('dim', 'check the setup')],
    ]);
    return 0;
  } finally {
    await driver.end();
  }
}

/** `shutro doctor`: every check with ✔ / ⚠ / ✖ and the fix. Exit 1 when a check fails. */
export async function doctor(
  configFile: string,
  ui: Ui,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  let failures = 0;
  let warnings = 0;
  const fail = (problem: string, fix: string): void => {
    failures++;
    ui.fail(`${problem} ${ui.style('dim', `${ui.symbols.arrow} ${fix}`)}`);
  };
  const warn = (problem: string, fix: string): void => {
    warnings++;
    ui.warn(`${problem} ${ui.style('dim', `${ui.symbols.arrow} ${fix}`)}`);
  };
  ui.heading('Shutro doctor');

  if (nodeMajor() >= 24) ui.ok(`Node.js ${process.versions.node}`);
  else fail(`Node.js ${process.versions.node}`, 'install Node.js 24 or newer');

  let project: Awaited<ReturnType<typeof loadProject>>;
  try {
    project = await loadProject(configFile);
    ui.ok(
      `Config ${ui.style('dim', configFile)} · ${project.registry.modules.length} modules build together`,
    );
  } catch (error) {
    fail(
      error instanceof Error ? error.message : String(error),
      'fix shutro.config.ts, or run "shutro init"',
    );
    return summary();
  }

  try {
    const generated = await generate({ config: project.config, cwd: project.dir, check: true });
    if (generated.changed.length === 0) ui.ok('Generated type views are current');
    else warn(`${generated.changed.length} generated file(s) are stale`, 'run "shutro generate"');
  } catch (error) {
    warn(
      `Type views could not be checked: ${error instanceof Error ? error.message : String(error)}`,
      'run "shutro generate"',
    );
  }

  let url: string;
  try {
    url = databaseUrl(project.config, env);
  } catch {
    fail('No database is configured', 'set SHUTRO_DATABASE_URL or database in shutro.config.ts');
    return summary();
  }
  try {
    await withDriver(url, async (driver) => {
      const version = await serverVersion(driver);
      ui.ok(`PostgreSQL ${version} at ${where(url)}`);
      if (Number(version.split('.')[0]) < 16)
        warn(`PostgreSQL ${version} is old`, 'upgrade to PostgreSQL 18');
      for (const extension of desiredSchema(project.registry).extensions) {
        const [row] = await driver.query<{ available: boolean }>(
          compile(
            sql`SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = ${extension}) AS available`,
          ),
        );
        if (row?.available === true) ui.ok(`Extension ${extension} is available`);
        else
          fail(
            `Extension ${extension} is not available`,
            `install the PostgreSQL contrib package (${extension})`,
          );
      }
      const status = await migrationStatus({
        driver,
        dir: project.config.migrations ?? 'migrations',
      });
      if (status.pending.length === 0)
        ui.ok(`Migrations: ${status.applied.length} applied, none pending`);
      else warn(`${status.pending.length} migration file(s) pending`, 'run "shutro migrate apply"');

      if (appManaged(project)) {
        const list = await appsOf(project, driver).list();
        const installed = list.filter((a) => a.state === 'installed');
        if (installed.length === 0)
          warn(
            'No apps are installed',
            `run "shutro apps install ${(project.config.install ?? []).join(' ')}"`,
          );
        else
          ui.ok(
            `${installed.filter((a) => a.application).length} apps installed ${ui.style(
              'dim',
              `(${installed
                .filter((a) => a.application)
                .map((a) => a.name)
                .join(', ')})`,
            )}`,
          );
        for (const a of list.filter((x) => x.upgradable))
          warn(
            `${a.name} ${a.installedVersion} → ${a.version} is not upgraded`,
            'run "shutro apps upgrade"',
          );
        for (const a of list.filter((x) => x.state === 'quarantined'))
          ui.info(
            `${a.name} is uninstalled; its data is kept until ${a.purgeAfter?.toISOString().slice(0, 10) ?? '?'} ${ui.style('dim', `(shutro apps install ${a.name} restores it)`)}`,
          );
      } else {
        const plan = await planMigration({ driver, registry: project.registry });
        if (plan.operations.length === 0) ui.ok('The database matches the models');
        else
          warn(
            `The database differs from the models (${plan.operations.length} change(s))`,
            'run "shutro migrate plan"',
          );
      }
    });
  } catch (error) {
    fail(
      `Cannot use the database at ${where(url)}: ${error instanceof Error ? error.message : String(error)}`,
      'start PostgreSQL and check the URL',
    );
  }
  return summary();

  function summary(): number {
    ui.line();
    if (failures > 0) ui.fail(ui.style('bold', `${failures} problem(s), ${warnings} warning(s).`));
    else if (warnings > 0) ui.ok(ui.style('bold', `No problems, ${warnings} warning(s).`));
    else ui.ok(ui.style('bold', 'Everything looks good.'));
    return failures > 0 ? 1 : 0;
  }
}
