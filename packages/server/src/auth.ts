/**
 * Sign-in (RFC 0020 §7.7): scrypt password hashes, account lockout, and opaque sessions stored hashed.
 *
 * Credentials and memberships (roles, companies) live in `kosh_user`, outside the business models, so no model read,
 * API call or export can ever return a password hash. Sessions live in `kosh_session`; the cookie carries a random
 * 256-bit token and the database only its SHA-256.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { DriverQuery, Row } from '@shutro/driver-pg';
import { compile, sql } from '@shutro/sql';
import { HttpError } from './errors.js';

interface Queryable {
  query<R extends Row = Row>(query: DriverQuery): Promise<readonly R[]>;
}

// ------------------------------------------------------------------------------------------------ passwords

const SCRYPT = { log2N: 15, r: 8, p: 1, keylen: 32 } as const;

function scrypt(
  password: string,
  salt: Buffer,
  log2N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password.normalize('NFKC'),
      salt,
      SCRYPT.keylen,
      { N: 2 ** log2N, r, p, maxmem: 256 * 2 ** log2N * r },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });
}

/** Minimum password length. */
export const MIN_PASSWORD = 10;

/** `scrypt$15$8$1$<salt>$<hash>` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD)
    throw new HttpError(
      422,
      'WEAK_PASSWORD',
      `Passwords need at least ${MIN_PASSWORD} characters.`,
      'Use a longer passphrase.',
      ['password'],
    );
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.log2N, SCRYPT.r, SCRYPT.p);
  return [
    'scrypt',
    SCRYPT.log2N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** Constant-time check of `password` against a stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(
    password,
    Buffer.from(salt, 'base64url'),
    Number(n),
    Number(r),
    Number(p),
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash nobody's password matches: unknown logins cost the same time as wrong passwords. */
const DECOY = `scrypt$${SCRYPT.log2N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;

// ------------------------------------------------------------------------------------------------ storage

const DDL = [
  sql`CREATE TABLE IF NOT EXISTS "kosh_user" (
    "user_id" bigint PRIMARY KEY,
    "password_hash" text,
    "groups" text[] NOT NULL DEFAULT '{}',
    "grants" text[] NOT NULL DEFAULT '{}',
    "companies" bigint[] NOT NULL DEFAULT '{}',
    "company" bigint,
    "lang" text NOT NULL DEFAULT 'en_US',
    "tz" text NOT NULL DEFAULT 'UTC',
    "active" boolean NOT NULL DEFAULT true,
    "failed_logins" integer NOT NULL DEFAULT 0,
    "locked_until" timestamp with time zone,
    "updated_at" timestamp with time zone NOT NULL DEFAULT now())`,
  sql`CREATE TABLE IF NOT EXISTS "kosh_session" (
    "token_hash" text PRIMARY KEY,
    "user_id" bigint NOT NULL REFERENCES "kosh_user" ("user_id") ON DELETE CASCADE,
    "csrf" text NOT NULL,
    "company" bigint,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
    "expires_at" timestamp with time zone NOT NULL,
    "ip" text,
    "user_agent" text)`,
  sql`CREATE INDEX IF NOT EXISTS "kosh_session_user_idx" ON "kosh_session" ("user_id")`,
];

/** Creates the sign-in tables (idempotent). */
export async function ensureAuthTables(db: Queryable): Promise<void> {
  for (const statement of DDL) await db.query(compile(statement));
}

/** Who a user is allowed to be: what `shutro.run()` receives for them. */
export interface Membership {
  readonly groups: readonly string[];
  readonly grants: readonly string[];
  /** Allowed companies; the first is the default when `company` is not set. */
  readonly companies: readonly number[];
  readonly company?: number | null;
  readonly lang?: string;
  readonly tz?: string;
  readonly active?: boolean;
}

/** Sets a user's password (and creates their sign-in row when missing). */
export async function setPassword(db: Queryable, userId: number, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await ensureAuthTables(db);
  await db.query(
    compile(
      sql`INSERT INTO "kosh_user" (user_id, password_hash) VALUES (${userId}, ${hash})
          ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_logins = 0, locked_until = NULL, updated_at = now()`,
    ),
  );
  // A new password ends every other session of the user.
  await db.query(compile(sql`DELETE FROM "kosh_session" WHERE user_id = ${userId}`));
}

/** Sets a user's roles, companies, language and time zone. */
export async function setMembership(db: Queryable, userId: number, m: Membership): Promise<void> {
  await ensureAuthTables(db);
  await db.query(
    compile(
      sql`INSERT INTO "kosh_user" (user_id, groups, grants, companies, company, lang, tz, active)
          VALUES (${userId}, ${sql.array(m.groups, 'text')}, ${sql.array(m.grants, 'text')}, ${sql.array(m.companies, 'bigint')}, ${m.company ?? null}, ${m.lang ?? 'en_US'}, ${m.tz ?? 'UTC'}, ${m.active ?? true})
          ON CONFLICT (user_id) DO UPDATE SET groups = EXCLUDED.groups, grants = EXCLUDED.grants, companies = EXCLUDED.companies,
            company = EXCLUDED.company, lang = EXCLUDED.lang, tz = EXCLUDED.tz, active = EXCLUDED.active, updated_at = now()`,
    ),
  );
}

// ------------------------------------------------------------------------------------------------ sign-in

/** Lockout policy: after `maxFailures` wrong passwords, the account waits `lockMinutes`. */
export const LOCKOUT = { maxFailures: 5, lockMinutes: 15 } as const;

/** Failed sign-ins per IP per minute, across accounts (password spraying). Successful ones never count. */
const IP_LIMIT = 20;
const ipFailures = new Map<string, { count: number; reset: number }>();

function throttleIp(ip: string): void {
  const entry = ipFailures.get(ip);
  if (entry !== undefined && entry.reset > Date.now() && entry.count >= IP_LIMIT)
    throw new HttpError(
      429,
      'TOO_MANY_ATTEMPTS',
      'Too many failed sign-ins from this address.',
      'Wait a minute and try again.',
    );
}

function failedFrom(ip: string): void {
  const now = Date.now();
  const entry = ipFailures.get(ip);
  if (entry === undefined || entry.reset < now) {
    if (ipFailures.size > 10_000) ipFailures.clear(); // bounded memory
    ipFailures.set(ip, { count: 1, reset: now + 60_000 });
  } else entry.count++;
}

const invalid = (ip: string): HttpError => {
  failedFrom(ip);
  return new HttpError(
    401,
    'INVALID_CREDENTIALS',
    'The login or password is wrong.',
    'Check both and try again.',
  );
};

/** A signed-in session. */
export interface Session {
  readonly userId: number;
  readonly csrf: string;
  readonly company: number;
  readonly companies: readonly number[];
  readonly groups: readonly string[];
  readonly grants: readonly string[];
  readonly lang: string;
  readonly tz: string;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Session lifetime; activity extends it. */
export const SESSION_DAYS = 14;

/**
 * Checks a login and password and opens a session. Unknown logins, wrong passwords and locked accounts take the same
 * time and give the same answer, except a lockout, which says when to retry.
 *
 * @returns the cookie token (shown once) and the session.
 */
export async function signIn(
  db: Queryable,
  options: {
    readonly usersTable: string;
    readonly login: string;
    readonly password: string;
    readonly ip: string;
    readonly userAgent: string;
  },
): Promise<{ token: string; session: Session }> {
  throttleIp(options.ip);
  const [row] = await db.query<{
    user_id: string | number;
    password_hash: string | null;
    failed_logins: number;
    locked_until: Date | null;
    active: boolean;
  }>(
    compile(
      sql`SELECT k.user_id, k.password_hash, k.failed_logins, k.locked_until, k.active
          FROM ${sql.id(options.usersTable)} u JOIN "kosh_user" k ON k.user_id = u.id
          WHERE u.login = ${options.login}`,
    ),
  );
  const ok = await verifyPassword(options.password, row?.password_hash ?? DECOY);
  if (row === undefined || row.password_hash === null || !row.active) throw invalid(options.ip);
  const userId = Number(row.user_id);
  if (row.locked_until !== null && row.locked_until.getTime() > Date.now())
    throw new HttpError(
      423,
      'ACCOUNT_LOCKED',
      'This account is locked after too many wrong passwords.',
      `Try again after ${row.locked_until.toISOString().slice(11, 16)} UTC, or ask an administrator to reset the password.`,
    );
  if (!ok) {
    await db.query(
      compile(
        sql`UPDATE "kosh_user" SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= ${LOCKOUT.maxFailures} THEN now() + make_interval(mins => ${LOCKOUT.lockMinutes}) ELSE locked_until END
            WHERE user_id = ${userId}`,
      ),
    );
    throw invalid(options.ip);
  }
  await db.query(
    compile(
      sql`UPDATE "kosh_user" SET failed_logins = 0, locked_until = NULL WHERE user_id = ${userId}`,
    ),
  );
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  await db.query(
    compile(
      sql`INSERT INTO "kosh_session" (token_hash, user_id, csrf, expires_at, ip, user_agent)
          VALUES (${sha256(token)}, ${userId}, ${csrf}, now() + make_interval(days => ${SESSION_DAYS}), ${options.ip}, ${options.userAgent.slice(0, 300)})`,
    ),
  );
  const session = await resolveSession(db, token);
  if (session === undefined) {
    await signOut(db, token);
    throw new HttpError(
      403,
      'NO_COMPANY',
      'This user has no company to work in.',
      'An administrator must give the user at least one company (shutro users).',
    );
  }
  return { token, session };
}

/** The session of a cookie token, or `undefined` when unknown, expired, or the user is disabled. */
export async function resolveSession(db: Queryable, token: string): Promise<Session | undefined> {
  if (token === '' || token.length > 128) return undefined;
  const [row] = await db.query<{
    user_id: string | number;
    csrf: string;
    company: string | number | null;
    companies: readonly (string | number)[];
    groups: readonly string[];
    grants: readonly string[];
    lang: string;
    tz: string;
    stale: boolean;
  }>(
    compile(
      sql`SELECT s.user_id, s.csrf, coalesce(s.company, k.company) AS company, k.companies, k.groups, k.grants, k.lang, k.tz,
                 s.last_seen_at < now() - interval '5 minutes' AS stale
          FROM "kosh_session" s JOIN "kosh_user" k ON k.user_id = s.user_id
          WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now() AND k.active`,
    ),
  );
  if (row === undefined) return undefined;
  const companies = row.companies.map(Number);
  const preferred = row.company === null ? undefined : Number(row.company);
  const company =
    preferred !== undefined && companies.includes(preferred) ? preferred : companies[0];
  if (company === undefined) return undefined;
  if (row.stale)
    await db.query(
      compile(
        sql`UPDATE "kosh_session" SET last_seen_at = now(), expires_at = now() + make_interval(days => ${SESSION_DAYS}) WHERE token_hash = ${sha256(token)}`,
      ),
    );
  return {
    userId: Number(row.user_id),
    csrf: row.csrf,
    company,
    companies,
    groups: row.groups,
    grants: row.grants,
    lang: row.lang,
    tz: row.tz,
  };
}

/** Ends a session. */
export async function signOut(db: Queryable, token: string): Promise<void> {
  await db.query(compile(sql`DELETE FROM "kosh_session" WHERE token_hash = ${sha256(token)}`));
}

/** Switches the session's current company (it must be one of the user's). */
export async function switchCompany(
  db: Queryable,
  token: string,
  session: Session,
  company: number,
): Promise<void> {
  if (!session.companies.includes(company))
    throw new HttpError(
      403,
      'COMPANY_NOT_ALLOWED',
      `Company ${company} is not one of yours.`,
      'Pick one of your companies.',
    );
  await db.query(
    compile(
      sql`UPDATE "kosh_session" SET company = ${company} WHERE token_hash = ${sha256(token)}`,
    ),
  );
}
