/**
 * Argument parsing and dispatch. `runCli` returns the exit code; nothing here calls `process.exit`, so tests can
 * drive it directly.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { CliError } from './errors.js';
import { generate } from './generate/generate.js';

/** Where output goes. */
export interface CliIo {
  readonly cwd: string;
  write(text: string): void;
  error(text: string): void;
}

const USAGE = `Usage: shutro <command> [options]

Commands:
  generate [--check] [--config <file>]   Write per-module and application type views (.shutro/)
  init | migrate | inspect               Not implemented yet (roadmap: CLI, query inspector, schema explorer)

Options:
  --config <file>   Config file (default: shutro.config.ts in the current directory)
  --check           Fail (exit 1) when generated files are missing or stale; write nothing
  --help            Show this help
`;

/** Runs the CLI and returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        check: { type: 'boolean', default: false },
        config: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
    const command = positionals[0];
    if (values.help || command === undefined) {
      io.write(USAGE);
      return command === undefined && !values.help ? 2 : 0;
    }
    switch (command) {
      case 'generate': {
        const { config, dir } = await loadConfig(values.config ?? `${io.cwd}/shutro.config.ts`);
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
      case 'init':
      case 'migrate':
      case 'inspect':
        io.error(`shutro ${command} is not implemented yet.\n`);
        return 2;
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
