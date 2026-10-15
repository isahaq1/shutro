/** Machine-readable reason for a {@link CliError}. */
export type CliErrorCode = 'CLI_USAGE' | 'CLI_CONFIG' | 'CLI_MODULE_SOURCE';

/** A CLI error: the message says what went wrong and ends with `hint`. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly hint: string;
  constructor(problem: string, hint: string, code: CliErrorCode = 'CLI_USAGE') {
    super(`${problem} ${hint}`);
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
  }
}

/** `shutro.config.ts` is missing, malformed, or names a file that doesn't export a module. */
export class ConfigError extends CliError {
  constructor(problem: string, hint: string) {
    super(problem, hint, 'CLI_CONFIG');
  }
}

/** A module in the dependency graph has no source file the generator can import types from. */
export class ModuleSourceError extends CliError {
  constructor(module: string, via: string) {
    super(
      `Module '${module}' (a dependency of '${via}') is not listed in the config.`,
      "Add its file to `modules` in shutro.config.ts: generated views import each module's types from its source.",
      'CLI_MODULE_SOURCE',
    );
  }
}
