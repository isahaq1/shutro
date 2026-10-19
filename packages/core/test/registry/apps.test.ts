/**
 * App metadata on modules (RFC 0019 §7.1): defaults, validation, and the application / autoInstall exclusion.
 */
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  defineModel,
  defineModule,
  f,
  InvalidModuleError,
  type ModuleBase,
  type ShutroError,
} from '../../src/index.js';
import { base } from './fixtures.js';

function caught<E extends ShutroError>(fn: () => unknown, Class: new (...args: never[]) => E): E {
  try {
    fn();
  } catch (e) {
    if (e instanceof Class) {
      expect(e.message).toContain(e.hint);
      return e;
    }
    throw e;
  }
  throw new Error(`expected ${Class.name}`);
}

const b = base();
const order = (name: string) => defineModel(name, { fields: { name: f.char({ required: true }) } });

describe('app metadata', () => {
  test('technical modules by default', () => {
    expect(b).toMatchObject({
      application: false,
      autoInstall: false,
      required: false,
      icon: undefined,
      glyph: undefined,
      category: 'Technical',
      summary: '',
    });
  });

  test('an application carries its storefront details', () => {
    const purchase = defineModule({
      name: 'purchase',
      version: '1.0.0',
      label: 'Purchase',
      application: true,
      icon: new URL('./icons/purchase.svg', import.meta.url),
      glyph: '🛒',
      category: 'Inventory & Purchasing',
      summary: 'Requests for quotation, purchase orders, vendor bills',
      depends: [b],
      models: [order('purchase.order')],
    });
    expect(purchase.application).toBe(true);
    expect(purchase.icon).toMatch(/^file:.*\/icons\/purchase\.svg$/);
    expect(purchase.glyph).toBe('🛒');
    expect(purchase.category).toBe('Inventory & Purchasing');
    expect(defineModule({ name: 'crm', application: true, models: [] }).category).toBe('Other');
  });

  test('inline SVG icons are accepted up to 64 KB', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    expect(defineModule({ name: 'a', icon: svg, models: [] }).icon).toBe(svg);
    const huge = `<svg>${'x'.repeat(64 * 1024)}</svg>`;
    caught(() => defineModule({ name: 'a', icon: huge, models: [] }), InvalidModuleError);
  });

  test('icons must be SVG', () => {
    const e = caught(
      () => defineModule({ name: 'a', icon: './icon.png', models: [] }),
      InvalidModuleError,
    );
    expect(e.message).toContain('not an SVG');
  });

  test('glyphs are short', () => {
    caught(() => defineModule({ name: 'a', glyph: 'purchase', models: [] }), InvalidModuleError);
  });

  test('autoInstall glues two or more modules and is never an application', () => {
    const sale = defineModule({ name: 'sale', application: true, depends: [b], models: [] });
    const purchase = defineModule({
      name: 'purchase',
      application: true,
      depends: [b],
      models: [],
    });
    const glue = defineModule({
      name: 'sale_purchase',
      autoInstall: true,
      depends: [sale, purchase],
      models: [],
    });
    expect(glue.autoInstall).toBe(true);
    caught(
      () => defineModule({ name: 'x', autoInstall: true, depends: [sale], models: [] }),
      InvalidModuleError,
    );
    caught(
      () =>
        defineModule({
          name: 'x',
          ...({ application: true, autoInstall: true } as unknown as { application: true }),
          depends: [sale, purchase],
          models: [],
        }),
      InvalidModuleError,
    );
  });

  test('uninstall blockers must be functions', () => {
    caught(
      () => defineModule({ name: 'a', uninstall: { blockers: 'no' as never }, models: [] }),
      InvalidModuleError,
    );
    const blockers = async () => [];
    expect(
      defineModule({ name: 'a', uninstall: { blockers }, models: [] }).uninstall.blockers,
    ).toBe(blockers);
  });

  test('types: an application cannot be autoInstall', () => {
    const both = () =>
      // @ts-expect-error application and autoInstall exclude each other
      defineModule({ name: 'x', application: true, autoInstall: true, models: [] });
    expect(both).toThrow(InvalidModuleError);
    expectTypeOf<ModuleBase['application']>().toEqualTypeOf<boolean>();
    expectTypeOf<ModuleBase['icon']>().toEqualTypeOf<string | undefined>();
  });
});
