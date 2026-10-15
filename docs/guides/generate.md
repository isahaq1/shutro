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

## Typed definition callbacks

The bindings also export `compute`, `check`, `onchange`, `records` and `method`, typed against the module's view, so
definitions need no casts:

```ts
import { check, compute, defineModel, f, method, onchange, records } from './.shutro/bindings.ts';

const amounts = compute('sale.order', ['amountUntaxed', 'amountTax', 'amountTotal'], ['lines.subtotal', 'lines.taxAmount'], (orders) => {
  for (const o of orders) {
    o.amountUntaxed = o.lines.sum('subtotal', o.currency); // lines loaded with subtotal: typed from depends
    o.amountTax = o.lines.sum('taxAmount', o.currency);
    o.amountTotal = o.amountUntaxed.plus(o.amountTax);
  }
});

export const SaleOrder = defineModel('sale.order', {
  fields: {
    amountUntaxed: f.monetary({ currency: 'currency', store: true, ...amounts }),
    // ...
    state: f.state({ /* ... */ transitions: { confirm: { from: ['draft'], to: 'sale',
      guard: records('sale.order', async (orders) => (await orders.load({ lines: true })).filter((o) => o.lines.length === 0)) } } }),
  },
  onchange: { partner: onchange('sale.order', async (d) => { const p = await d.record('partner'); if (p?.currency) d.set('currency', p.currency.id); }) },
  constraints: { positive: { ...check('sale.order', ['amountTotal'], (orders) => orders.filter((o) => o.amountTotal?.isNegative() === true)), message: 'Totals cannot be negative.' } },
  methods: {
    createInvoices: method('sale.order', async function (): Promise<number> { return (await this.load()).length; }),
  },
});
```

- `compute(model, assigns, depends, fn)`: records are loaded along `depends` (`'lines.subtotal'` types `o.lines` with
  `subtotal`); only `assigns` are writable, other computed fields read with their read type.
- Callback records have fields and the recordset API, not the model's methods (naming them would make the
  definition depend on itself, TS7022). `method()` bodies have them; annotate a method's return type.
- Methods, transitions and transitions added by extensions are typed in the view (`SaleOrderMethods`).
- The definitions hash covers only what the types depend on, so labels, indexes or security metadata do not churn
  the generated files.

## In the repository

Commit `shutro.config.ts`; git-ignore `.shutro/` in applications and regenerate in `postinstall` and CI
(`shutro generate --check`). Published module packages should ship their `.shutro/` declarations so consumers get
types without running the generator on someone else's sources.

## Running it

The generator imports the module files at runtime (definitions must be side-effect free). Node 24+ runs `.ts` files
natively; the CLI registers a resolve hook so the `./module.js` specifiers of `moduleResolution: nodenext` find the
`.ts` sources, and `.ts` specifiers work too. No loader is needed.

## Not yet

`paths` (depth-limited dotted paths for `depends` / `related`), `--watch`, and the stale-hash warning from
`buildRegistry` in development.
