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
} from '@shutro/security';
import { compile, type SqlFragment, sql } from '@shutro/sql';
import type { ScopeInternals } from '../env/env.js';
import { AccessError, MissingRecordError } from '../errors.js';
import type { Field } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { compileDomain } from './domain.js';
import { bindValue } from './values.js';

const HINT =
  'Ask an administrator for a group that grants it, or run the task inside env.asSuperuser({ reason }).';

/** True when the environment may perform `perm` on the model (ACL, RFC 0014 §7.2). */
export function canAccess(internals: ScopeInternals, model: AnyModel, perm: Perm): boolean {
  if (internals.env.su || !internals.registry.security.enforce) return true;
  return allowed(model.access, internals.env.groups, perm);
}

/** @throws {AccessError} unless {@link canAccess}. */
export function assertAccess(internals: ScopeInternals, model: AnyModel, perm: Perm): void {
  if (canAccess(internals, model, perm)) return;
  throw new AccessError(model.name, perm, {
    problem: `${perm} access to ${model.name} is denied.`,
    hint: HINT,
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
  if (field === undefined || internals.env.su || !internals.registry.security.enforce) return true;
  return fieldAllowed(field.groups, internals.env.groups, kind);
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
  if (env.su || !internals.registry.security.enforce) return [];
  const { globals, groupRules, hasGroupRules } = applicableRules(model.rules, env.groups, perm);
  const placeholders = { uid: env.uid, companyId: env.companyId, companyIds: env.companyIds };
  const out: SqlFragment[] = [];
  for (const rule of globals) {
    const conditions = compileDomain(
      model,
      resolvePlaceholders(rule.domain, placeholders) as Record<string, unknown>,
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
