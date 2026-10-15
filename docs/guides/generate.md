# Generated type views (`shutro generate`)

A module's code must only see the models and fields of the modules it depends on
([RFC 0002 §7.7](../rfcs/0002-module-registry-and-model-extension.md)). `shutro generate` writes that view for each
module, and the application view for application code, as plain interfaces under `.shutro/`.

```ts
// shutro.config.ts
import { defineConfig } from '@shutro/cli';

export default defineConfig({
  modules: ['./modules/base/module.ts', './modules/sale/module.ts', './modules/sale_stock/module.ts'],
  app: './app',
});
```

```
shutro generate            # writes every stale file
shutro generate --check    # exit 1 when a file is missing or stale (CI); writes nothing
```

Each module file must export exactly one `defineModule(...)`, and every module in the dependency graph must be
listed, since views import method types from the sources.

## What is written

```
modules/sale_stock/.shutro/
  schema.d.ts      interface SchemaView { 'sale.order': SaleOrder; 'stock.warehouse': StockWarehouse; ... }
  bindings.ts      defineModel / extendModel / f re-exported, plus Env, Shutro, Records<M>, ModelName typed to the view
app/.shutro/
  schema.d.ts      the application view: every installed module
  index.ts         createShutro() whose environments are typed to the application view
```

A model in a view:

```ts
/** `sale.order` (owner: sale; extended by: sale_stock). */
export interface SaleOrder {
  readonly name: 'sale.order';
  readonly fields: {
    readonly id: F.Id<'sale.order'>;
    readonly partner: F.Many2one<'res.partner', { readonly required: true }>;
    readonly amountTotal: F.Monetary<'currency', { readonly readonly: true; readonly compute: 'computeAmounts'; readonly store: true }>;
    readonly warehouse: F.Many2one<'stock.warehouse', { readonly required: true; readonly default: true }>; // sale_stock
  };
  readonly methods: F.Methods<typeof import('../../sale/module.js').sale, 'sale.order'> &
    F.Methods<typeof import('../module.js').saleStock, 'sale.order'>;
}
```

- **Fields are interfaces, not inference.** `F.*` (exported by `@shutro/core`) spells a field with the builders' option
  vocabulary, and the result is *identical* to the declared field's type, so a generated view and the inferred
  `SchemaOfModules<...>` are interchangeable. Relations refer to models by name and resolve through `SchemaView`, so
  cycles cost nothing.
- **Methods come from the sources** through `typeof import(...)`, one term per module that contributes to the model.
  TypeScript 7 has no compiler API to print signatures, so this is the RFC's fallback: declare parameter and return
  types on methods, and the view carries them.
- **The definitions hash** in the header changes whenever a model, field, method layer or module version in the view
  changes. `--check` compares the whole file, so CI fails on stale output.

## Using a view

```ts
// modules/sale_stock/models/sale_order.ts
import { extendModel, f } from '../.shutro/bindings.js';
import type { Env, Records } from '../.shutro/bindings.js';

export async function ship(env: Env, orders: Records<'sale.order'>): Promise<void> {
  for (const order of orders) order.warehouse; // typed: sale_stock sees its own extension
}
```

Application code imports `createShutro`, `Env` and `Records` from `app/.shutro/index.js` and sees every module.

## In the repository

Commit `shutro.config.ts`; git-ignore `.shutro/` in applications and regenerate in `postinstall` and CI
(`shutro generate --check`). Published module packages should ship their `.shutro/` declarations so consumers get
types without running the generator on someone else's sources.

## Running it

The generator imports the module files at runtime (definitions must be side-effect free). Node 24+ runs `.ts` files
natively, but it does not rewrite the `./module.js` specifiers that `moduleResolution: nodenext` requires between
TypeScript sources, so run `shutro generate` through a loader (`node --import tsx node_modules/.bin/shutro generate`),
against compiled output, or with `rewriteRelativeImportExtensions` and `.ts` specifiers. Vitest and tsx handle it
transparently.

## Not yet

`paths` (depth-limited dotted paths for `depends` / `related`), `--watch`, and the stale-hash warning from
`buildRegistry` in development.
