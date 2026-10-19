/**
 * The HTTP layer: a small router over `node:http`, JSON bodies with a size limit, cookies, security headers, static
 * files for the web client, and the mapping of typed errors to statuses.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ShutroError } from '@shutro/core';
import { MigrationError } from '@shutro/migrate';
import { badRequest, HttpError } from './errors.js';

/** One request. */
export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly params: Readonly<Record<string, string>>;
  readonly cookies: Readonly<Record<string, string>>;
  readonly ip: string;
  /** The JSON body (parsed once). */
  body(): Promise<unknown>;
}

export type Handler = (ctx: Ctx) => Promise<unknown>;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly handler: Handler;
}

/** A tiny router: `:name` segments become params. */
export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    this.#routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | undefined {
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(path);
      if (m === null) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { handler: route.handler, params };
    }
    return undefined;
  }

  /** True when another method serves this path (405 instead of 404). */
  knows(path: string): boolean {
    return this.#routes.some((r) => r.pattern.test(path));
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

const MAX_BODY = 1024 * 1024;

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY)
      throw new HttpError(
        413,
        'TOO_LARGE',
        'The request body is over 1 MB.',
        'Send less data per request.',
      );
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  // JSON only: an HTML form cannot send it, which closes the classic cross-site form post.
  if (!type.toLowerCase().startsWith('application/json'))
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Requests must be JSON.',
      'Send Content-Type: application/json.',
    );
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw badRequest('The request body is not valid JSON.', 'Check the payload.');
  }
}

/** Headers on every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    ...(body === '' ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    ...headers,
  });
  res.end(body);
}

const STATUS: Readonly<Record<string, number>> = {
  VALIDATION: 422,
  CONSTRAINT: 422,
  CONSTRAINT_VIOLATION: 422,
  INVALID_DECIMAL: 422,
  CURRENCY_MISMATCH: 422,
  NON_INTEGER_NUMBER: 422,
  INVALID_CURRENCY: 422,
  ACCESS: 403,
  CROSS_COMPANY: 403,
  COMPANY_NOT_ALLOWED: 403,
  MISSING_RECORD: 404,
  UNKNOWN_MODEL: 404,
  APP_NOT_INSTALLED: 404,
  STALE_RECORD: 409,
  INVALID_TRANSITION: 409,
  TRANSITION_GUARD: 409,
  CONCURRENT_UPDATE: 409,
  INVALID_DOMAIN: 400,
  FIELD_NOT_LOADED: 400,
  APP_UNKNOWN: 404,
  APP_STATE: 409,
  APP_DEPENDENTS: 409,
  APP_BLOCKED: 409,
  MIGRATION_DESTRUCTIVE: 409,
};

/** Typed errors keep their message and hint; anything else is a 500 that reveals nothing. */
export function toHttp(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ShutroError || error instanceof MigrationError) {
    const fields = (error as { fields?: unknown }).fields;
    const field = (error as { field?: unknown }).field;
    return new HttpError(
      STATUS[error.code] ?? 400,
      error.code,
      error.message.slice(0, error.message.length - error.hint.length).trim(),
      error.hint,
      Array.isArray(fields) ? (fields as string[]) : typeof field === 'string' ? [field] : [],
    );
  }
  return new HttpError(
    500,
    'INTERNAL',
    'Something went wrong on the server.',
    'Try again; if it keeps failing, check the server log.',
  );
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** Serves the built web client; unknown paths get `index.html` (client-side routes). */
export function serveStatic(dir: string, path: string, res: ServerResponse): boolean {
  const root = resolve(dir);
  const candidate = resolve(join(root, normalize(decodeURIComponent(path))));
  if (candidate !== root && !candidate.startsWith(root + sep)) return false; // traversal
  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!existsSync(file)) return false;
  const hashed = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}
