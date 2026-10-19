/**
 * HTTP errors: the status, a machine-readable code, and the same "what went wrong, how to fix it" message as every
 * Shutro error.
 */

/** An error answered with `status` and a JSON body `{ code, message, hint, fields? }`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string;
  /** Offending field keys (validation errors), for the form to mark. */
  readonly fields: readonly string[];

  constructor(
    status: number,
    code: string,
    problem: string,
    hint: string,
    fields: readonly string[] = [],
  ) {
    super(`${problem} ${hint}`);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.fields = fields;
  }
}

export const unauthorized = (): HttpError =>
  new HttpError(401, 'UNAUTHENTICATED', 'You are not signed in.', 'Sign in again.');

export const notFound = (what: string): HttpError =>
  new HttpError(404, 'NOT_FOUND', `${what} was not found.`, 'Check the address.');

export const badRequest = (problem: string, hint: string): HttpError =>
  new HttpError(400, 'BAD_REQUEST', problem, hint);
