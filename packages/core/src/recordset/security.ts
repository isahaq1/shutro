/**
 * Access control at runtime (RFC 0014): model ACL checks, field-level groups, record rules compiled into WHERE
 * fragments, per-record checks for writes and deletes, and encryption of stored values. Superuser scopes bypass
 * the checks; multi-company consistency does not live here (RFC 0003 §7.4).
 */

import {
  allowed,
  applicableRules,
  decrypt,
  EncryptionError,
  encrypt,
  fieldAllowed,
  type Perm,
  type RulePerm,
  resolvePlaceholders,
  SecurityDefinitionError,
} from '@shutro/security';
import { compile, type SqlFragment, sql } from '@shutro/sql';
import type { ScopeInternals } from '../env/env.js';
import { calendarDateIn } from '../env/time.js';
import { AccessError, MissingRecordError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { compileDomain } from './domain.js';
import { bindValue } from './values.js';

const HINT =
  'Ask an administrator for a group that grants it, or run the task inside env.asSuperuser({ reason }).';

/** True when the environment may perform `perm` on the model (ACL, RFC 0014 §7.2). */
export function canAccess(internals: ScopeInternals, model: AnyModel, perm: Perm): boolean {
  if (internals.env.su || internals.env.administrator || !internals.registry.security.enforce)
    return true;
  if (allowed(model.access, internals.env.groups, perm)) return true;
  if (internals.env.grants.has(`${model.name}:${perm}`)) return true; // a special permission of this user
  for (const [role, perms] of internals.overlay?.access.get(model.name) ?? [])
    if (perms.has(perm) && internals.env.groups.has(role)) return true; // a runtime grant (RFC 0014 §7.10)
  if (internals.registry.security.mode !== 'warn') return false;
  internals.registry.security.denied(
    `[enforce: 'warn'] ${perm} access to ${model.name} would be denied for groups ${[...internals.env.groups].join(', ') || '(none)'}: add it to the model's access.`,
  );
  return true;
}

/** @throws {AccessError} unless {@link canAccess}. */
export function assertAccess(internals: ScopeInternals, model: AnyModel, perm: Perm): void {
  if (canAccess(internals, model, perm)) return;
  throw new AccessError(model.name, perm, {
    problem: `${perm} access to ${model.name} is denied.`,
    hint: HINT,
  });
}

/**
 * True when the environment has the feature permission `code` (RFC 0014 §7.9): one of its groups grants it, or it
 * is an administrator / superuser. @throws {SecurityDefinitionError} for a code no module declares (a typo).
 */
export function hasPermission(internals: ScopeInternals, code: string): boolean {
  const permission = internals.registry.security.permissions.get(code);
  if (permission === undefined)
    throw new SecurityDefinitionError(
      `The permission '${code}' is not declared by any installed module.`,
      'Declare it with definePermission() in a module, or fix the code.',
    );
  const { env } = internals;
  if (env.su || env.administrator || !internals.registry.security.enforce) return true;
  if (permission.groups.some((g) => env.groups.has(g)) || env.grants.has(code)) return true;
  for (const role of internals.overlay?.permissions.get(code) ?? [])
    if (env.groups.has(role)) return true;
  if (internals.registry.security.mode !== 'warn') return false;
  internals.registry.security.denied(
    `[enforce: 'warn'] permission '${code}' would be denied for groups ${[...env.groups].join(', ') || '(none)'}.`,
  );
  return true;
}

/** @throws {AccessError} unless {@link hasPermission}. */
export function assertPermission(internals: ScopeInternals, code: string): void {
  if (hasPermission(internals, code)) return;
  const groups = internals.registry.security.permissions.get(code)?.groups ?? [];
  throw new AccessError('permission', code, {
    problem: `the permission '${code}' is denied (granted to ${groups.join(', ') || 'no group'}).`,
    hint: HINT,
  });
}

/** `date` shifted by `days` (`'YYYY-MM-DD'`). */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/**
 * Back-dated entries (RFC 0014 §7.9): `dates` (values of the model's `backdate.field`) before today minus the grace
 * days need the model's back-date permission. @throws {AccessError}
 */
export function assertBackdate(
  internals: ScopeInternals,
  model: AnyModel,
  dates: Iterable<unknown>,
): void {
  const spec = model.backdate;
  if (spec === undefined) return;
  const { env } = internals;
  const earliest = addDays(env.today(), -(spec.graceDays ?? 0));
  const early = [...dates]
    .map((v) =>
      v instanceof Date ? calendarDateIn(v, env.tz) : typeof v === 'string' ? v.slice(0, 10) : null,
    )
    .filter((d): d is string => d !== null && d < earliest)
    .sort();
  if (early.length === 0 || hasPermission(internals, spec.permission)) return;
  throw new AccessError(model.name, 'backdate', {
    field: spec.field,
    problem: `${model.name} entries dated before ${earliest} (here ${early[0]}) need the permission '${spec.permission}'.`,
    hint: 'Use a current date, or ask an administrator for the back-date permission (a role or a special grant).',
  });
}

/** True when the field may be read / written by the environment. */
export function canField(
  internals: ScopeInternals,
  model: AnyModel,
  key: string,
  kind: 'read' | 'write',
): boolean {
  const field = model.fields[key];
  if (
    field === undefined ||
    internals.env.su ||
    internals.env.administrator ||
    !internals.registry.security.enforce
  )
    return true;
  if (fieldAllowed(field.groups, internals.env.groups, kind)) return true;
  if (internals.registry.security.mode !== 'warn') return false;
  internals.registry.security.denied(
    `[enforce: 'warn'] ${kind} of ${model.name}.${key} would be denied for groups ${[...internals.env.groups].join(', ') || '(none)'}.`,
  );
  return true;
}

/** @throws {AccessError} naming the first field the environment may not read / write. */
export function assertFields(
  internals: ScopeInternals,
  model: AnyModel,
  keys: Iterable<string>,
  kind: 'read' | 'write',
): void {
  for (const key of keys) {
    if (canField(internals, model, key, kind)) continue;
    throw new AccessError(model.name, kind, {
      field: key,
      problem: `field '${key}' of ${model.name} is restricted to groups ${(kind === 'read' ? model.fields[key]?.groups.read : model.fields[key]?.groups.write)?.join(', ') ?? ''}.`,
      hint: HINT,
    });
  }
}

/** The keys of `keys` the environment may read (restricted fields are left out of default projections). */
export function readableKeys(
  internals: ScopeInternals,
  model: AnyModel,
  keys: Iterable<string>,
): string[] {
  return [...keys].filter((k) => canField(internals, model, k, 'read'));
}

/**
 * Checks that every field a domain mentions is readable, following relation paths and `any` / `none` into the
 * related models: a filter on a hidden field would leak it through which records match (RFC 0014 §7.4).
 */
export function assertDomainFields(
  internals: ScopeInternals,
  model: AnyModel,
  domain: unknown,
): void {
  if (Array.isArray(domain)) {
    for (const d of domain) assertDomainFields(internals, model, d);
    return;
  }
  if (typeof domain !== 'object' || domain === null) return;
  for (const [key, value] of Object.entries(domain)) {
    if (key === 'or' || key === 'and' || key === 'not') {
      assertDomainFields(internals, model, value);
      continue;
    }
    const [head = '', ...rest] = key.split('.');
    assertFields(internals, model, [head], 'read');
    const field = model.fields[head];
    const target = (field as { target?: string } | undefined)?.target;
    if (target === undefined) continue;
    const targetModel = internals.registry.get(target).model;
    assertAccess(internals, targetModel, 'read');
    if (rest.length > 0) assertDomainFields(internals, targetModel, { [rest.join('.')]: value });
    else if (typeof value === 'object' && value !== null) {
      const v = value as { any?: unknown; none?: unknown };
      if (v.any !== undefined) assertDomainFields(internals, targetModel, v.any);
      if (v.none !== undefined) assertDomainFields(internals, targetModel, v.none);
    }
  }
}

/** The field keys a domain mentions (through `or` / `and` / `not`). */
export function domainKeys(domain: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(domain)) {
    for (const d of domain) domainKeys(d, out);
    return out;
  }
  if (typeof domain !== 'object' || domain === null) return out;
  for (const [key, value] of Object.entries(domain)) {
    if (key === 'or' || key === 'and' || key === 'not') domainKeys(value, out);
    else out.add(key);
  }
  return out;
}

/** Record-rule conditions for `perm` (RFC 0014 §7.3): globals ANDed, applicable group rules ORed. Empty under `su`. */
export function ruleConditions(
  internals: ScopeInternals,
  model: AnyModel,
  perm: RulePerm,
): SqlFragment[] {
  const { env } = internals;
  if (env.su || env.administrator || !internals.registry.security.enforce) return [];
  const { globals, groupRules, hasGroupRules } = applicableRules(
    { ...model.rules, ...(internals.overlay?.rules.get(model.name) ?? {}) },
    env.groups,
    perm,
  );
  const placeholders = { uid: env.uid, companyId: env.companyId, companyIds: env.companyIds };
  const out: SqlFragment[] = [];
  for (const rule of globals) {
    const conditions = compileDomain(
      model,
      resolvePlaceholders(rule.domain, placeholders) as Record<string, unknown>,
      undefined,
      (n) => internals.registry.get(n).model,
    );
    if (conditions.length > 0) out.push(sql`(${sql.join(conditions, sql` AND `)})`);
  }
  if (hasGroupRules) {
    if (groupRules.length === 0) return out; // no group rule names the user's groups: unrestricted by group rules (Odoo semantics)
    const alternatives: SqlFragment[] = [];
    for (const rule of groupRules) {
      const conditions = compileDomain(
        model,
        resolvePlaceholders(rule.domain, placeholders) as Record<string, unknown>,
        undefined,
        (n) => internals.registry.get(n).model,
      );
      if (conditions.length === 0) return out; // an unconditional group rule grants everything the globals allow
      alternatives.push(sql`(${sql.join(conditions, sql` AND `)})`);
    }
    out.push(sql`(${sql.join(alternatives, sql` OR `)})`);
  }
  return out;
}

/** True when `perm` has rules for the model that apply to this environment. */
export function hasRules(internals: ScopeInternals, model: AnyModel, perm: RulePerm): boolean {
  return ruleConditions(internals, model, perm).length > 0;
}

/**
 * Checks that every id passes the rules for `perm` (RFC 0014 §7.3). Ids that exist but are out of scope are an
 * {@link AccessError}; ids that do not exist are a {@link MissingRecordError}.
 */
export async function assertRecords(
  internals: ScopeInternals,
  model: AnyModel,
  ids: readonly number[],
  perm: RulePerm,
): Promise<void> {
  const real = ids.filter((id) => id > 0);
  if (real.length === 0) return;
  const conditions = ruleConditions(internals, model, perm);
  if (conditions.length === 0) return;
  const rows = await internals.query<{ id: number }>(
    compile(
      sql`SELECT ${sql.id('id')} FROM ${sql.id(model.table)} WHERE ${sql.id('id')} = ANY(${sql.array(real, 'bigint')}) AND ${sql.join(conditions, sql` AND `)}`,
    ),
  );
  const passed = new Set(rows.map((r) => Number(r.id)));
  const denied = real.filter((id) => !passed.has(id));
  if (denied.length === 0) return;
  await explainDenied(internals, model, denied, perm);
}

/** Distinguishes missing records from records out of the rules' scope, and throws accordingly. */
export async function explainDenied(
  internals: ScopeInternals,
  model: AnyModel,
  denied: readonly number[],
  perm: RulePerm,
): Promise<never> {
  const existing = await internals.query<{ id: number }>(
    compile(
      sql`SELECT ${sql.id('id')} FROM ${sql.id(model.table)} WHERE ${sql.id('id')} = ANY(${sql.array([...denied], 'bigint')})`,
    ),
  );
  const found = new Set(existing.map((r) => Number(r.id)));
  const missing = denied.filter((id) => !found.has(id));
  if (missing.length > 0 && found.size === 0) throw new MissingRecordError(model.name, missing);
  throw new AccessError(model.name, perm, {
    records: denied.filter((id) => found.has(id)),
    problem: `record rules deny ${perm} on ${model.name} record(s) ${denied.filter((id) => found.has(id)).join(', ')}.`,
    hint: 'The records exist but are outside the rules that apply to this user (RFC 0014 §7.3).',
  });
}

/** The value bound for a stored column: encrypted fields are encrypted with the current key (RFC 0014 §7.6). */
export function storedValue(internals: ScopeInternals, field: Field, value: unknown): unknown {
  if (!field.encrypted || value === null || value === undefined) return bindValue(field, value);
  const ring = internals.keys;
  if (ring === undefined) {
    throw new EncryptionError(
      'No encryption keys are configured.',
      'Pass keys: createKeyRing({ current, keys }) to createShutro() before writing encrypted fields.',
    );
  }
  return encrypt(ring, String(value));
}

/** The plaintext of a loaded encrypted value. */
export function loadedValue(internals: ScopeInternals, field: Field, value: unknown): unknown {
  if (!field.encrypted || value === null || value === undefined) return value;
  const ring = internals.keys;
  if (ring === undefined) {
    throw new EncryptionError(
      'No encryption keys are configured.',
      'Pass keys: createKeyRing({ current, keys }) to createShutro() to read encrypted fields.',
    );
  }
  return decrypt(ring, String(value));
}
