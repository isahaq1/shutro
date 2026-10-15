import { describe, expect, test } from 'vitest';
import {
  buildRegistry,
  DuplicateModelError,
  DuplicateModuleError,
  defineModel,
  defineModule,
  f,
  InvalidDependsPathError,
  InvalidModuleError,
  InvalidRelationError,
  isModule,
  type ShutroError,
  UndeclaredDependencyError,
  UnknownModelError,
} from '../../src/index.js';
import { base, baseModels, saleModule } from './fixtures.js';

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

describe('defineModule', () => {
  test('returns a frozen module with defaults', () => {
    const m = defineModule({ name: 'base', models: baseModels() });
    expect(isModule(m)).toBe(true);
    expect(Object.isFrozen(m)).toBe(true);
    expect(m).toMatchObject({ name: 'base', version: '0.0.0', label: 'Base', depends: [] });
    expect(m.models.map((x) => x.name)).toEqual([
      'res.users',
      'res.company',
      'res.currency',
      'res.partner',
    ]);
  });

  test('validates name, depends, models', () => {
    caught(() => defineModule({ name: 'Sale', models: [] }), InvalidModuleError);
    caught(
      () => defineModule({ name: 'sale', depends: [{ name: 'base' } as never], models: [] }),
      InvalidModuleError,
    );
    caught(
      () => defineModule({ name: 'sale', models: [{ name: 'x.y' } as never] }),
      InvalidModuleError,
    );
    caught(
      () =>
        defineModule({
          name: 'sale',
          models: [defineModel('a.b', { fields: {} }), defineModel('a.b', { fields: {} })],
        }),
      DuplicateModelError,
    );
    caught(() => defineModule({ name: 'sale', version: '1', models: [] }), InvalidModuleError);
  });
});

describe('buildRegistry: load order', () => {
  test('topological order with alphabetical tie-break; transitive dependencies are collected', () => {
    const b = base();
    const uom = defineModule({ name: 'uom', depends: [b], models: [] });
    const product = defineModule({ name: 'product', depends: [uom], models: [] });
    const account = defineModule({ name: 'account', depends: [product], models: [] });
    const stock = defineModule({ name: 'stock', depends: [product], models: [] });
    const sale = defineModule({ name: 'sale', depends: [account], models: [] });
    const saleStock = defineModule({ name: 'sale_stock', depends: [sale, stock], models: [] });
    const saleMargin = defineModule({ name: 'sale_margin', depends: [sale], models: [] });
    const registry = buildRegistry({
      modules: [saleStock, saleMargin],
      security: { enforce: false },
    });
    // Kahn's algorithm, smallest name first: after 'sale', both 'sale_margin' and 'stock' are ready.
    expect(registry.loadOrder).toEqual([
      'base',
      'uom',
      'product',
      'account',
      'sale',
      'sale_margin',
      'stock',
      'sale_stock',
    ]);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  test('two different module objects with the same name is an error', () => {
    const b1 = base();
    const b2 = base();
    const a = defineModule({ name: 'a', depends: [b1], models: [] });
    const c = defineModule({ name: 'c', depends: [b2], models: [] });
    const e = caught(
      () => buildRegistry({ modules: [a, c], security: { enforce: false } }),
      DuplicateModuleError,
    );
    expect(e.message).toContain("'base'");
  });

  test('the same model name in two modules is an error naming both', () => {
    const b = base();
    const m1 = defineModule({
      name: 'm1',
      depends: [b],
      models: [defineModel('x.y', { fields: {} })],
    });
    const m2 = defineModule({
      name: 'm2',
      depends: [b],
      models: [defineModel('x.y', { fields: {} })],
    });
    const e = caught(
      () => buildRegistry({ modules: [m1, m2], security: { enforce: false } }),
      DuplicateModelError,
    );
    expect(e.message).toMatch(/m1.*m2|m2.*m1/);
  });
});

describe('buildRegistry: cross-model checks', () => {
  test('a valid registry resolves relations and depends paths', () => {
    const b = base();
    const registry = buildRegistry({ modules: [saleModule([b])] });
    expect(registry.has('sale.order')).toBe(true);
    expect(registry.get('sale.order').module).toBe('sale');
    expect(registry.get('res.partner').module).toBe('base');
    expect([...registry.models.keys()]).toEqual([
      'res.users',
      'res.company',
      'res.currency',
      'res.partner',
      'sale.order',
      'sale.order.line',
    ]);
    expect(registry.describe('sale.order')).toMatchObject({
      name: 'sale.order',
      origin: { module: 'sale' },
    });
    expect(registry.describe('sale.order').fields['partner']).toMatchObject({
      target: 'res.partner',
      origin: { module: 'sale' },
    });
  });

  test('get() on an unknown model is a typed error', () => {
    const registry = buildRegistry({ modules: [base()], security: { enforce: false } });
    caught(() => registry.get('sale.order'), UnknownModelError);
  });

  test('a relation to a model nobody defines', () => {
    const b = base();
    const m = defineModule({
      name: 'm',
      depends: [b],
      models: [defineModel('x.y', { fields: { product: f.many2one('product.product') } })],
    });
    const e = caught(
      () => buildRegistry({ modules: [m], security: { enforce: false } }),
      UnknownModelError,
    );
    expect(e.message).toContain("'x.y'");
    expect(e.message).toContain("'product.product'");
  });

  test('the implicit fields need res.users / res.company / res.currency somewhere', () => {
    const lonely = defineModule({ name: 'lonely', models: [defineModel('x.y', { fields: {} })] });
    const e = caught(
      () => buildRegistry({ modules: [lonely], security: { enforce: false } }),
      UnknownModelError,
    );
    expect(e.message).toContain("'res.users'");
  });

  test('referencing a model of a module you do not depend on (RFC 0002 W2)', () => {
    const b = base();
    const stock = defineModule({
      name: 'stock',
      depends: [b],
      models: [defineModel('stock.picking', { fields: {} })],
    });
    const saleMargin = defineModule({
      name: 'sale_margin',
      depends: [b],
      models: [defineModel('sale.margin', { fields: { picking: f.many2one('stock.picking') } })],
    });
    const e = caught(
      () => buildRegistry({ modules: [stock, saleMargin], security: { enforce: false } }),
      UndeclaredDependencyError,
    );
    expect(e.message).toContain("'sale_margin'");
    expect(e.message).toContain("'stock'");
    expect(e.hint).toMatch(/depends/);
  });

  test.each([
    ['missing inverse field', f.one2many('res.partner', 'nope')],
    ['inverse is not a many2one', f.one2many('res.partner', 'name')],
    ['inverse points to another model', f.one2many('res.company', 'currency')],
  ])('one2many: %s', (_label, field) => {
    const b = base();
    const m = defineModule({
      name: 'm',
      depends: [b],
      models: [defineModel('x.y', { fields: { items: field } })],
    });
    const e = caught(
      () => buildRegistry({ modules: [m], security: { enforce: false } }),
      InvalidRelationError,
    );
    expect(e.message).toContain("'items'");
  });

  test.each([
    ['unknown first segment', ['nope']],
    ['unknown nested field', ['lines.subtota']],
    ['traversing a scalar', ['name.length']],
    ['empty path', ['']],
    ['trailing dot', ['lines.']],
  ])('depends path: %s', (_label, depends) => {
    const b = base();
    const m = defineModule({
      name: 'm',
      depends: [b],
      models: [
        defineModel('x.y', {
          fields: {
            name: f.char(),
            lines: f.one2many('x.line', 'parent'),
            total: f.decimal({ scale: 2, depends, compute: () => undefined }),
          },
        }),
        defineModel('x.line', {
          fields: { parent: f.many2one('x.y'), subtotal: f.decimal({ scale: 2 }) },
        }),
      ],
    });
    const e = caught(
      () => buildRegistry({ modules: [m], security: { enforce: false } }),
      InvalidDependsPathError,
    );
    expect(e.message).toContain("'total'");
  });

  test('depends paths may traverse many2one and many2many too', () => {
    const b = base();
    const m = defineModule({
      name: 'm',
      depends: [b],
      models: [
        defineModel('x.y', {
          companyScoped: { required: true },
          fields: {
            partner: f.many2one('res.partner'),
            tags: f.many2many('x.tag'),
            label: f.char({
              depends: ['partner.parent.name', 'tags.name', 'company.currency.name'],
              compute: () => undefined,
            }),
          },
        }),
        defineModel('x.tag', { fields: { name: f.char() } }),
      ],
    });
    expect(buildRegistry({ modules: [m], security: { enforce: false } }).has('x.tag')).toBe(true);
  });
});
