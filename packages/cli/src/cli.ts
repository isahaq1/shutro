/**
 * Argument parsing and dispatch. `runCli` returns the exit code; nothing here calls `process.exit`, so tests can
 * drive it directly.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutro, historyStatements, loadData } from '@shutro/core';
import {
  applyMigrations,
  migrationStatus,
  planMigration,
  writeMigrationFile,
} from '@shutro/migrate';
import { appsCommand } from './apps.js';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { generate } from './generate/generate.js';
import { initProject } from './init.js';
import { inspectModel, inspectRegistry } from './inspect.js';
import {
  appManaged,
  appsOf,
  databaseUrl,
  loadProject,
  runningRegistry,
  withDriver,
} from './project.js';
import { serve, users } from './serve.js';
import { doctor, guidedInit } from './setup.js';
import { createUi, type Key, outputMode, type Ui } from './ui.js';

/** Where output goes, and the environment variables to read. */
export interface CliIo {
  readonly cwd: string;
  write(text: string): void;
  error(text: string): void;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** True when stdout is an interactive terminal: glyphs, colors and live progress. */
  readonly isTTY?: boolean;
  /** Asks a question on an interactive terminal (without it, defaults and --yes apply). */
  readonly prompt?: (question: string) => Promise<string>;
  /** The next key press in raw mode, for arrow-key pickers (without it, pickers fall back to prompts). */
  readonly readKey?: () => Promise<Key>;
  /** Reads a line without echo (passwords); without it, passwords come from the environment. */
  readonly secret?: (question: string) => Promise<string>;
  /** Stops `shutro serve` when it resolves (tests); otherwise Ctrl+C does. */
  readonly until?: Promise<void>;
}

const USAGE = `Usage: shutro <command> [options]

Getting started:
  init [dir]                             Guided setup: project files, database, the default apps, company, admin
                                         (--minimal: config, a base module and migrations only, no apps)
  doctor                                 Check Node, the config, type views, PostgreSQL, migrations and apps
  serve [--port 8069]                    Run the web app and its API (sign in at http://127.0.0.1:8069)
  users [add|passwd|set] <login>         Who can sign in: passwords, roles and companies

Apps:
  apps [list] [--all]                    The app catalog and what is installed (--all: technical and glue too)
  apps info <app>                        Summary, dependencies, dependents, models
  apps install <app...>                  Plan, confirm, install atomically (dependencies and glue included)
  apps uninstall <app...>                Preview the data affected, then move it to quarantine (or --purge)
  apps upgrade [app...]                  Apply new module versions: schema, data-migration hooks, data
  apps purge [--now <app...>]            Drop quarantined data past its retention period (or now)

Development:
  generate [--check]                     Write per-module and application type views (.shutro/)
  migrate status                         Applied and pending migration files
  migrate plan                           What the database is missing (DDL, destructive statements marked)
  migrate write <name>                   Write the plan as the next migration file
  migrate apply [--allow-destructive]    Apply pending files, data-migration hooks, then module data
  inspect [model]                        Modules and models, or one model: fields, origins, methods, computes,
                                         constraints, access and rules

Options:
  --config <file>        Config file (default: shutro.config.ts in the current directory)
  --yes, -y              Answer yes to confirmations (required to remove data without a terminal)
  --json                 One JSON object per line (events and results) instead of text
  --check                generate: fail (exit 1) when generated files are stale; write nothing
  --allow-destructive    migrate apply, apps upgrade: run statements that drop data
  --cascade              apps uninstall: also uninstall the apps that depend on these
  --purge                apps uninstall: drop the data instead of keeping it in quarantine
  --now                  apps purge: purge the named apps now
  --database <url>       init: PostgreSQL URL (the database is created when missing)
  --company <name>       init: company name
  --currency <code>      init: company currency (USD, EUR, GBP, BDT, INR, JPY)
  --admin <login>        init: administrator login
  --apps <a,b,...>       init: apps to install (default: settings,account,sale,purchase,project)
  --no-install           init: write the project files only
  --port <n>             serve: port (default 8069)
  --host <addr>          serve: address (default 127.0.0.1; Secure cookies off loopback)
  --roles <a,b>          users add | set: roles (e.g. sale.user,account.user)
  --companies <1,2>      users add | set: allowed company ids (default: all)
  --name <text>          users add: display name
  --help                 Show this help

Environment:
  SHUTRO_DATABASE_URL    PostgreSQL URL (overrides database in the config)
  NO_COLOR               Plain output: no colors, no glyphs
`;

/** Runs the CLI and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  let ui: Ui = createUi(io, 'plain');
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        check: { type: 'boolean', default: false },
        config: { type: 'string' },
        help: { type: 'boolean', default: false },
        'allow-destructive': { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        json: { type: 'boolean', default: false },
        all: { type: 'boolean', default: false },
        cascade: { type: 'boolean', default: false },
        purge: { type: 'boolean', default: false },
        now: { type: 'boolean', default: false },
        minimal: { type: 'boolean', default: false },
        'no-install': { type: 'boolean', default: false },
        database: { type: 'string' },
        company: { type: 'string' },
        currency: { type: 'string' },
        admin: { type: 'string' },
        apps: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'insecure-cookies': { type: 'boolean', default: false },
        roles: { type: 'string' },
        companies: { type: 'string' },
        name: { type: 'string' },
      },
    });
    ui = createUi(io, outputMode(io, env, values.json));
    const [command, sub, arg] = positionals;
    if (values.help || command === undefined) {
      io.write(USAGE);
      return command === undefined && !values.help ? 2 : 0;
    }
    const configFile = values.config ?? `${io.cwd}/shutro.config.ts`;
    switch (command) {
      case 'init': {
        if (values.minimal) {
          for (const file of initProject(resolve(io.cwd, sub ?? '.')))
            io.write(`created   ${file}\n`);
          io.write(
            'Next: list your modules in shutro.config.ts, then run "shutro migrate plan".\n',
          );
          return 0;
        }
        return await guidedInit(
          sub,
          {
            yes: values.yes,
            noInstall: values['no-install'],
            company: values.company,
            currency: values.currency,
            admin: values.admin,
            apps: values.apps,
            database: values.database,
            adminPassword: env['SHUTRO_ADMIN_PASSWORD'],
          },
          ui,
          io.cwd,
          env,
        );
      }
      case 'serve':
        return await serve(
          configFile,
          {
            port: Number(values.port ?? 8069),
            host: values.host ?? '127.0.0.1',
            insecureCookies: values['insecure-cookies'],
          },
          ui,
          env,
          io.until,
        );
      case 'users':
        return await users(
          configFile,
          sub,
          arg,
          { roles: values.roles, companies: values.companies, name: values.name },
          ui,
          env,
        );
      case 'doctor':
        return await doctor(configFile, ui, env);
      case 'apps': {
        const project = await loadProject(configFile);
        if (!appManaged(project))
          throw new CliError(
            'This project does not manage apps: shutro.config.ts has no install list.',
            "Add install: ['settings', ...] to the config; without it every listed module is always part of the application.",
          );
        const flags = {
          yes: values.yes,
          all: values.all,
          cascade: values.cascade,
          purge: values.purge,
          allowDestructive: values['allow-destructive'],
          now: values.now,
        };
        return await withDriver(databaseUrl(project.config, env), (driver) =>
          appsCommand(sub, positionals.slice(2), flags, appsOf(project, driver), ui),
        );
      }
      case 'generate': {
        const { config, dir } = await loadConfig(configFile);
        const result = await generate({ config, cwd: dir, check: values.check });
        for (const file of result.files) io.write(`${file.status.padEnd(9)} ${file.path}\n`);
        if (values.check && result.changed.length > 0) {
          io.error(
            `${result.changed.length} generated file(s) are stale. Run "shutro generate".\n`,
          );
          return 1;
        }
        return 0;
      }
      case 'migrate':
        return await migrate(sub, arg, configFile, values['allow-destructive'], io, env);
      case 'inspect': {
        const { registry } = await loadProject(configFile);
        io.write(
          `${sub === undefined ? inspectRegistry(registry) : inspectModel(registry, sub)}\n`,
        );
        return 0;
      }
      default:
        throw new CliError(`Unknown command '${command}'.`, 'Run "shutro --help".');
    }
  } catch (error) {
    ui.settle();
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof CliError ? 2 : 1;
    if (ui.mode === 'json') io.write(`${JSON.stringify({ type: 'error', message })}\n`);
    io.error(
      ui.mode === 'fancy'
        ? `\n  ${ui.style('red', `${ui.symbols.fail} ${message}`)}\n`
        : `error: ${message}\n`,
    );
    return code;
  }
}

async function migrate(
  sub: string | undefined,
  name: string | undefined,
  configFile: string,
  allowDestructive: boolean,
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const project = await loadProject(configFile);
  const { config } = project;
  const dir = config.migrations ?? resolve('migrations');
  const url = databaseUrl(config, env);
  return withDriver(url, async (driver) => {
    // App-managed projects migrate the installed modules only (RFC 0019 §7.3).
    const registry = await runningRegistry(project, driver);
    switch (sub) {
      case 'status': {
        const status = await migrationStatus({ driver, dir });
        for (const a of status.applied)
          io.write(`applied   ${a.version}_${a.name}  ${a.appliedAt.toISOString()}\n`);
        for (const p of status.pending) io.write(`pending   ${p.version}_${p.name}\n`);
        if (status.applied.length + status.pending.length === 0) io.write('No migrations yet.\n');
        return 0;
      }
      case 'plan': {
        const plan = await planMigration({ driver, registry });
        if (plan.statements.length === 0) {
          io.write('The database matches the models.\n');
          return 0;
        }
        for (const s of plan.statements)
          io.write(`${s.destructive ? '-- destructive\n' : ''}${s.sql};\n`);
        io.write(
          `\n${plan.statements.length} statement(s), ${plan.destructive.length} destructive. Run "shutro migrate write <name>".\n`,
        );
        return 0;
      }
      case 'write': {
        if (name === undefined)
          throw new CliError(
            'migrate write needs a name.',
            'E.g. shutro migrate write add_sale_margin.',
          );
        const plan = await planMigration({ driver, registry });
        if (plan.statements.length === 0) {
          io.write('Nothing to write: the database matches the models.\n');
          return 0;
        }
        const file = await writeMigrationFile({ dir, name, plan });
        io.write(
          `created   ${file.path}${plan.destructive.length > 0 ? `  (${plan.destructive.length} destructive statement(s): review before applying)` : ''}\n`,
        );
        return 0;
      }
      case 'apply': {
        const result = await applyMigrations({ driver, dir, registry, allowDestructive });
        for (const a of result.applied) io.write(`applied   ${a.version}_${a.name}\n`);
        for (const m of result.modules)
          io.write(`module    ${m.module} ${m.from ?? '(new)'} → ${m.to}\n`);
        for (const h of result.hooks) io.write(`hook      ${h.module} ${h.version}\n`);
        // History triggers (RFC 0018 §7.4): idempotent, after the schema they version.
        for (const statement of historyStatements(registry)) await driver.query(statement);
        // Module data (RFC 0017), after the schema: idempotent, so it runs at every apply.
        const data = await loadData(createShutro({ driver, registry }));
        let dataChanges = 0;
        for (const d of data) {
          const changes = d.created.length + d.updated.length + d.deleted.length;
          dataChanges += changes;
          if (changes > 0)
            io.write(
              `data      ${d.module}: ${d.created.length} created, ${d.updated.length} updated, ${d.deleted.length} deleted, ${d.unchanged} unchanged\n`,
            );
          for (const r of d.retained)
            io.write(`kept      ${r.id} (still referenced: ${r.reason})\n`);
        }
        if (result.applied.length + result.modules.length + dataChanges === 0)
          io.write('Up to date.\n');
        return 0;
      }
      default:
        throw new CliError(
          `Unknown migrate command '${sub ?? ''}'.`,
          'Use status, plan, write <name> or apply.',
        );
    }
  });
}
