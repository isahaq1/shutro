/**
 * Multi-company declarations (RFC 0003 §7.4): the synthesized constraint and its validation.
 */
import { describe, expect, test } from 'vitest';
import {
  buildRegistry,
  defineModel,
  defineModule,
  f,
  InvalidModelError,
  InvalidRelationError,
} from '../../src/index.js';
import { base, registry, SaleOrder } from './fixtures.js';

describe('checkCompany', () => {
  test('a checkCompany field synthesizes the companyConsistency constraint', () => {
    expect(SaleOrder.constraints.map((c) => c.key)).toEqual(['companyConsistency']);
    expect(SaleOrder.constraints[0]?.depends).toEqual(['company', 'partner']);
    expect(SaleOrder.describe().fields['partner']?.['checkCompany']).toBe(true);
    expect(registry.compute.constraints('sale.order', 'partner').map((c) => c.key)).toEqual([
      'companyConsistency',
    ]);
  });

  test('needs a companyScoped model and a companyScoped target', () => {
    expect(() =>
      defineModel('x.unscoped', {
        fields: { partner: f.many2one('res.partner', { checkCompany: true }) },
      }),
    ).toThrow(InvalidModelError);
    const Bad = defineModel('x.bad', {
      companyScoped: { required: true },
      fields: { currency: f.many2one('res.currency', { checkCompany: true }) },
    });
    expect(() =>
      buildRegistry({ modules: [defineModule({ name: 'bad', depends: [base], models: [Bad] })] }),
    ).toThrow(InvalidRelationError);
  });
});
