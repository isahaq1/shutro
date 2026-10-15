import { describe, expect, test } from 'vitest';
import {
  buildRegistry,
  defineModel,
  defineModule,
  ExtensionConflictError,
  extendModel,
  f,
  InvalidExtensionError,
  isExtension,
  type ModuleBase,
  replace,
  type ShutroError,
  UndeclaredDependencyError,
  UnknownModelError,
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

/** sale: a model with a method; stock: an unrelated model. */
function world(): { b: ModuleBase; sale: ModuleBase; stock: ModuleBase } {
  const b = base();
  const sale = defineModule({
    name: 'sale',
    depends: [b],
    models: [
      defineModel('sale.order', {
        companyScoped: { required: true },
        fields: {
          name: f.char({ required: true }),
          partner: f.many2one('res.partner', { required: true }),
          state: f.selection(
            { draft: 'Quotation', sale: 'Sales Order' },
            { required: true, default: 'draft', extensible: true },
          ),
          kind: f.selection({ a: 'A' }),
        },
        methods: {
          confirm(): string {
            return 'confirmed';
          },
          label(prefix: string): string {
            return `${prefix}:sale`;
          },
        },
      }),
    ],
  });
  const stock = defineModule({
    name: 'stock',
    depends: [b],
    models: [defineModel('stock.warehouse', { fields: { name: f.char({ required: true }) } })],
  });
  return { b, sale, stock };
}

describe('extendModel', () => {
  test('returns a frozen extension', () => {
    const ext = extendModel('sale.order', { fields: { note: f.text() } });
    expect(isExtension(ext)).toBe(true);
    expect(Object.isFrozen(ext)).toBe(true);
    expect(ext.name).toBe('sale.order');
    expect(Object.keys(ext.fields)).toEqual(['note']);
  });

  test('validates locally: model name, field keys, descriptors, override functions', () => {
    caught(() => extendModel('SaleOrder', { fields: {} }), InvalidExtensionError);
    caught(
      () => extendModel('sale.order', { fields: { snake_case: f.char() } }),
      InvalidExtensionError,
    );
    caught(
      () => extendModel('sale.order', { fields: { id: f.char() } as never }),
      InvalidExtensionError,
    );
    caught(
      () => extendModel('sale.order', { fields: { x: { kind: 'char' } } as never }),
      InvalidExtensionError,
    );
    caught(
      () => extendModel('sale.order', { overrides: { confirm: 'nope' } as never }),
      InvalidExtensionError,
    );
  });
});

describe('registry: applying extensions', () => {
  test('fields, methods and overrides are merged in load order; origins and layers are recorded', () => {
    const { b, sale, stock } = world();
    const saleStock = defineModule({
      name: 'sale_stock',
      depends: [sale, stock],
      models: [],
      extensions: [
        extendModel('sale.order', {
          fields: {
            warehouse: f.many2one('stock.warehouse', { required: true, default: () => 1 as never }),
          },
          methods: {
            createPickings(): string {
              return 'pickings';
            },
          },
          overrides: {
            confirm(next: () => string): string {
              return `stock(${next()})`;
            },
          },
        }),
      ],
    });
    const saleMargin = defineModule({
      name: 'sale_margin',
      depends: [sale],
      models: [],
      extensions: [
        extendModel('sale.order', {
          fields: { margin: f.decimal({ scale: 2 }) },
          overrides: {
            confirm(next: () => string): string {
              return `margin(${next()})`;
            },
            label(next: (prefix: string) => string, prefix: string): string {
              return `${next(prefix)}+margin`;
            },
          },
        }),
      ],
    });
    const registry = buildRegistry({ modules: [saleStock, saleMargin] });
    expect(registry.loadOrder).toEqual(['base', 'sale', 'sale_margin', 'stock', 'sale_stock']);

    const { model, module, extensions, fieldOrigins, methodLayers } = registry.get('sale.order');
    expect(module).toBe('sale');
    expect(extensions).toEqual(['sale_margin', 'sale_stock']);
    expect(Object.keys(model.fields)).toContain('warehouse');
    expect(model.columns['warehouse']).toBe('warehouse_id');
    expect(model.columns['margin']).toBe('margin');
    expect(fieldOrigins['name']).toBe('sale');
    expect(fieldOrigins['margin']).toBe('sale_margin');
    expect(fieldOrigins['warehouse']).toBe('sale_stock');
    expect(fieldOrigins['id']).toBe('sale');

    // Outermost layer runs first: sale_stock wraps sale_margin wraps sale.
    const methods = model.methods as {
      confirm: () => string;
      label: (p: string) => string;
      createPickings: () => string;
    };
    expect(methods.confirm()).toBe('stock(margin(confirmed))');
    expect(methods.label('x')).toBe('x:sale+margin');
    expect(methods.createPickings()).toBe('pickings');
    expect(methodLayers['confirm']?.map((l) => `${l.module}:${l.kind}`)).toEqual([
      'sale:definition',
      'sale_margin:override',
      'sale_stock:override',
    ]);
    expect(methodLayers['createPickings']).toEqual([{ module: 'sale_stock', kind: 'definition' }]);
    expect(registry.explain('sale.order', 'confirm').map((l) => l.module)).toEqual([
      'sale',
      'sale_margin',
      'sale_stock',
    ]);

    const d = registry.describe('sale.order');
    expect(d.fields['warehouse']?.origin).toEqual({ module: 'sale_stock' });
    expect(d.extensions).toEqual(['sale_margin', 'sale_stock']);
    expect(d.methodLayers['confirm']).toEqual([
      { module: 'sale', kind: 'definition' },
      { module: 'sale_margin', kind: 'override' },
      { module: 'sale_stock', kind: 'override' },
    ]);
    void b;
  });

  test('replace() drops the previous implementation and is recorded as such', () => {
    const { sale } = world();
    const m = defineModule({
      name: 'm',
      depends: [sale],
      models: [],
      extensions: [
        extendModel('sale.order', { overrides: { confirm: replace(() => 'replaced') } }),
      ],
    });
    const registry = buildRegistry({ modules: [m] });
    expect((registry.get('sale.order').model.methods as { confirm: () => string }).confirm()).toBe(
      'replaced',
    );
    expect(registry.explain('sale.order', 'confirm').map((l) => l.kind)).toEqual([
      'definition',
      'replace',
    ]);
  });

  test('fieldOverrides: allowed attributes, required tightening with a default, selectionAdd on extensible selections', () => {
    const { sale } = world();
    const m = defineModule({
      name: 'm',
      depends: [sale],
      models: [],
      extensions: [
        extendModel('sale.order', {
          fieldOverrides: {
            name: { label: 'Reference', help: 'Document number', index: true },
            partner: { tracking: true },
            state: { selectionAdd: { done: 'Locked' } },
            kind: { required: true, default: 'a' },
          },
        }),
      ],
    });
    const registry = buildRegistry({ modules: [m] });
    const { model } = registry.get('sale.order');
    expect(model.fields['name']).toMatchObject({
      label: 'Reference',
      help: 'Document number',
      index: true,
      required: true,
    });
    expect(model.fields['partner']?.tracking).toBe(true);
    const state = model.fields['state'] as unknown as {
      selection: readonly (readonly [string, string])[];
    };
    expect(state.selection.map(([k]) => k)).toEqual(['draft', 'sale', 'done']);
    expect(model.fields['kind']).toMatchObject({ required: true, default: 'a' });
  });
});

describe('registry: view-safety rules and conflicts (RFC 0002 §7.5, §7.6)', () => {
  const extend = (
    name: string,
    def: Parameters<typeof extendModel>[1],
    depends: readonly ModuleBase[],
  ): ModuleBase =>
    defineModule({ name, depends, models: [], extensions: [extendModel('sale.order', def)] });

  test('S1: a new required field needs a default or a compute', () => {
    const { sale } = world();
    const e = caught(
      () =>
        buildRegistry({
          modules: [extend('m', { fields: { code: f.char({ required: true }) } }, [sale])],
        }),
      InvalidExtensionError,
    );
    expect(e.message).toContain("'code'");
    expect(e.hint).toMatch(/default|compute/);
    buildRegistry({
      modules: [
        extend('m', { fields: { code: f.char({ required: true, default: 'x' }) } }, [sale]),
      ],
    });
    buildRegistry({
      modules: [
        extend('m', { fields: { code: f.char({ required: true, compute: () => undefined }) } }, [
          sale,
        ]),
      ],
    });
  });

  test('S2: required can only be tightened, and only with a default', () => {
    const { sale } = world();
    caught(
      () =>
        buildRegistry({
          modules: [extend('m', { fieldOverrides: { partner: { required: false } } }, [sale])],
        }),
      InvalidExtensionError,
    );
    caught(
      () =>
        buildRegistry({
          modules: [extend('m', { fieldOverrides: { kind: { required: true } } }, [sale])],
        }),
      InvalidExtensionError,
    );
  });

  test('S5: selectionAdd only on extensible selections', () => {
    const { sale } = world();
    caught(
      () =>
        buildRegistry({
          modules: [
            extend('m', { fieldOverrides: { kind: { selectionAdd: { b: 'B' } } } }, [sale]),
          ],
        }),
      InvalidExtensionError,
    );
  });

  test('S7/S8: unknown override target, overriding an existing method through `methods`, overriding a field through `fields`', () => {
    const { sale } = world();
    caught(
      () =>
        buildRegistry({
          modules: [extend('m', { overrides: { nope: (next: () => void) => next() } }, [sale])],
        }),
      InvalidExtensionError,
    );
    caught(
      () => buildRegistry({ modules: [extend('m', { methods: { confirm: () => 'x' } }, [sale])] }),
      ExtensionConflictError,
    );
    caught(
      () => buildRegistry({ modules: [extend('m', { fields: { name: f.text() } }, [sale])] }),
      ExtensionConflictError,
    );
    caught(
      () =>
        buildRegistry({
          modules: [extend('m', { fieldOverrides: { nope: { label: 'x' } } }, [sale])],
        }),
      InvalidExtensionError,
    );
  });

  test('two independent modules adding the same field or method is a conflict naming both', () => {
    const { sale } = world();
    const a = extend('a', { fields: { margin: f.decimal({ scale: 2 }) } }, [sale]);
    const c = extend('c', { fields: { margin: f.decimal({ scale: 2 }) } }, [sale]);
    const e = caught(() => buildRegistry({ modules: [a, c] }), ExtensionConflictError);
    expect(e.message).toContain("'a'");
    expect(e.message).toContain("'c'");
    const m1 = extend('m1', { methods: { go: () => 1 } }, [sale]);
    const m2 = extend('m2', { methods: { go: () => 2 } }, [sale]);
    caught(() => buildRegistry({ modules: [m1, m2] }), ExtensionConflictError);
  });

  test('extending a model of a module you do not depend on, or that does not exist', () => {
    const { b, sale } = world();
    const notDependent = defineModule({
      name: 'n',
      depends: [b],
      models: [],
      extensions: [extendModel('sale.order', { fields: { x: f.char() } })],
    });
    caught(() => buildRegistry({ modules: [sale, notDependent] }), UndeclaredDependencyError);
    const missing = defineModule({
      name: 'n',
      depends: [b],
      models: [],
      extensions: [extendModel('no.model', { fields: { x: f.char() } })],
    });
    caught(() => buildRegistry({ modules: [missing] }), UnknownModelError);
  });

  test('cross-model checks run on extension fields too', () => {
    const { sale } = world();
    const e = caught(
      () =>
        buildRegistry({
          modules: [extend('m', { fields: { product: f.many2one('product.product') } }, [sale])],
        }),
      UnknownModelError,
    );
    expect(e.message).toContain("'product.product'");
  });
});
