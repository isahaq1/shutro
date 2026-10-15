/**
 * State machines at definition time (RFC 0010 §7.1, §7.4, §8): generated methods, clashes, extension, types.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  buildRegistry,
  type CreateOf,
  defineModel,
  defineModule,
  extendModel,
  f,
  InvalidExtensionError,
  InvalidFieldError,
  InvalidModelError,
  type WriteOf,
} from '../../src/index.js';
import { base, registry, SaleOrder, sale } from './fixtures.js';

describe('declaration', () => {
  test('every transition becomes a method; the state field is not writable', () => {
    expect(Object.keys(SaleOrder.methods).sort()).toEqual([
      'cancel',
      'confirm',
      'markSent',
      'send',
    ]);
    expectTypeOf<(typeof SaleOrder)['methods']['confirm']>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<(typeof SaleOrder)['methods']>().toHaveProperty('send');
    expectTypeOf<(typeof SaleOrder)['methods']>().toHaveProperty('markSent');
    expectTypeOf<WriteOf<(typeof SaleOrder)['fields']>>().not.toHaveProperty('state');
    expectTypeOf<CreateOf<(typeof SaleOrder)['fields']>>().not.toHaveProperty('state');
  });

  test('a declared method with a transition name is a clash', () => {
    expect(() =>
      defineModel('x.clash', {
        fields: {
          state: f.state({
            states: { a: 'A', b: 'B' },
            initial: 'a',
            transitions: { go: { from: ['a'], to: 'b' } },
          }),
        },
        methods: { async go(): Promise<void> {} },
      }),
    ).toThrow(InvalidModelError);
  });

  test('guards and hooks must be functions', () => {
    expect(() =>
      f.state({
        states: { a: 'A', b: 'B' },
        initial: 'a',
        transitions: { go: { from: ['a'], to: 'b', guard: 'nope' as never } },
      }),
    ).toThrow(InvalidFieldError);
    expect(() =>
      f.state({
        states: { a: { label: 'A', onEnter: 1 as never }, b: 'B' },
        initial: 'a',
        transitions: {},
      }),
    ).toThrow(/onEnter/);
  });

  test('describe() shows states, transitions and guards', () => {
    const state = SaleOrder.describe().fields['state'];
    expect(state?.['initial']).toBe('draft');
    expect(state?.['transitions']).toMatchObject({
      confirm: { from: ['draft', 'sent'], to: 'sale', guarded: true },
      cancel: { from: ['draft', 'sent', 'sale'], to: 'cancel', guarded: false },
    });
  });
});

describe('extension', () => {
  test('statesAdd / transitionsAdd generate methods in the rebuilt model with the extension as origin', () => {
    const order = registry.get('sale.order');
    expect(Object.keys(order.model.methods).sort()).toEqual([
      'cancel',
      'confirm',
      'hold',
      'markSent',
      'resume',
      'send',
    ]);
    expect(order.methodLayers['hold']).toEqual([{ module: 'sale_hold', kind: 'definition' }]);
    expect(order.methodLayers['confirm']).toEqual([
      { module: 'sale', kind: 'definition' },
      { module: 'sale_hold', kind: 'override' },
    ]);
    const state = order.model.describe().fields['state'];
    const selection = (state?.['selection'] ?? []) as string[][];
    expect(selection.map(([k]) => k)).toContain('hold');
    expect(state?.['transitions']).toMatchObject({ resume: { from: ['hold'], to: 'sale' } });
  });

  test('additions need an extensible field and must reference known states', () => {
    const Closed = defineModel('x.closed', {
      fields: { state: f.state({ states: { a: 'A' }, initial: 'a', transitions: {} }) },
    });
    const closed = defineModule({ name: 'closed', depends: [base], models: [Closed] });
    const ext = extendModel('x.closed', { fieldOverrides: { state: { statesAdd: { b: 'B' } } } });
    expect(() =>
      buildRegistry({
        modules: [
          defineModule({ name: 'closed_ext', depends: [closed], models: [], extensions: [ext] }),
        ],
      }),
    ).toThrow(InvalidExtensionError);

    const bad = extendModel('sale.order', {
      fieldOverrides: { state: { transitionsAdd: { fly: { from: ['sale'], to: 'moon' } } } },
    });
    expect(() =>
      buildRegistry({
        modules: [
          defineModule({ name: 'sale_bad', depends: [sale], models: [], extensions: [bad] }),
        ],
      }),
    ).toThrow(/unknown state/);

    const dup = extendModel('sale.order', {
      fieldOverrides: { state: { transitionsAdd: { confirm: { from: ['sale'], to: 'cancel' } } } },
    });
    expect(() =>
      buildRegistry({
        modules: [
          defineModule({ name: 'sale_dup', depends: [sale], models: [], extensions: [dup] }),
        ],
      }),
    ).toThrow(/already exists/);
  });
});
