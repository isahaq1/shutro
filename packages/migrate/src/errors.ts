/** Machine-readable reason for a {@link MigrationError}. */
export type MigrationErrorCode =
  | 'MIGRATION'
  | 'MIGRATION_DESTRUCTIVE'
  | 'MIGRATION_CHECKSUM'
  | 'MIGRATION_FILE'
  | 'APP_UNKNOWN'
  | 'APP_STATE'
  | 'APP_DEPENDENTS'
  | 'APP_BLOCKED';

/** Base class of `@shutro/migrate` errors: the message says what went wrong and ends with `hint`. */
export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly hint: string;
  constructor(problem: string, hint: string, code: MigrationErrorCode = 'MIGRATION') {
    super(`${problem} ${hint}`);
    this.name = new.target.name;
    this.code = code;
    this.hint = hint;
  }
}

/** A migration file contains destructive statements and `allowDestructive` is not set. */
export class DestructiveMigrationError extends MigrationError {
  readonly statements: readonly string[];
  constructor(file: string, statements: readonly string[]) {
    super(
      `Migration ${file} contains ${statements.length} destructive statement(s): ${statements.join('; ')}.`,
      'Review the data loss, then apply with { allowDestructive: true }, or edit the migration file.',
      'MIGRATION_DESTRUCTIVE',
    );
    this.statements = statements;
  }
}

/** An applied migration file was edited afterwards. */
export class MigrationChecksumError extends MigrationError {
  constructor(file: string) {
    super(
      `Migration ${file} was changed after it was applied.`,
      'Applied migrations are immutable: restore the file, or write a new migration for the change.',
      'MIGRATION_CHECKSUM',
    );
  }
}

/** A migration file name or content that can't be used. */
export class MigrationFileError extends MigrationError {
  constructor(problem: string, hint: string) {
    super(problem, hint, 'MIGRATION_FILE');
  }
}

/** A module name the application does not ship (RFC 0019). */
export class UnknownAppError extends MigrationError {
  constructor(name: string, available: readonly string[]) {
    super(
      `No module named '${name}' is available.`,
      `Check the spelling, or add the module to shutro.config.ts modules. Available: ${available.join(', ')}.`,
      'APP_UNKNOWN',
    );
  }
}

/** An install, uninstall or upgrade that the modules' state does not allow (RFC 0019 §7.5, §7.6). */
export class AppStateError extends MigrationError {
  constructor(problem: string, hint: string) {
    super(problem, hint, 'APP_STATE');
  }
}

/** Uninstalling modules that installed applications still depend on, without `cascade` (RFC 0019 R4). */
export class AppDependentsError extends MigrationError {
  /** The installed modules that depend on the ones being removed. */
  readonly dependents: readonly string[];
  constructor(modules: readonly string[], dependents: readonly string[]) {
    super(
      `${dependents.join(', ')} depend(s) on ${modules.join(', ')}.`,
      'Uninstall them too: list them, or pass { cascade: true } (shutro apps uninstall --cascade).',
      'APP_DEPENDENTS',
    );
    this.dependents = dependents;
  }
}

/** A module's uninstall blockers refused the uninstall (RFC 0019 §7.6). */
export class UninstallBlockedError extends MigrationError {
  /** Module → reasons. */
  readonly reasons: Readonly<Record<string, readonly string[]>>;
  constructor(reasons: Readonly<Record<string, readonly string[]>>) {
    const text = Object.entries(reasons)
      .map(([module, list]) => `${module}: ${list.join('; ')}`)
      .join(' | ');
    super(
      `The uninstall was refused (${text}).`,
      'Resolve the reasons first (e.g. archive or cancel the documents); nothing was changed.',
      'APP_BLOCKED',
    );
    this.reasons = reasons;
  }
}
