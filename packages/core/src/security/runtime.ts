/**
 * Runtime security (RFC 0014 §7.10): roles, model access, record rules and feature-permission grants stored in the
 * database and edited while the system runs. Code declarations are the reviewed baseline; the database extends it
 * (it never removes a grant the code makes). Every change is validated against the registry when saved, audited,
 * and announced with NOTIFY so every process reloads.
 */
import type { Driver } from '@shutro/driver-pg';
import {
  GROUP_CODE,
  type Perm,
  type RulePerm,
  type RuleSpec,
  resolvePlaceholders,
} from '@shutro/security';
import { compile, sql } from '@shutro/sql';
import { InvalidModuleError } from '../errors.js';
import { compileDomain } from '../recordset/domain.js';
import type { Registry } from '../registry/registry.js';

/** The NOTIFY channel runtime security changes are announced on. */
export const SECURITY_CHANNEL = 'shutro_security';

const PERMS: readonly Perm[] = ['read', 'write', 'create', 'unlink', 'export', 'import'];
const RULE_PERMS: readonly RulePerm[] = ['read', 'write', 'create', 'unlink'];

const DDL = [
  'CREATE TABLE IF NOT EXISTS "shutro_role" ("code" text PRIMARY KEY, "label" text NOT NULL, "implies" text[] NOT NULL DEFAULT \'{}\', "administrator" boolean NOT NULL DEFAULT false)',
  'CREATE TABLE IF NOT EXISTS "shutro_role_access" ("role" text NOT NULL, "model" text NOT NULL, "perms" text[] NOT NULL, PRIMARY KEY ("role", "model"))',
  'CREATE TABLE IF NOT EXISTS "shutro_role_rule" ("name" text PRIMARY KEY, "role" text NOT NULL, "model" text NOT NULL, "perms" text[] NOT NULL, "domain" jsonb NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "shutro_role_permission" ("role" text NOT NULL, "permission" text NOT NULL, PRIMARY KEY ("role", "permission"))',
];

/** A role defined at runtime. */
export interface RuntimeRole {
  readonly code: string;
  readonly label: string;
  readonly implies: readonly string[];
  readonly administrator: boolean;
}

/** A record rule defined at runtime, for one role. */
export interface RuntimeRule {
  readonly name: string;
  readonly role: string;
  readonly model: string;
  readonly perms: readonly RulePerm[];
  readonly domain: Readonly<Record<string, unknown>>;
}

/** The runtime additions, as loaded. */
export interface RuntimeSecurity {
  readonly roles: ReadonlyMap<string, RuntimeRole>;
  /** model → role → permissions. */
  readonly access: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<Perm>>>;
  /** model → rules (as rule specs for that role). */
  readonly rules: ReadonlyMap<string, Readonly<Record<string, RuleSpec>>>;
  /** feature permission → roles granted it. */
  readonly permissions: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Statements creating the runtime security tables. */
export function runtimeSecurityStatements(): readonly {
  readonly text: string;
  readonly params: readonly [];
}[] {
  return DDL.map((text) => ({ text, params: [] as [] }));
}

/** Loads the runtime additions (creating the tables on first use). */
export async function loadRuntimeSecurity(driver: Pick<Driver, 'query'>): Promise<RuntimeSecurity> {
  for (const text of DDL) await driver.query({ text, params: [] });
  const roles = await driver.query<{
    code: string;
    label: string;
    implies: string[];
    administrator: boolean;
  }>({
    text: 'SELECT code, label, implies, administrator FROM shutro_role',
    params: [],
  });
  const access = await driver.query<{ role: string; model: string; perms: string[] }>({
    text: 'SELECT role, model, perms FROM shutro_role_access',
    params: [],
  });
  const rules = await driver.query<{
    name: string;
    role: string;
    model: string;
    perms: string[];
    domain: Record<string, unknown>;
  }>({
    text: 'SELECT name, role, model, perms, domain FROM shutro_role_rule ORDER BY name',
    params: [],
  });
  const grants = await driver.query<{ role: string; permission: string }>({
    text: 'SELECT role, permission FROM shutro_role_permission',
    params: [],
  });
  const accessMap = new Map<string, Map<string, Set<Perm>>>();
  for (const a of access) {
    const byRole = accessMap.get(a.model) ?? new Map<string, Set<Perm>>();
    byRole.set(a.role, new Set(a.perms as Perm[]));
    accessMap.set(a.model, byRole);
  }
  const ruleMap = new Map<string, Record<string, RuleSpec>>();
  for (const r of rules) {
    const byName = ruleMap.get(r.model) ?? {};
    byName[`runtime:${r.name}`] = Object.freeze({
      groups: [r.role],
      perms: r.perms as RulePerm[],
      domain: r.domain,
    });
    ruleMap.set(r.model, byName);
  }
  const permissionMap = new Map<string, Set<string>>();
  for (const g of grants)
    permissionMap.set(g.permission, (permissionMap.get(g.permission) ?? new Set()).add(g.role));
  return Object.freeze({
    roles: new Map(
      roles.map((r) => [r.code, Object.freeze({ ...r, implies: Object.freeze([...r.implies]) })]),
    ),
    access: accessMap,
    rules: ruleMap,
    permissions: permissionMap,
  });
}

/** The closure of `codes` over `implies`, code groups and runtime roles together. */
export function closureWith(
  registry: Registry,
  overlay: RuntimeSecurity | undefined,
  codes: Iterable<string>,
): Set<string> {
  if (overlay === undefined || overlay.roles.size === 0) return registry.security.closure(codes);
  const out = new Set<string>();
  const stack = [...codes];
  while (stack.length > 0) {
    const code = stack.pop() as string;
    if (out.has(code)) continue;
    out.add(code);
    for (const implied of registry.security.groups.get(code)?.implies ?? []) stack.push(implied);
    for (const implied of overlay.roles.get(code)?.implies ?? []) stack.push(implied);
  }
  return out;
}

/** True when the groups include an administrator group, from code or from a runtime role. */
export function isAdministratorWith(
  registry: Registry,
  overlay: RuntimeSecurity | undefined,
  groups: ReadonlySet<string>,
): boolean {
  if (registry.security.isAdministrator(groups)) return true;
  for (const role of overlay?.roles.values() ?? [])
    if (role.administrator && groups.has(role.code)) return true;
  return false;
}

function invalid(problem: string, hint: string): never {
  throw new InvalidModuleError(problem, hint);
}

function knownRole(registry: Registry, overlay: RuntimeSecurity, role: string): void {
  if (!registry.security.groups.has(role) && !overlay.roles.has(role))
    invalid(
      `The role '${role}' does not exist.`,
      'Create it with saveRole(), or use a group a module declares.',
    );
}

/** Validates a change against the registry and the current overlay (RFC 0014 §7.10). @throws {InvalidModuleError} */
export function validateChange(
  registry: Registry,
  overlay: RuntimeSecurity,
  change: SecurityChange,
): void {
  switch (change.kind) {
    case 'role': {
      if (!GROUP_CODE.test(change.code))
        invalid(
          `'${change.code}' is not a role code.`,
          "Use 'module.name', e.g. 'sale.team_lead'.",
        );
      if (registry.security.groups.has(change.code))
        invalid(
          `'${change.code}' is declared in code.`,
          'Code groups are changed in their module; create a new role instead.',
        );
      for (const code of change.implies ?? [])
        if (code !== change.code) knownRole(registry, overlay, code);
      return;
    }
    case 'access': {
      knownRole(registry, overlay, change.role);
      if (!registry.has(change.model))
        invalid(`The model '${change.model}' is not installed.`, 'Check the model name.');
      for (const p of change.perms)
        if (!PERMS.includes(p)) invalid(`'${p}' is not a permission.`, `Use ${PERMS.join(', ')}.`);
      return;
    }
    case 'rule': {
      knownRole(registry, overlay, change.role);
      if (!registry.has(change.model))
        invalid(`The model '${change.model}' is not installed.`, 'Check the model name.');
      if (change.perms.length === 0)
        invalid(
          `Rule '${change.name}' applies to no operation.`,
          `Give perms among ${RULE_PERMS.join(', ')}.`,
        );
      for (const p of change.perms)
        if (!RULE_PERMS.includes(p))
          invalid(`'${p}' is not a rule permission.`, `Use ${RULE_PERMS.join(', ')}.`);
      // Compiled now, with placeholder values: a broken domain is refused when saved, not when users hit it.
      const resolved = resolvePlaceholders(change.domain, {
        uid: 0,
        companyId: 0,
        companyIds: [0],
      });
      compileDomain(
        registry.get(change.model).model,
        resolved as Record<string, unknown>,
        undefined,
        (n) => registry.get(n).model,
      );
      return;
    }
    case 'permission': {
      knownRole(registry, overlay, change.role);
      if (!registry.security.permissions.has(change.permission))
        invalid(
          `The permission '${change.permission}' is not declared by any module.`,
          'Grant a permission a module declares with definePermission().',
        );
      return;
    }
    default:
      return;
  }
}

/** One change to runtime security. */
export type SecurityChange =
  | {
      readonly kind: 'role';
      readonly code: string;
      readonly label?: string;
      readonly implies?: readonly string[];
      readonly administrator?: boolean;
    }
  | { readonly kind: 'deleteRole'; readonly code: string }
  | {
      readonly kind: 'access';
      readonly role: string;
      readonly model: string;
      readonly perms: readonly Perm[];
    }
  | {
      readonly kind: 'rule';
      readonly name: string;
      readonly role: string;
      readonly model: string;
      readonly perms: readonly RulePerm[];
      readonly domain: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'deleteRule'; readonly name: string }
  | { readonly kind: 'permission'; readonly role: string; readonly permission: string }
  | { readonly kind: 'revokePermission'; readonly role: string; readonly permission: string };

/** The statement that applies a validated change. */
export function changeStatement(change: SecurityChange): ReturnType<typeof compile> {
  switch (change.kind) {
    case 'role':
      return compile(
        sql`INSERT INTO shutro_role (code, label, implies, administrator) VALUES (${change.code}, ${change.label ?? change.code}, ${sql.array([...(change.implies ?? [])], 'text')}, ${change.administrator === true})
            ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, implies = EXCLUDED.implies, administrator = EXCLUDED.administrator`,
      );
    case 'deleteRole':
      return compile(
        sql`WITH a AS (DELETE FROM shutro_role_access WHERE role = ${change.code}), r AS (DELETE FROM shutro_role_rule WHERE role = ${change.code}), p AS (DELETE FROM shutro_role_permission WHERE role = ${change.code})
            DELETE FROM shutro_role WHERE code = ${change.code}`,
      );
    case 'access':
      return change.perms.length === 0
        ? compile(
            sql`DELETE FROM shutro_role_access WHERE role = ${change.role} AND model = ${change.model}`,
          )
        : compile(
            sql`INSERT INTO shutro_role_access (role, model, perms) VALUES (${change.role}, ${change.model}, ${sql.array([...change.perms], 'text')})
                ON CONFLICT (role, model) DO UPDATE SET perms = EXCLUDED.perms`,
          );
    case 'rule':
      return compile(
        sql`INSERT INTO shutro_role_rule (name, role, model, perms, domain) VALUES (${change.name}, ${change.role}, ${change.model}, ${sql.array([...change.perms], 'text')}, (${sql.param(JSON.stringify(change.domain), 'text')})::jsonb)
            ON CONFLICT (name) DO UPDATE SET role = EXCLUDED.role, model = EXCLUDED.model, perms = EXCLUDED.perms, domain = EXCLUDED.domain`,
      );
    case 'deleteRule':
      return compile(sql`DELETE FROM shutro_role_rule WHERE name = ${change.name}`);
    case 'permission':
      return compile(
        sql`INSERT INTO shutro_role_permission (role, permission) VALUES (${change.role}, ${change.permission}) ON CONFLICT DO NOTHING`,
      );
    case 'revokePermission':
      return compile(
        sql`DELETE FROM shutro_role_permission WHERE role = ${change.role} AND permission = ${change.permission}`,
      );
  }
}
