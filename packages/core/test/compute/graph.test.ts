/**
 * The compute dependency graph (RFC 0008 §7.1): triggers, reverse paths, ranks, cycles.
 */
import { describe, expect, test } from 'vitest';
import { buildRegistry, ComputeCycleError, defineModel, defineModule, f } from '../../src/index.js';
import { base, registry } from './fixtures.js';

describe('compute graph', () => {
  const graph = registry.compute;

  test('ranks follow dependency depth, across models', () => {
    expect(graph.field('sale.order.line', 'subtotal')?.rank).toBe(0);
    expect(graph.field('sale.order', 'amountUntaxed')?.rank).toBe(1);
    expect(graph.field('sale.order', 'amountTotal')?.rank).toBe(2);
    expect(graph.field('sale.order', 'partnerName')?.rank).toBe(0);
    expect(graph.field('sale.order', 'displayName')?.rank).toBe(0);
    expect(graph.field('sale.order', 'nope')).toBeUndefined();
  });

  test('every prefix of a path is a trigger with the reverse steps to walk', () => {
    const onSubtotal = graph.triggers.get('sale.order.line')?.get('subtotal') ?? [];
    expect(onSubtotal.map((t) => `${t.field.model}.${t.field.key}`)).toEqual([
      'sale.order.amountUntaxed',
    ]);
    expect(onSubtotal[0]?.reverse.map((s) => `${s.model}.${s.key}:${s.kind}`)).toEqual([
      'sale.order.lines:one2many',
    ]);
    expect(onSubtotal[0]?.reverse[0]?.inverse).toBe('order');

    const onLines = graph.triggers.get('sale.order')?.get('lines') ?? [];
    expect(onLines.map((t) => t.field.key).sort()).toEqual(['amountUntaxed', 'lineCount']);
    expect(onLines.every((t) => t.reverse.length === 0)).toBe(true);

    const onPartnerName = (graph.triggers.get('res.partner')?.get('name') ?? []).filter(
      (t) => t.field.model === 'sale.order',
    );
    expect(onPartnerName.map((t) => t.field.key)).toEqual(['partnerName']);
    expect(onPartnerName[0]?.reverse.map((s) => s.kind)).toEqual(['many2one']);

    const onTagName = (graph.triggers.get('sale.tag')?.get('name') ?? []).filter(
      (t) => t.field.model === 'sale.order',
    );
    expect(onTagName[0]?.reverse.map((s) => s.kind)).toEqual(['many2many']);

    // The default displayName depends on recName.
    expect(
      (graph.triggers.get('sale.order')?.get('name') ?? []).map((t) => t.field.key).sort(),
    ).toEqual(['code', 'displayName']);
  });

  test('stored fields per model, and the many2one keys that move records between parents', () => {
    expect(
      graph
        .stored('sale.order')
        .map((f) => f.key)
        .sort(),
    ).toEqual(['amountTotal', 'amountUntaxed', 'code', 'partnerName', 'tagNames']);
    expect(graph.stored('res.partner')).toEqual([]);
    expect([...graph.inverseKeys('sale.order.line')]).toEqual(['order']);
    expect(graph.inverseKeys('sale.order').size).toBe(0);
  });

  test('a dependency cycle between computed fields is a build error naming the chain', () => {
    const Loop = defineModel('x.loop', {
      fields: {
        a: f.integer({ depends: ['b'], compute: () => undefined }),
        b: f.integer({ depends: ['a'], compute: () => undefined }),
      },
    });
    const mod = defineModule({ name: 'loop', depends: [base], models: [Loop] });
    expect(() => buildRegistry({ modules: [mod] })).toThrow(ComputeCycleError);
    expect(() => buildRegistry({ modules: [mod] })).toThrow(/x\.loop\.a → x\.loop\.b → x\.loop\.a/);
  });
});
