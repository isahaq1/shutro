import { InvalidIdentityError } from '../errors.js';
import { assertTimeZone } from './time.js';

/** Who is acting, for which company, and how (RFC 0003 §7.1). */
export interface Identity {
  /** Id of the acting `res.users` record. */
  readonly user: number;
  /** Current company: defaults, sequences, currency. Must be one of `companies`. */
  readonly company: number;
  /** Allowed (selected) companies: the record-rule scope. Defaults to `[company]`. */
  readonly companies?: readonly number[];
  /** Language code such as `'bn_BD'`. Defaults to `'en_US'`. */
  readonly lang?: string;
  /** IANA time zone. Defaults to `'UTC'`. */
  readonly tz?: string;
  /** Why this unit of work runs, for jobs and system tasks (audited). */
  readonly reason?: string;
  /** Security group codes of the user (RFC 0014 §7.1); implied groups are added by the registry. */
  readonly groups?: readonly string[];
  /**
   * Special permissions of this user on top of the roles (RFC 0014 §7.9): feature permission codes
   * (`'account.backdate'`) and model operations (`'account.move:unlink'`).
   */
  readonly grants?: readonly string[];
}

/** A validated identity with defaults applied. */
export interface ResolvedIdentity {
  readonly uid: number;
  readonly companyId: number;
  readonly companyIds: readonly number[];
  readonly lang: string;
  readonly tz: string;
  readonly reason: string | undefined;
  readonly groups: readonly string[];
  readonly grants: readonly string[];
}

/** The acting uid of `Shutro.bootstrap` scopes: no `res.users` row, so `created_by` / `updated_by` are `NULL`. */
export const SYSTEM_UID = 0;

const GRANT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+(:(read|write|create|unlink|export|import))?$/;

const LANG = /^[a-z]{2,3}_[A-Z]{2}$/;

function assertId(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidIdentityError(
      `${what} must be a positive integer id, got ${JSON.stringify(value)}.`,
      'Pass the database id of the record (a positive integer).',
    );
  }
  return value;
}

/** Validates special grants (`'account.backdate'`, `'account.move:unlink'`). @throws {InvalidIdentityError} */
export function assertGrants(grants: readonly unknown[]): readonly string[] {
  return Object.freeze(
    grants.map((g) => {
      if (typeof g !== 'string' || !GRANT.test(g))
        throw new InvalidIdentityError(
          `${JSON.stringify(g)} is not a grant.`,
          "Grant a permission code ('account.backdate') or a model operation ('account.move:unlink').",
        );
      return g;
    }),
  );
}

/** Validates a language code (`'en_US'`, `'bn_BD'`). @throws {InvalidIdentityError} */
export function assertLang(lang: string): string {
  if (!LANG.test(lang)) {
    throw new InvalidIdentityError(
      `${JSON.stringify(lang)} is not a language code.`,
      "Use the form 'll_CC', e.g. 'en_US' or 'bn_BD'.",
    );
  }
  return lang;
}

/** Validates `reason` for superuser scopes and jobs. @throws {InvalidIdentityError} */
export function assertReason(reason: string): string {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new InvalidIdentityError(
      'A reason is required.',
      "Say why elevated access or this job runs, e.g. { reason: 'payment-webhook: register payment' }; it is recorded in the audit trail.",
    );
  }
  return reason;
}

/** Applies defaults and validates. @throws {InvalidIdentityError} */
export function resolveIdentity(identity: Identity): ResolvedIdentity {
  const uid = assertId(identity.user, 'user');
  const companyId = assertId(identity.company, 'company');
  const companyIds =
    identity.companies === undefined
      ? [companyId]
      : identity.companies.map((c) => assertId(c, 'companies[]'));
  if (!companyIds.includes(companyId)) {
    throw new InvalidIdentityError(
      `The current company ${companyId} is not in the allowed companies [${companyIds.join(', ')}].`,
      'Include the current company in `companies`, or omit `companies` to allow only the current one.',
    );
  }
  const tz = identity.tz ?? 'UTC';
  assertTimeZone(tz);
  return {
    uid,
    companyId,
    companyIds: Object.freeze([...companyIds]),
    lang: assertLang(identity.lang ?? 'en_US'),
    tz,
    reason: identity.reason === undefined ? undefined : assertReason(identity.reason),
    grants: Object.freeze(
      [...(identity.grants ?? [])].map((g) => {
        if (typeof g !== 'string' || !GRANT.test(g))
          throw new InvalidIdentityError(
            `${JSON.stringify(g)} is not a grant.`,
            "Grant a permission code ('account.backdate') or a model operation ('account.move:unlink').",
          );
        return g;
      }),
    ),
    groups: Object.freeze(
      [...(identity.groups ?? [])].map((g) => {
        if (typeof g !== 'string' || g === '')
          throw new InvalidIdentityError(
            `${JSON.stringify(g)} is not a group code.`,
            "Pass group codes such as 'sale.user'.",
          );
        return g;
      }),
    ),
  };
}
