/**
 * Argument parsing and dispatch. `runCli` returns the exit code; nothing here calls `process.exit`, so tests can
 * drive it directly.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  applyMigrations,
  migrationStatus,
  planMigration,
  writeMigrationFile,
} from '@shutro/migrate';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { generate } from './generate/generate.js';
import { initProject } from './init.js';
import { inspectModel, inspectRegistry } from './inspect.js';
import { databaseUrl, loadProject, withDriver } from './project.js';

/** Where output goes, and the environment variables to read. */
export interface CliIo {
  readonly cwd: string;
  write(text: string): void;
  error(text: string): void;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const USAGE = `Usage: shutro <command> [options]

Commands:
  init [dir]                             Create shutro.config.ts, a base module and a migrations directory
  generate [--check]                     Write per-module and application type views (.shutro/)
  migrate status                         Applied and pending migration files
  migrate plan                           What the database is missing (DDL, destructive statements marked)
  migrate write <name>                   Write the plan as the next migration file
  migrate apply [--allow-destructive]    Apply pending files, then module data-migration hooks
  inspect [model]                        Modules and models, or one model: fields, origins, methods, computes,
                                         constraints, access and rules

Options:
  --config <file>        Config file (default: shutro.config.ts in the current directory)
  --check                generate: fail (exit 1) when generated files are stale; write nothing
  --allow-destructive    migrate apply: run statements that drop data
  --help                 Show this help

Environment:
  SHUTRO_DATABASE_URL    PostgreSQL URL for migrate (overrides database in the config)
`;

/** Runs the CLI and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const env = io.env ?? process.env;
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        check: { type: 'boolean', default: false },
        config: { type: 'string' },
        help: { type: 'boolean', default: false },
        'allow-destructive': { type: 'boolean', default: false },
      },
    });
    const [command, sub, arg] = positionals;
    if (values.help || command === undefined) {
      io.write(USAGE);
      return command === undefined && !values.help ? 2 : 0;
    }
    const configFile = values.config ?? `${io.cwd}/shutro.config.ts`;
    switch (command) {
      case 'init': {
        for (const file of initProject(resolve(io.cwd, sub ?? '.')))
          io.write(`created   ${file}\n`);
        io.write('Next: list your modules in shutro.config.ts, then run "shutro migrate plan".\n');
        return 0;
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
    if (error instanceof CliError) {
      io.error(`error: ${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.error(`error: ${message}\n`);
    return 1;
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
  const { config, registry } = await loadProject(configFile);
  const dir = config.migrations ?? resolve('migrations');
  const url = databaseUrl(config, env);
  return withDriver(url, async (driver) => {
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
        if (result.applied.length + result.modules.length === 0) io.write('Up to date.\n');
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
