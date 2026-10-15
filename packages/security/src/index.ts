/**
 * @packageDocumentation
 * `@shutro/security` (RFC 0014): the pure rules of access control — groups with inheritance, model ACL, record rules
 * (which rules apply, how they combine), field-level groups, the PostgreSQL RLS policy text, and field encryption
 * with keys that never enter the database. Core applies them; applications and Kosh can call them directly.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ------------------------------------------------------------------------------------------------- groups

/** A security group. `implies` are inherited: a member of `sale.manager` is also a member of `sale.user`. */
export interface GroupDefinition {
  /** `module.name`, e.g. `'sale.user'`. */
  readonly code: string;
  readonly label: string;
  readonly implies: readonly string[];
  /**
   * Members (directly or through `implies`) are administrators: every ACL, record-rule, field-group and permission
   * check passes for them, on every model and feature of every module, without any grant.
   */
  readonly administrator: boolean;
}

/**
 * A named permission for a feature that is not a model operation: an app, a menu, a button, an approval
 * (`'sale.discount_approve'`). Granted to groups; administrators always have it.
 */
export interface PermissionDefinition {
  /** `module.name`, e.g. `'sale.discount_approve'`. */
  readonly code: string;
  readonly label: string;
  /** Groups that grant it (implied groups count). */
  readonly groups: readonly string[];
}

export const GROUP_CODE: RegExp = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** A security declaration that cannot be used. */
export class SecurityDefinitionError extends Error {
  readonly hint: string;
  constructor(problem: string, hint: string) {
    super(`${problem} ${hint}`);
    this.name = 'SecurityDefinitionError';
    this.hint = hint;
  }
}

/** Validates a group. */
export function defineGroup(input: {
  readonly code: string;
  readonly label?: string;
  readonly implies?: readonly string[];
  /** Members can do everything, without grants (see {@link GroupDefinition.administrator}). */
  readonly administrator?: boolean;
}): GroupDefinition {
  if (typeof input.code !== 'string' || !GROUP_CODE.test(input.code)) {
    throw new SecurityDefinitionError(
      `${JSON.stringify(input.code)} is not a group code.`,
      "Use 'module.name', e.g. 'sale.user' or 'account.manager'.",
    );
  }
  for (const code of input.implies ?? []) {
    if (!GROUP_CODE.test(code))
      throw new SecurityDefinitionError(
        `Group '${input.code}' implies ${JSON.stringify(code)}, which is not a group code.`,
        "Use 'module.name'.",
      );
  }
  return Object.freeze({
    code: input.code,
    label: input.label ?? input.code,
    implies: Object.freeze([...(input.implies ?? [])]),
    administrator: input.administrator === true,
  });
}

/** Declares a feature permission. @throws {SecurityDefinitionError} for malformed codes. */
export function definePermission(input: {
  readonly code: string;
  readonly label?: string;
  readonly groups: readonly string[];
}): PermissionDefinition {
  if (typeof input.code !== 'string' || !GROUP_CODE.test(input.code)) {
    throw new SecurityDefinitionError(
      `${JSON.stringify(input.code)} is not a permission code.`,
      "Use 'module.name', e.g. 'sale.discount_approve'.",
    );
  }
  for (const code of input.groups) {
    if (!GROUP_CODE.test(code))
      throw new SecurityDefinitionError(
        `Permission '${input.code}' is granted to ${JSON.stringify(code)}, which is not a group code.`,
        "Use 'module.name'.",
      );
  }
  return Object.freeze({
    code: input.code,
    label: input.label ?? input.code,
    groups: Object.freeze([...input.groups]),
  });
}

/** The transitive closure of `codes` over `implies` (unknown codes are kept as given). */
export function groupClosure(
  groups: ReadonlyMap<string, GroupDefinition>,
  codes: Iterable<string>,
): Set<string> {
  const out = new Set<string>();
  const stack = [...codes];
  while (stack.length > 0) {
    const code = stack.pop() as string;
    if (out.has(code)) continue;
    out.add(code);
    for (const implied of groups.get(code)?.implies ?? []) stack.push(implied);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- ACL

/** What a group may do with a model. */
export type Perm = 'read' | 'write' | 'create' | 'unlink' | 'export' | 'import';
export const PERMS: readonly Perm[] = Object.freeze([
  'read',
  'write',
  'create',
  'unlink',
  'export',
  'import',
]);

/** Group code → permissions. Absence means denied (default deny, RFC 0014 §7.2). */
export type AccessSpec = Readonly<Record<string, readonly Perm[]>>;

/** Validates an access declaration. */
export function assertAccessSpec(spec: AccessSpec, where: string): void {
  for (const [group, perms] of Object.entries(spec)) {
    if (!GROUP_CODE.test(group))
      throw new SecurityDefinitionError(
        `${where}: access group ${JSON.stringify(group)} is not a group code.`,
        "Use 'module.name'.",
      );
    if (!Array.isArray(perms) || perms.some((p) => !PERMS.includes(p)))
      throw new SecurityDefinitionError(
        `${where}: access of '${group}' lists an unknown permission.`,
        `Use: ${PERMS.join(', ')}.`,
      );
  }
}

/** True when any of the user's (closed) groups grants `perm`. */
export function allowed(spec: AccessSpec, groups: ReadonlySet<string>, perm: Perm): boolean {
  for (const [group, perms] of Object.entries(spec)) {
    if (groups.has(group) && perms.includes(perm)) return true;
  }
  return false;
}

/** Merges access declarations (an extension adds permissions, never removes). */
export function mergeAccess(base: AccessSpec, extra: AccessSpec): AccessSpec {
  const out: Record<string, Perm[]> = {};
  for (const [group, perms] of Object.entries(base)) out[group] = [...perms];
  for (const [group, perms] of Object.entries(extra)) {
    const current = out[group] ?? [];
    for (const p of perms) if (!current.includes(p)) current.push(p);
    out[group] = current;
  }
  return out;
}

// -------------------------------------------------------------------------------------------- record rules

/** Operations a rule can restrict. */
export type RulePerm = 'read' | 'write' | 'create' | 'unlink';

/** A record rule: a domain over the model with `{ $env: ... }` placeholders (RFC 0005 §7.1). */
export interface RuleSpec {
  /** Group codes the rule applies to, or `'global'` for everyone (including users with other rules). */
  readonly groups: readonly string[] | 'global';
  readonly perms: readonly RulePerm[];
  /** The domain (serializable; `{ $env: 'uid' | 'companyId' | 'companyIds' }` where a value goes). */
  readonly domain: Readonly<Record<string, unknown>>;
  readonly label?: string;
}

const RULE_PERMS: readonly RulePerm[] = Object.freeze(['read', 'write', 'create', 'unlink']);

/** Validates a rule. */
export function assertRuleSpec(rule: RuleSpec, where: string): void {
  if (
    rule.groups !== 'global' &&
    (!Array.isArray(rule.groups) || rule.groups.some((g) => !GROUP_CODE.test(g)))
  )
    throw new SecurityDefinitionError(
      `${where}: groups must be 'global' or group codes.`,
      "Use groups: ['sale.user'] or groups: 'global'.",
    );
  if (
    !Array.isArray(rule.perms) ||
    rule.perms.length === 0 ||
    rule.perms.some((p) => !RULE_PERMS.includes(p))
  )
    throw new SecurityDefinitionError(
      `${where}: perms lists an unknown permission.`,
      `Use a non-empty subset of: ${RULE_PERMS.join(', ')}.`,
    );
  if (typeof rule.domain !== 'object' || rule.domain === null || Array.isArray(rule.domain))
    throw new SecurityDefinitionError(
      `${where}: domain must be an object.`,
      "E.g. { user: { $env: 'uid' } }.",
    );
}

/** The rules that apply to a user for an operation: globals (ANDed) and group rules (ORed). */
export interface ApplicableRules {
  readonly globals: readonly RuleSpec[];
  readonly groupRules: readonly RuleSpec[];
  /** True when at least one group rule for the operation exists in the model at all (then users without any applicable group rule are unrestricted by group rules, as in Odoo). */
  readonly hasGroupRules: boolean;
}

/** Splits a model's rules for `perm` into what applies to `groups` (RFC 0014 §7.3). */
export function applicableRules(
  rules: Readonly<Record<string, RuleSpec>>,
  groups: ReadonlySet<string>,
  perm: RulePerm,
): ApplicableRules {
  const globals: RuleSpec[] = [];
  const groupRules: RuleSpec[] = [];
  let hasGroupRules = false;
  for (const rule of Object.values(rules)) {
    if (!rule.perms.includes(perm)) continue;
    if (rule.groups === 'global') globals.push(rule);
    else {
      hasGroupRules = true;
      if (rule.groups.some((g) => groups.has(g))) groupRules.push(rule);
    }
  }
  return { globals, groupRules, hasGroupRules };
}

/** The environment values placeholders may name. */
export interface PlaceholderEnv {
  readonly uid: number;
  readonly companyId: number;
  readonly companyIds: readonly number[];
}

/** Replaces `{ $env: name }` objects in a domain with the environment's values. */
export function resolvePlaceholders(domain: unknown, env: PlaceholderEnv): unknown {
  if (Array.isArray(domain)) return domain.map((d) => resolvePlaceholders(d, env));
  if (typeof domain !== 'object' || domain === null) return domain;
  const keys = Object.keys(domain);
  if (keys.length === 1 && keys[0] === '$env') {
    const name = (domain as { $env: unknown }).$env;
    if (name === 'uid') return env.uid;
    if (name === 'companyId') return env.companyId;
    if (name === 'companyIds') return [...env.companyIds];
    throw new SecurityDefinitionError(
      `Unknown placeholder { $env: ${JSON.stringify(name)} }.`,
      "Use 'uid', 'companyId' or 'companyIds'.",
    );
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(domain)) out[k] = resolvePlaceholders(v, env);
  return out;
}

// ------------------------------------------------------------------------------------------- field groups

/** Who may read / write a field. Empty means everyone with model access. */
export interface FieldGroups {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** `groups: ['hr.manager']` (both) or `{ read: [...], write: [...] }`. */
export type FieldGroupsInput =
  | readonly string[]
  | { readonly read?: readonly string[]; readonly write?: readonly string[] };

/** Normalizes a field's groups option. */
export function normalizeFieldGroups(input: FieldGroupsInput | undefined): FieldGroups {
  if (input === undefined)
    return Object.freeze({ read: Object.freeze([]), write: Object.freeze([]) });
  if (Array.isArray(input)) {
    const list = Object.freeze([...(input as readonly string[])]);
    return Object.freeze({ read: list, write: list });
  }
  const obj = input as { readonly read?: readonly string[]; readonly write?: readonly string[] };
  const read = Object.freeze([...(obj.read ?? [])]);
  // Writing implies reading: a write-only field would be unreadable by its own writers.
  const write = Object.freeze([...(obj.write ?? obj.read ?? [])]);
  return Object.freeze({ read, write });
}

/** True when the field has no restriction for `kind` or the user is in one of its groups. */
export function fieldAllowed(
  groups: FieldGroups,
  userGroups: ReadonlySet<string>,
  kind: 'read' | 'write',
): boolean {
  const required = kind === 'read' ? groups.read : groups.write;
  return required.length === 0 || required.some((g) => userGroups.has(g));
}

// ---------------------------------------------------------------------------------------------------- RLS

/** The session settings `shutro.run()` pushes (RFC 0003 §7.1) and RLS policies read. */
export const RLS_SETTINGS: Readonly<{
  user: string;
  company: string;
  companies: string;
  groups: string;
  su: string;
}> = Object.freeze({
  user: 'shutro.user_id',
  company: 'shutro.company_id',
  companies: 'shutro.company_ids',
  groups: 'shutro.groups',
  su: 'shutro.su',
});

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** SQL expressions for the placeholders, reading the session settings. */
export const RLS_PLACEHOLDERS: Readonly<Record<'uid' | 'companyId' | 'companyIds', string>> =
  Object.freeze({
    uid: `current_setting('${RLS_SETTINGS.user}', true)::bigint`,
    companyId: `current_setting('${RLS_SETTINGS.company}', true)::bigint`,
    companyIds: `string_to_array(trim(both '{}' from current_setting('${RLS_SETTINGS.companies}', true)), ',')::bigint[]`,
  });

/** `true` when the session is a superuser scope. */
export const RLS_SU: string = `current_setting('${RLS_SETTINGS.su}', true) = '1'`;

/** `true` when the session's groups intersect `codes`. */
export function rlsGroupCondition(codes: readonly string[]): string {
  if (codes.length === 0) return 'false';
  return `string_to_array(current_setting('${RLS_SETTINGS.groups}', true), ',') && ARRAY[${codes.map(literal).join(', ')}]::text[]`;
}

/** A policy to create. */
export interface PolicyInput {
  readonly table: string;
  readonly name: string;
  readonly command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  readonly permissive: boolean;
  /** Boolean SQL over the table's columns and the session settings. */
  readonly condition: string;
}

/** The DDL enabling RLS on a table and installing policies (idempotent: policies are dropped and recreated). */
export function rlsStatements(table: string, policies: readonly PolicyInput[]): string[] {
  const t = `"${table}"`;
  const out = [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
  ];
  for (const p of policies) {
    out.push(`DROP POLICY IF EXISTS "${p.name}" ON ${t}`);
    const clause =
      p.command === 'INSERT'
        ? `WITH CHECK (${p.condition})`
        : p.command === 'UPDATE'
          ? `USING (${p.condition}) WITH CHECK (${p.condition})`
          : `USING (${p.condition})`;
    out.push(
      `CREATE POLICY "${p.name}" ON ${t} AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${p.command} ${clause}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- encryption

/** Keys live in the application (env vars, a KMS), never in the database (RFC 0014 §7.6). */
export interface KeyRing {
  /** The id new writes encrypt with. */
  readonly current: string;
  /** Every key still needed to decrypt stored values. 32 bytes each (raw or base64). */
  readonly keys: Readonly<Record<string, Uint8Array | string>>;
}

/** Encryption failed or a token cannot be decrypted. */
export class EncryptionError extends Error {
  readonly hint: string;
  constructor(problem: string, hint: string, options?: { readonly cause?: unknown }) {
    super(`${problem} ${hint}`, options);
    this.name = 'EncryptionError';
    this.hint = hint;
  }
}

const TOKEN_PREFIX = 'shutro1';

function keyBytes(ring: KeyRing, id: string): Buffer {
  const raw = ring.keys[id];
  if (raw === undefined)
    throw new EncryptionError(
      `No key '${id}' in the key ring.`,
      'Keep every key that encrypted a stored value until the data is re-encrypted.',
    );
  const key = typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw);
  if (key.length !== 32)
    throw new EncryptionError(
      `Key '${id}' is ${key.length} bytes.`,
      'Keys are 32 bytes (AES-256), raw or base64.',
    );
  return key;
}

/** Validates a key ring. */
export function createKeyRing(ring: KeyRing): KeyRing {
  keyBytes(ring, ring.current);
  for (const id of Object.keys(ring.keys)) keyBytes(ring, id);
  return Object.freeze({ current: ring.current, keys: Object.freeze({ ...ring.keys }) });
}

/** AES-256-GCM; the token names the key so rotation only changes `current`. */
export function encrypt(ring: KeyRing, plaintext: string): string {
  const key = keyBytes(ring, ring.current);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_PREFIX,
    ring.current,
    iv.toString('base64'),
    tag.toString('base64'),
    data.toString('base64'),
  ].join(':');
}

/** True for a value produced by {@link encrypt}. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${TOKEN_PREFIX}:`);
}

/** Decrypts a token; a wrong key or a tampered token is an {@link EncryptionError}. */
export function decrypt(ring: KeyRing, token: string): string {
  const parts = token.split(':');
  if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX)
    throw new EncryptionError(
      'The stored value is not an encrypted token.',
      'Values of encrypted fields are written by the ORM; do not update the column by hand.',
    );
  const [, id = '', iv = '', tag = '', data = ''] = parts;
  const key = keyBytes(ring, id);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch (cause) {
    throw new EncryptionError(
      `The value encrypted with key '${id}' cannot be decrypted.`,
      'The key is wrong or the stored value was tampered with.',
      { cause },
    );
  }
}
