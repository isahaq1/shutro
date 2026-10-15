# Modules and the registry

Business software ships as modules ([RFC 0002](../rfcs/0002-module-registry-and-model-extension.md)): `base`,
`product`, `sale`, `stock`, `sale_stock`, ... A module declares what it depends on and which models it owns. The
registry loads modules in dependency order and runs the checks that need every model at once.

```ts
import { buildRegistry, defineModule } from '@shutro/core';
import base from './base/module.js';
import { SaleOrder, SaleOrderLine } from './models/index.js';

export const sale = defineModule({
  name: 'sale',
  version: '1.0.0',
  depends: [base],               // module objects, not names: a typo can't compile, and a cycle can't be written
  models: [SaleOrder, SaleOrderLine],
});

const registry = buildRegistry({ modules: [sale] });   // dependencies are collected transitively
registry.loadOrder;              // ['base', 'sale']
registry.get('sale.order');      // { model, module: 'sale' }
registry.describe('sale.order'); // ModelDescription plus origin: { module } on the model and every field
```

## Load order

Kahn's algorithm over the dependency graph, taking the smallest module name whenever several modules are ready.
The order is a pure function of the module set, so two installations with the same modules behave the same.

## What the registry checks

| Check | Error |
| ----- | ----- |
| Two different module objects with the same name (two package versions) | `DuplicateModuleError` |
| The same model name in two modules | `DuplicateModelError`, naming both |
| A relation (`many2one`, `one2many`, `many2many`) to a model nobody defines, including the implicit `res.users`, `res.company`, `res.currency` targets | `UnknownModelError` |
| A relation to a model owned by a module you don't depend on | `UndeclaredDependencyError`: "add `stock` to the depends of `sale_margin`" |
| A `one2many` whose inverse isn't a `many2one` back to the model | `InvalidRelationError` |
| A `depends` path that doesn't resolve (`lines.subtota`, `name.length`) | `InvalidDependsPathError`, listing the fields of the model where it broke |

Every registry therefore needs a `base` module that defines `res.users`, `res.company` and `res.currency`.

## Extending a model from another module

```ts
// modules/sale_stock/models/sale_order.ts
export const SaleOrderStock = extendModel('sale.order', {
  fields: {
    warehouse: f.many2one('stock.warehouse', { required: true, default: (env) => defaultWarehouse(env) }),
    pickings: f.one2many('stock.picking', 'saleOrder'),
  },
  fieldOverrides: {
    partner: { tracking: true },
    state: { selectionAdd: { delivered: 'Delivered' } },   // only on fields the owner declared extensible
  },
  methods: { createPickings(): Promise<void> { ... } },
  overrides: {
    async confirm(next): Promise<void> {   // next = the previous implementation, bound to this
      await next();
      await this.createPickings();
    },
  },
});

export default defineModule({ name: 'sale_stock', depends: [sale, stock], models: [], extensions: [SaleOrderStock] });
```

The registry applies extensions in load order and rebuilds each extended model through `defineModel`, so every
model-level check also covers the extended model. Overrides stack in load order: with `sale_margin` and
`sale_stock` both overriding `confirm`, the call runs `sale_stock → sale_margin → sale`. `replace(fn)` drops the
previous layers deliberately and is reported as such.

Extension fields are part of the model's type in the registry's schema view, so `env.model('sale.order')` knows
`warehouse` without a generator.

### View-safety rules (RFC 0002 §7.5)

Code compiled against a module's view must keep working after other modules are installed. The registry enforces:

| Rule | Error |
| ---- | ----- |
| A new required field needs a default or a compute | `InvalidExtensionError` |
| `required` can only be tightened, and only with a default | `InvalidExtensionError` |
| `selectionAdd` only on fields declared `extensible: true` | `InvalidExtensionError` |
| `fieldOverrides` may change label, help, default, index, tracking, copy, groups, required, selectionAdd; never kind, column, store or target | `InvalidExtensionError` |
| Overriding a field through `fields`, or a method through `methods` | `ExtensionConflictError` ("use fieldOverrides" / "use overrides") |
| Two modules that don't depend on each other add the same field or method | `ExtensionConflictError`, naming both |
| Overriding a method that doesn't exist | `InvalidExtensionError` |
| Extending a model of a module you don't depend on | `UndeclaredDependencyError` |

### Schema explorer

`registry.describe('sale.order')` reports `origin.module` for the model and for every field, the `extensions` that
touched it, and `methodLayers` (definition, overrides and replacements per method). `registry.explain('sale.order',
'confirm')` returns the layers of one method, innermost first, which is what `shutro inspect` will print.

## Versions and data migrations

A module's `version` is recorded in the database by `@shutro/migrate`; raising it runs the module's `migrations` hooks
on upgrade. See the [migrations guide](./migrations.md).

## Not yet

Mixins, module-contributed flags, and the generated per-module type views (`shutro generate`) are still to come.
