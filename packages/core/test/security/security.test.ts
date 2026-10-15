/**
 * Security declarations (RFC 0014 §7.1–7.4, §8): registry checks, closure, policies text.
 */
import { describe, expect, test } from 'vitest';
import {
  buildRegistry,
  defineGroup,
  defineModel,
  defineModule,
  f,
  InvalidModuleError,
  modelPolicies,
  rlsStatements,
  ruleCondition,
  SecurityDefinitionError,
} from '../../src/index.js';
import { base, registry, SaleOrder } from './fixtures.js';

describe('declarations', () => {
  test('groups are indexed and closed over implies', () => {
    expect([...registry.security.groups.keys()].sort()).toEqual([
      'base.user',
      'hr.manager',
      'sale.manager',
      'sale.user',
    ]);
    expect([...registry.security.closure(['sale.manager'])].sort()).toEqual([
      'base.user',
      'sale.manager',
      'sale.user',
    ]);
    expect(SaleOrder.describe().access['sale.user']).toEqual(['read', 'write', 'create']);
    expect(SaleOrder.describe().fields['margin']?.groups).toEqual({
      read: ['sale.manager'],
      write: ['sale.manager'],
    });
    expect(SaleOrder.describe().rules['own']?.domain).toEqual({ user: { $env: 'uid' } });
  });

  test('undeclared groups and malformed specs are build errors', () => {
    const Bad = defineModel('x.bad', {
      access: { 'nope.group': ['read'] },
      fields: { a: f.char() },
    });
    expect(() =>
      buildRegistry({ modules: [defineModule({ name: 'bad', depends: [base], models: [Bad] })] }),
    ).toThrow(InvalidModuleError);
    const BadField = defineModel('x.badfield', {
      fields: { a: f.char({ groups: ['nope.group'] }) },
    });
    expect(() =>
      buildRegistry({
        modules: [defineModule({ name: 'badfield', depends: [base], models: [BadField] })],
      }),
    ).toThrow(/nope\.group/);
    expect(() =>
      defineModel('x.perm', { access: { 'base.user': ['fly' as never] }, fields: { a: f.char() } }),
    ).toThrow(SecurityDefinitionError);
    expect(() =>
      defineModel('x.rule', {
        rules: { r: { groups: 'global', perms: [], domain: {} } },
        fields: { a: f.char() },
      }),
    ).toThrow(SecurityDefinitionError);
    const dup = defineModule({
      name: 'dup',
      depends: [base],
      groups: [defineGroup({ code: 'base.user' })],
      models: [],
    });
    expect(() => buildRegistry({ modules: [dup] })).toThrow(InvalidModuleError);
    expect(() => f.char({ encrypted: true, translate: true })).toThrow(/both/);
  });
});

describe('rls', () => {
  test('rule domains become SQL over the session settings', () => {
    expect(ruleCondition(SaleOrder, { user: { $env: 'uid' } })).toBe(
      '"user_id" = current_setting(\'shutro.user_id\', true)::bigint',
    );
    expect(ruleCondition(SaleOrder, { company: { in: { $env: 'companyIds' } } })).toContain(
      "= ANY(string_to_array(trim(both '{}' from current_setting('shutro.company_ids', true)), ',')::bigint[])",
    );
    expect(ruleCondition(SaleOrder, { or: [{ note: "it's" }, { user: 7 }] })).toBe(
      '(("note" = \'it\'\'s\') OR ("user_id" = 7))',
    );
    expect(ruleCondition(SaleOrder, {})).toBe('true');
  });

  test('policies: permissive per group rule, restrictive per global, an escape for users without rules', () => {
    const policies = modelPolicies(SaleOrder);
    const read = policies.filter((p) => p.command === 'SELECT');
    expect(read.map((p) => [p.name, p.permissive])).toEqual([
      ['sale_order_own_read', true],
      ['sale_order_all_read', true],
      ['sale_order_company_read', false],
      ['sale_order_nogroup_read', true],
    ]);
    expect(read[0]?.condition).toContain(
      "ARRAY['sale.user']::text[] AND (\"user_id\" = current_setting('shutro.user_id', true)::bigint)",
    );
    expect(read[2]?.condition).toContain("current_setting('shutro.su', true) = '1' OR (");
    expect(read[3]?.condition).toContain(
      "NOT (string_to_array(current_setting('shutro.groups', true), ',') && ARRAY['sale.user', 'sale.manager']::text[])",
    );
    const statements = rlsStatements(registry);
    expect(statements.filter((s) => s.includes('ENABLE ROW LEVEL SECURITY'))).toEqual([
      'ALTER TABLE "sale_order" ENABLE ROW LEVEL SECURITY',
    ]);
    expect(statements.some((s) => s.includes('FOR INSERT WITH CHECK'))).toBe(true);
  });
});
