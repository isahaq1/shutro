import { describe, expect, test } from 'vitest';
import { isLangCode, isTranslations, mergeTranslation, resolveTranslation } from '../src/index.js';

describe('resolveTranslation', () => {
  const value = { en_US: 'Laptop', bn_BD: 'ল্যাপটপ' };
  test('the language, then the source, then the first translation, then null', () => {
    expect(resolveTranslation(value, 'bn_BD', 'en_US')).toBe('ল্যাপটপ');
    expect(resolveTranslation(value, 'fr_FR', 'en_US')).toBe('Laptop');
    expect(resolveTranslation({ fr_FR: 'Portable' }, 'bn_BD', 'en_US')).toBe('Portable');
    expect(resolveTranslation({ zz: 'z', aa: 'a' }, 'bn_BD', 'en_US')).toBe('a');
    expect(resolveTranslation({}, 'bn_BD', 'en_US')).toBeNull();
    expect(resolveTranslation(null, 'bn_BD', 'en_US')).toBeNull();
  });
});

describe('mergeTranslation', () => {
  test('a string sets the language and fills an empty source', () => {
    expect(mergeTranslation(null, 'Laptop', 'en_US', 'en_US')).toEqual({ en_US: 'Laptop' });
    expect(mergeTranslation(null, 'ল্যাপটপ', 'bn_BD', 'en_US')).toEqual({
      en_US: 'ল্যাপটপ',
      bn_BD: 'ল্যাপটপ',
    });
    expect(mergeTranslation({ en_US: 'Laptop' }, 'ল্যাপটপ', 'bn_BD', 'en_US')).toEqual({
      en_US: 'Laptop',
      bn_BD: 'ল্যাপটপ',
    });
  });
  test('a map sets what it names and keeps the rest', () => {
    expect(
      mergeTranslation(
        { en_US: 'Laptop', bn_BD: 'x' },
        { bn_BD: 'ল্যাপটপ', fr_FR: 'Portable' },
        'en_US',
        'en_US',
      ),
    ).toEqual({
      en_US: 'Laptop',
      bn_BD: 'ল্যাপটপ',
      fr_FR: 'Portable',
    });
  });
});

describe('validation', () => {
  test('language codes and translation maps', () => {
    expect(isLangCode('en_US')).toBe(true);
    expect(isLangCode('fr')).toBe(true);
    expect(isLangCode('en-US')).toBe(false);
    expect(isTranslations({ en_US: 'x' })).toBe(true);
    expect(isTranslations({ 'en-US': 'x' })).toBe(false);
    expect(isTranslations({ en_US: 1 })).toBe(false);
    expect(isTranslations(['x'])).toBe(false);
  });
});
