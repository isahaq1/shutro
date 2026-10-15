/**
 * Constraint and onchange declarations (RFC 0009 §8–9): registry index, validation, extensions, metadata.
 */
import { describe, expect, test } from 'vitest';
import {
  buildRegistry,
  defineModel,
  defineModule,
  ExtensionConflictError,
  extendModel,
  f,
  InvalidDependsPathError,
  InvalidModelError,
} from '../../src/index.js';
import { base, registry, sale } from './fixtures.js';

describe('constraints', () => {
  test('the graph indexes constraints by the fields they depend on', () => {
    const graph = registry.compute;
    expect(graph.constraints('sale.order', 'dateOrder').map((c) => c.key)).toEqual(['validity']);
    expect(graph.constraints('sale.order', 'validityDate').map((c) => c.key)).toEqual(['validity']);
    expect(graph.constraints('sale.order', 'note')).toEqual([]);
    expect(graph.constraints('sale.order.line', 'quantity').map((c) => c.key)).toEqual([
      'positiveQuantity',
    ]);
  });

  test('depends must be fields of the model, without paths', () => {
    const Bad = defineModel('x.bad', {
      fields: { partner: f.many2one('res.partner') },
      constraints: { viaPath: { depends: ['partner.name'], check: () => [], message: 'x' } },
    });
    const mod = defineModule({ name: 'bad', depends: [base], models: [Bad] });
    expect(() => buildRegistry({ modules: [mod] })).toThrow(InvalidDependsPathError);
    const Unknown = defineModel('x.unknown', {
      fields: { a: f.char() },
      constraints: { nope: { depends: ['b'], check: () => [], message: 'x' } },
    });
    expect(() =>
      buildRegistry({
        modules: [defineModule({ name: 'unknown', depends: [base], models: [Unknown] })],
      }),
    ).toThrow(/'b' of constraint 'nope'/);
  });

  test('describe() lists constraints and onchange handlers', () => {
    const description = registry.describe('sale.order');
    expect(description.constraints.map((c) => c.key)).toEqual(['validity']);
    expect(description.constraints[0]?.message).toBeNull(); // a function
    expect(description.onchange).toEqual(['partner', 'currency']);
    expect(description.sqlConstraints.map((c) => c.key).sort()).toEqual([
      'nameUnique',
      'taxRateNonNegative',
    ]);
  });
});

describe('onchange declarations', () => {
  test('an onchange key must be a field', () => {
    expect(() =>
      defineModel('x.o', { fields: { a: f.char() }, onchange: { b: () => undefined } }),
    ).toThrow(InvalidModelError);
    expect(() =>
      defineModel('x.o', { fields: { a: f.char() }, onchange: { a: 'nope' as never } }),
    ).toThrow(/is not a function/);
  });

  test('extensions add constraints and handlers; a handler for the same field is a conflict', () => {
    const ext = extendModel('sale.order', {
      fields: { ref: f.char() },
      constraints: { refFormat: { depends: ['ref'], check: () => [], message: 'Bad ref.' } },
      onchange: { ref: () => undefined },
    });
    const mod = defineModule({ name: 'sale_ref', depends: [sale], models: [], extensions: [ext] });
    const built = buildRegistry({ modules: [mod] });
    expect(built.describe('sale.order').onchange).toEqual(['partner', 'currency', 'ref']);
    expect(built.compute.constraints('sale.order', 'ref').map((c) => c.key)).toEqual(['refFormat']);

    const clash = extendModel('sale.order', { onchange: { partner: () => undefined } });
    const bad = defineModule({
      name: 'sale_clash',
      depends: [sale],
      models: [],
      extensions: [clash],
    });
    expect(() => buildRegistry({ modules: [bad] })).toThrow(ExtensionConflictError);
  });
});
