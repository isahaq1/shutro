/**
 * PostgreSQL row-level security generated from record rules (RFC 0014 §7.5): one permissive policy per group rule,
 * one restrictive policy per global rule, and the "no applicable group rule" and superuser escapes, all reading the
 * session settings `shutro.run()` pushes.
 */

import {
  type PolicyInput,
  rlsStatements as policyStatements,
  RLS_PLACEHOLDERS,
  RLS_SU,
  type RulePerm,
  resolvePlaceholders,
  rlsGroupCondition,
} from '@shutro/security';
import { compile, sql } from '@shutro/sql';
import type { AnyModel } from '../model/model.js';
import type { Registry } from '../registry/registry.js';
import { compileDomain, type ModelResolver } from './domain.js';

const MARK = '\u0000$env:';
const SENTINEL = { uid: Number.NaN, companyId: Number.NaN, companyIds: [] as number[] };

const COMMANDS: Readonly<Record<RulePerm, PolicyInput['command']>> = {
  read: 'SELECT',
  write: 'UPDATE',
  create: 'INSERT',
  unlink: 'DELETE',
};

function literal(value: unknown): string {
  if (typeof value === 'string') {
    if (value === `${MARK}uid`) return RLS_PLACEHOLDERS.uid;
    if (value === `${MARK}companyId`) return RLS_PLACEHOLDERS.companyId;
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === `${MARK}companyIds`) return RLS_PLACEHOLDERS.companyIds;
    return `ARRAY[${value.map(literal).join(', ')}]`;
  }
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

/** A rule domain as a boolean SQL expression over the table's columns and the session settings. */
export function ruleCondition(
  model: AnyModel,
  domain: Readonly<Record<string, unknown>>,
  resolve?: ModelResolver,
): string {
  // Placeholders become markers that survive compilation as parameters, then turn into current_setting() reads.
  const marked = resolvePlaceholders(domain, {
    uid: `${MARK}uid` as unknown as number,
    companyId: `${MARK}companyId` as unknown as number,
    companyIds: [`${MARK}companyIds`] as unknown as number[],
  });
  void SENTINEL;
  const conditions = compileDomain(model, marked as Record<string, unknown>, undefined, resolve);
  if (conditions.length === 0) return 'true';
  const { text, params } = compile(sql.join(conditions, sql` AND `));
  return text.replace(/\$(\d+)/g, (_, n: string) => literal(params[Number(n) - 1]));
}

/** The policies of one model, or `[]` when it has no rules. */
export function modelPolicies(model: AnyModel, resolve?: ModelResolver): PolicyInput[] {
  const policies: PolicyInput[] = [];
  const perms: RulePerm[] = ['read', 'write', 'create', 'unlink'];
  for (const perm of perms) {
    const command = COMMANDS[perm];
    const rules = Object.entries(model.rules).filter(([, r]) => r.perms.includes(perm));
    if (rules.length === 0) continue;
    const groupCodes = new Set<string>();
    for (const [key, rule] of rules) {
      const name = `${model.table}_${key}_${perm}`.slice(0, 63);
      if (rule.groups === 'global') {
        policies.push({
          table: model.table,
          name,
          command,
          permissive: false,
          condition: `${RLS_SU} OR (${ruleCondition(model, rule.domain, resolve)})`,
        });
      } else {
        for (const g of rule.groups) groupCodes.add(g);
        policies.push({
          table: model.table,
          name,
          command,
          permissive: true,
          condition: `${RLS_SU} OR (${rlsGroupCondition(rule.groups)} AND (${ruleCondition(model, rule.domain, resolve)}))`,
        });
      }
    }
    // Users none of whose groups a rule names are unrestricted by group rules; without any group rule, everyone is.
    policies.push({
      table: model.table,
      name: `${model.table}_nogroup_${perm}`.slice(0, 63),
      command,
      permissive: true,
      condition:
        groupCodes.size === 0 ? 'true' : `${RLS_SU} OR NOT (${rlsGroupCondition([...groupCodes])})`,
    });
  }
  return policies;
}

/** Every statement that enables RLS for the models with record rules. Run them through `@shutro/migrate` or directly. */
export function rlsStatements(registry: Registry): string[] {
  const out: string[] = [];
  for (const { model } of registry.models.values()) {
    const policies = modelPolicies(model, (n) => registry.get(n).model);
    if (policies.length > 0) out.push(...policyStatements(model.table, policies));
  }
  return out;
}
