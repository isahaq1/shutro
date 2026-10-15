import { describe, expect, test } from 'vitest';
import { auditTableStatements, insertAuditStatement, trailQuery } from '../src/index.js';

describe('audit statements', () => {
  test('the table is append-only by trigger', () => {
    const texts = auditTableStatements().map((s) => s.text);
    expect(texts.some((t) => t.startsWith('CREATE TABLE IF NOT EXISTS "shutro_audit"'))).toBe(true);
    expect(texts.some((t) => t.includes('BEFORE UPDATE OR DELETE'))).toBe(true);
    expect(auditTableStatements().every((s) => s.params.length === 0)).toBe(true);
  });

  test('one insert for many rows, JSON bound as text and cast', () => {
    const at = new Date('2026-10-15T08:00:00Z');
    const { text, params } = insertAuditStatement([
      {
        at,
        tx: 't1',
        uid: 1,
        companyId: 1,
        su: false,
        reason: null,
        action: 'create',
        model: 'sale.order',
        recordId: 7,
        field: null,
        old: null,
        new: { state: 'draft' },
      },
      {
        at,
        tx: 't1',
        uid: 1,
        companyId: 1,
        su: true,
        reason: 'job',
        action: 'write',
        model: 'sale.order',
        recordId: 7,
        field: 'state',
        old: 'draft',
        new: 'sale',
      },
    ]);
    expect(text).toContain('FROM unnest(');
    expect(text).toContain('"v"."old"::jsonb');
    expect(params).toHaveLength(12);
    expect(params[10]).toEqual([null, '"draft"']);
    expect(params[11]).toEqual(['{"state":"draft"}', '"sale"']);
  });

  test('trail query filters and orders newest first', () => {
    const { text, params } = trailQuery({
      model: 'sale.order',
      recordIds: [7, 8],
      field: 'state',
      limit: 5,
    });
    expect(text).toContain('"model" = $1');
    expect(text).toContain('ORDER BY "id" DESC LIMIT $4');
    expect(params).toEqual(['sale.order', [7, 8], 'state', 5]);
    expect(trailQuery().text).not.toContain('WHERE');
  });
});
