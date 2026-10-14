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

## Not yet

Extensions (`extendModel`), method overrides, mixins, module-contributed flags, and the generated per-module type
views are the second half of RFC 0002.
