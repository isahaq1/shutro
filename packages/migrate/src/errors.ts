/** Machine-readable reason for a {@link MigrationError}. */
export type MigrationErrorCode =
  | 'MIGRATION'
  | 'MIGRATION_DESTRUCTIVE'
  | 'MIGRATION_CHECKSUM'
  | 'MIGRATION_FILE';

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
