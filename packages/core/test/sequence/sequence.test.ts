/**
 * Sequence declarations (RFC 0012 §7.1, §8): registry index, validation, types.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  buildRegistry,
  type CreateValues,
  defineModel,
  defineModule,
  defineSequence,
  f,
  InvalidFieldError,
  InvalidModuleError,
  type SequenceKeys,
  UnknownSequenceError,
} from '../../src/index.js';
import { base, registry, type S, sale } from './fixtures.js';

describe('sequence declarations', () => {
  test('the registry indexes sequences by code; fields are validated against them', () => {
    expect([...registry.sequences.keys()].sort()).toEqual(['account.move', 'sale.order']);
    expect(registry.describe('account.move').fields['name']?.sequence).toEqual({
      code: 'account.move',
      gapless: true,
      on: 'manual',
      dateField: 'date',
    });
    expectTypeOf<SequenceKeys<S, 'sale.order'>>().toEqualTypeOf<'name'>();
    expectTypeOf<CreateValues<S, 'sale.order'>>().not.toHaveProperty('name'); // readonly + sequence
  });

  test('an undeclared code, a duplicate code and a gapless mismatch are build errors', () => {
    const Typo = defineModel('x.typo', { fields: { name: f.char({ sequence: 'sale.ordr' }) } });
    expect(() =>
      buildRegistry({ modules: [defineModule({ name: 'typo', depends: [sale], models: [Typo] })] }),
    ).toThrow(UnknownSequenceError);

    const dup = defineModule({
      name: 'dup',
      depends: [sale],
      sequences: [defineSequence({ code: 'sale.order' })],
      models: [],
    });
    expect(() => buildRegistry({ modules: [dup], security: { enforce: false } })).toThrow(
      InvalidModuleError,
    );

    const Mismatch = defineModel('x.mismatch', {
      fields: { name: f.char({ sequence: { code: 'sale.order', gapless: true } }) },
    });
    expect(() =>
      buildRegistry({
        modules: [defineModule({ name: 'mismatch', depends: [sale], models: [Mismatch] })],
      }),
    ).toThrow(/gapless/);

    const BadDate = defineModel('x.date', {
      fields: { name: f.char({ sequence: { code: 'sale.order', dateField: 'when' } }) },
    });
    expect(() =>
      buildRegistry({
        modules: [defineModule({ name: 'baddate', depends: [sale, base], models: [BadDate] })],
      }),
    ).toThrow(/dateField/);
  });

  test('field options are validated', () => {
    expect(() => f.char({ sequence: { code: 'x', on: 'later' as never } })).toThrow(
      InvalidFieldError,
    );
    expect(() => f.char({ sequence: { code: 'x', dateField: 'Not Camel' } })).toThrow(
      InvalidFieldError,
    );
  });
});
