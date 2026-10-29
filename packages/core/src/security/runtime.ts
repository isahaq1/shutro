/**
 * Runtime security (RFC 0014 §7.10): roles, model access, record rules and feature-permission grants stored in the
 * database and edited while the system runs. Code declarations are the reviewed baseline; the database extends it
 * (it never removes a grant the code makes). Every change is validated against the registry when saved, audited,
 * and announced with NOTIFY so every process reloads.
 */
import type { Driver } from '@shutro/driver-pg';
import {
  type FieldGroups,
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
  `CREATE TABLE IF NOT EXISTS "shutro_role_field" ("model" text NOT NULL, "field" text NOT NULL, "read" text[] NOT NULL DEFAULT '{}', "write" text[] NOT NULL DEFAULT '{}', PRIMARY KEY ("model", "field"))`,
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
  /** model → field → the roles that may read / write it (in addition to the field's code groups). */
  readonly fields: ReadonlyMap<string, ReadonlyMap<string, FieldGroups>>;
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
  const fieldRows = await driver.query<{
    model: string;
    field: string;
    read: string[];
    write: string[];
  }>({
    text: 'SELECT model, field, read, write FROM shutro_role_field',
    params: [],
  });
  const fieldMap = new Map<string, Map<string, FieldGroups>>();
  for (const f of fieldRows) {
    const byField = fieldMap.get(f.model) ?? new Map<string, FieldGroups>();
    // Writers can read: when reading is restricted, the roles allowed to write are allowed to read. An empty read
    // list leaves reading open (`{ write: [...] }` makes the field read-only for everyone else).
    const read = Object.freeze(f.read.length === 0 ? [] : [...new Set([...f.read, ...f.write])]);
    byField.set(f.field, Object.freeze({ read, write: Object.freeze([...f.write]) }));
    fieldMap.set(f.model, byField);
  }
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
    fields: fieldMap,
  });
}

/** The runtime additions as plain lists, for administration screens (RFC 0014 §7.10). */
export interface RuntimeSecurityDescription {
  readonly roles: readonly RuntimeRole[];
  readonly access: readonly {
    readonly role: string;
    readonly model: string;
    readonly perms: readonly Perm[];
  }[];
  readonly rules: readonly RuntimeRule[];
  readonly permissions: readonly { readonly role: string; readonly permission: string }[];
  readonly fields: readonly {
    readonly model: string;
    readonly field: string;
    readonly read: readonly string[];
    readonly write: readonly string[];
  }[];
}

/** Reads the runtime additions as stored (creating the tables on first use), ordered for display. */
export async function describeRuntimeSecurity(
  driver: Pick<Driver, 'query'>,
): Promise<RuntimeSecurityDescription> {
  for (const text of DDL) await driver.query({ text, params: [] });
  // One after the other: one transaction, one connection.
  const roles = await driver.query<{
    code: string;
    label: string;
    implies: string[];
    administrator: boolean;
  }>({
    text: 'SELECT code, label, implies, administrator FROM shutro_role ORDER BY code',
    params: [],
  });
  const access = await driver.query<{ role: string; model: string; perms: string[] }>({
    text: 'SELECT role, model, perms FROM shutro_role_access ORDER BY role, model',
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
  const permissions = await driver.query<{ role: string; permission: string }>({
    text: 'SELECT role, permission FROM shutro_role_permission ORDER BY role, permission',
    params: [],
  });
  const fields = await driver.query<{
    model: string;
    field: string;
    read: string[];
    write: string[];
  }>({
    text: 'SELECT model, field, read, write FROM shutro_role_field ORDER BY model, field',
    params: [],
  });
  return Object.freeze({
    roles: roles.map((r) => Object.freeze({ ...r, implies: Object.freeze([...r.implies]) })),
    access: access.map((a) =>
      Object.freeze({ ...a, perms: Object.freeze([...a.perms] as Perm[]) }),
    ),
    rules: rules.map((r) =>
      Object.freeze({ ...r, perms: Object.freeze([...r.perms] as RulePerm[]) }),
    ),
    permissions: permissions.map((p) => Object.freeze({ ...p })),
    fields: fields.map((f) =>
      Object.freeze({ ...f, read: Object.freeze([...f.read]), write: Object.freeze([...f.write]) }),
    ),
  });
}

/**
 * The groups of a field with the runtime overlay (RFC 0014 §7.10): the code groups plus the roles given in the
 * overlay. A field without code groups that gets runtime roles becomes restricted to them: the one narrowing the
 * overlay allows, so administrators can hide or lock a field without code.
 */
export function effectiveFieldGroups(
  overlay: RuntimeSecurity | undefined,
  model: string,
  field: string,
  code: FieldGroups,
): FieldGroups {
  const extra = overlay?.fields.get(model)?.get(field);
  if (extra === undefined) return code;
  const merge = (a: readonly string[], b: readonly string[]): readonly string[] =>
    b.length === 0 ? a : Object.freeze([...new Set([...a, ...b])]);
  return Object.freeze({
    read: merge(code.read, extra.read),
    write: merge(code.write, extra.write),
  });
}

/** The codes (code groups and runtime roles) whose closure includes an administrator group. */
export function administratorCodes(
  registry: Registry,
  overlay: RuntimeSecurity | undefined,
): ReadonlySet<string> {
  const codes = [...registry.security.groups.keys(), ...(overlay?.roles.keys() ?? [])];
  return new Set(
    codes.filter((code) =>
      isAdministratorWith(registry, overlay, closureWith(registry, overlay, [code])),
    ),
  );
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
    case 'deleteRole': {
      for (const [model, byField] of overlay.fields)
        for (const [field, groups] of byField)
          if (groups.read.includes(change.code) || groups.write.includes(change.code))
            invalid(
              `The role '${change.code}' is used by the field security of ${model}.${field}.`,
              'Remove it from that field first (setFieldGroups): deleting it would change who sees the field.',
            );
      return;
    }
    case 'fields': {
      if (!registry.has(change.model))
        invalid(`The model '${change.model}' is not installed.`, 'Check the model name.');
      const field = registry.get(change.model).model.fields[change.field];
      if (field === undefined)
        invalid(`${change.model} has no field '${change.field}'.`, 'Check the field name.');
      if (change.field === 'id')
        invalid(
          'The id field cannot be restricted.',
          'Restrict other fields, or the model access.',
        );
      for (const role of [...change.read, ...change.write]) knownRole(registry, overlay, role);
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
  | { readonly kind: 'revokePermission'; readonly role: string; readonly permission: string }
  | {
      readonly kind: 'fields';
      readonly model: string;
      readonly field: string;
      readonly read: readonly string[];
      readonly write: readonly string[];
    };

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
    case 'fields':
      return change.read.length === 0 && change.write.length === 0
        ? compile(
            sql`DELETE FROM shutro_role_field WHERE model = ${change.model} AND field = ${change.field}`,
          )
        : compile(
            sql`INSERT INTO shutro_role_field (model, field, read, write) VALUES (${change.model}, ${change.field}, ${sql.array([...change.read], 'text')}, ${sql.array([...change.write], 'text')})
                ON CONFLICT (model, field) DO UPDATE SET read = EXCLUDED.read, write = EXCLUDED.write`,
          );
  }
}
