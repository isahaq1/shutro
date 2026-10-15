import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  allowed,
  applicableRules,
  createKeyRing,
  decrypt,
  defineGroup,
  EncryptionError,
  encrypt,
  fieldAllowed,
  groupClosure,
  isEncrypted,
  mergeAccess,
  normalizeFieldGroups,
  resolvePlaceholders,
  rlsGroupCondition,
  rlsStatements,
  SecurityDefinitionError,
} from '../src/index.js';

describe('groups', () => {
  const groups = new Map(
    [
      defineGroup({ code: 'base.user' }),
      defineGroup({ code: 'sale.user', implies: ['base.user'] }),
      defineGroup({ code: 'sale.manager', implies: ['sale.user'] }),
    ].map((g) => [g.code, g]),
  );
  test('closure follows implies transitively', () => {
    expect([...groupClosure(groups, ['sale.manager'])].sort()).toEqual([
      'base.user',
      'sale.manager',
      'sale.user',
    ]);
    expect([...groupClosure(groups, ['unknown.group'])]).toEqual(['unknown.group']);
    expect(() => defineGroup({ code: 'Sale' })).toThrow(SecurityDefinitionError);
  });
  test('access is default deny and extensions only add', () => {
    const access = {
      'sale.user': ['read'] as const,
      'sale.manager': ['read', 'write', 'unlink'] as const,
    };
    expect(allowed(access, new Set(['sale.user']), 'read')).toBe(true);
    expect(allowed(access, new Set(['sale.user']), 'write')).toBe(false);
    expect(allowed(access, new Set(), 'read')).toBe(false);
    expect(mergeAccess(access, { 'sale.user': ['export'] })).toEqual({
      'sale.user': ['read', 'export'],
      'sale.manager': ['read', 'write', 'unlink'],
    });
  });
});

describe('record rules', () => {
  const rules = {
    own: {
      groups: ['sale.user'],
      perms: ['read', 'write'] as const,
      domain: { user: { $env: 'uid' } },
    },
    all: { groups: ['sale.manager'], perms: ['read', 'write', 'unlink'] as const, domain: {} },
    company: {
      groups: 'global' as const,
      perms: ['read', 'write', 'create', 'unlink'] as const,
      domain: { company: { in: { $env: 'companyIds' } } },
    },
  };
  test('globals and group rules split per operation', () => {
    const user = applicableRules(rules, new Set(['sale.user']), 'read');
    expect(user.globals.map((r) => r.domain)).toEqual([rules.company.domain]);
    expect(user.groupRules).toEqual([rules.own]);
    expect(user.hasGroupRules).toBe(true);
    const nobody = applicableRules(rules, new Set(['hr.user']), 'read');
    expect(nobody.groupRules).toEqual([]);
    expect(nobody.hasGroupRules).toBe(true); // group rules exist, none applies: unrestricted by them (Odoo semantics)
    expect(applicableRules(rules, new Set(['sale.user']), 'unlink').groupRules).toEqual([]);
  });
  test('placeholders resolve from the environment', () => {
    expect(
      resolvePlaceholders(
        { or: [{ user: { $env: 'uid' } }, { company: { in: { $env: 'companyIds' } } }] },
        { uid: 7, companyId: 1, companyIds: [1, 2] },
      ),
    ).toEqual({
      or: [{ user: 7 }, { company: { in: [1, 2] } }],
    });
    expect(() =>
      resolvePlaceholders({ x: { $env: 'nope' } }, { uid: 1, companyId: 1, companyIds: [1] }),
    ).toThrow(SecurityDefinitionError);
  });
});

describe('field groups', () => {
  test('normalization and checks', () => {
    expect(normalizeFieldGroups(['hr.manager'])).toEqual({
      read: ['hr.manager'],
      write: ['hr.manager'],
    });
    expect(normalizeFieldGroups({ read: ['hr.user'], write: ['hr.manager'] })).toEqual({
      read: ['hr.user'],
      write: ['hr.manager'],
    });
    expect(normalizeFieldGroups({ write: ['hr.manager'] })).toEqual({
      read: [],
      write: ['hr.manager'],
    });
    const g = normalizeFieldGroups({ read: ['hr.user'], write: ['hr.manager'] });
    expect(fieldAllowed(g, new Set(['hr.user']), 'read')).toBe(true);
    expect(fieldAllowed(g, new Set(['hr.user']), 'write')).toBe(false);
    expect(fieldAllowed(normalizeFieldGroups(undefined), new Set(), 'write')).toBe(true);
  });
});

describe('rls', () => {
  test('policy DDL', () => {
    const texts = rlsStatements('sale_order', [
      {
        table: 'sale_order',
        name: 'p',
        command: 'SELECT',
        permissive: true,
        condition: `${rlsGroupCondition(['sale.user'])} AND user_id = current_setting('shutro.user_id', true)::bigint`,
      },
    ]);
    expect(texts[0]).toBe('ALTER TABLE "sale_order" ENABLE ROW LEVEL SECURITY');
    expect(texts[1]).toBe('ALTER TABLE "sale_order" FORCE ROW LEVEL SECURITY');
    expect(texts[3]).toContain("ARRAY['sale.user']::text[]");
    expect(texts[3]).toContain('AS PERMISSIVE FOR SELECT USING (');
    expect(rlsGroupCondition([])).toBe('false');
    expect(rlsGroupCondition(["it's"])).toContain("'it''s'");
  });
});

describe('encryption', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32).toString('base64');
  const ring = createKeyRing({ current: 'k1', keys: { k1 } });
  test('round trip, distinct tokens, rotation and tamper detection', () => {
    const a = encrypt(ring, 'secret');
    const b = encrypt(ring, 'secret');
    expect(a).not.toBe(b);
    expect(isEncrypted(a)).toBe(true);
    expect(decrypt(ring, a)).toBe('secret');
    const rotated = createKeyRing({ current: 'k2', keys: { k1, k2 } });
    expect(decrypt(rotated, a)).toBe('secret'); // old key still decrypts
    expect(encrypt(rotated, 'x').split(':')[1]).toBe('k2');
    expect(() => decrypt(createKeyRing({ current: 'k2', keys: { k2 } }), a)).toThrow(
      EncryptionError,
    ); // k1 gone
    const tampered = `${a.slice(0, -2)}AA`;
    expect(() => decrypt(ring, tampered)).toThrow(EncryptionError);
    expect(() => decrypt(ring, 'plain')).toThrow(EncryptionError);
    expect(() => createKeyRing({ current: 'k', keys: { k: randomBytes(16) } })).toThrow(/32 bytes/);
  });
});
