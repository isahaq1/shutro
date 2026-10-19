# RFC 0002 — Module registry & model extension

- **Status:** Accepted (2026-10-14)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** 0001
- **Related:** 0003 (environment), 0004 (recordsets), migrate (Phase 2), CLI (`shutro generate`, `shutro inspect`)

---

## 1. Summary

Business software is shipped as **modules** (`base`, `product`, `sale`, `stock`, `sale_stock`, …). Modules declare their
dependencies, define models, and **extend models owned by other modules**: they add fields, add and override methods,
add constraints, and widen selections and states in a few controlled ways.

At startup, the **registry** loads modules in dependency order, merges definitions into final models, records where
every field and override came from, and freezes the result.

For types, **`shutro generate` emits one typed view per module plus one for the application.** Each module sees exactly
the models and fields contributed by itself and its transitive dependencies, never fields from modules it doesn't
depend on. The application view sees everything installed. Extension rules (§7.5) guarantee that the code of every
module stays type-correct and runtime-correct against the final, fully extended model.

---

## 2. Problem & ERP requirements

Example: `sale_stock` (glue between Sales and Inventory) adds a `warehouse` and `pickings` to `sale.order`, and it
must create deliveries when an order is confirmed. `sale_margin` separately adds a `margin` to orders and lines.
A customer installs both. The original `sale` module knows nothing about either.

| #   | Requirement |
| --- | ----------- |
| R1  | **Extension without editing:** add fields, methods, constraints and indexes to another module's model. |
| R2  | **Behaviour extension:** wrap or override another module's methods, including computes, with a clear call to the previous implementation. |
| R3  | **Dependency-correct types:** code in module X may use only fields and methods from X and its transitive dependencies. Using a field from a module X doesn't depend on is a compile error. |
| R4  | **Final-shape types for applications:** application code, Kosh and the API layer see the fully installed model. |
| R5  | **Deterministic, explainable ordering:** given the same set of modules, the override order is always the same and can be printed. |
| R6  | **Safety under extension:** installing a new module must not break code in existing modules, either at compile time or at runtime (e.g. a new required column that older `create()` calls don't fill in). |
| R7  | **Conflict detection:** two modules adding the same field, or incompatible overrides, fail at startup with a typed error that explains how to fix it, and never silently. |
| R8  | **Reusable behaviour (mixins):** `mail.thread`-style "chatter", `portal.mixin` and `sequence.mixin` are applied to many models. |
| R9  | **Traceability (`CLAUDE.md` principle 4):** every field, method layer and constraint knows its origin module and file. No hidden monkey-patching. |
| R10 | **Only one piece of global mutable state:** the registry, built once and then frozen. |

---

## 3. How Odoo does it

```python
# sale/__manifest__.py
{'name': 'Sales', 'depends': ['sales_team', 'account_payment', 'utm'], ...}

# sale_stock/models/sale_order.py
class SaleOrder(models.Model):
    _inherit = 'sale.order'                     # in-place extension of an existing model

    warehouse_id = fields.Many2one('stock.warehouse', required=True, default=_default_warehouse_id)
    picking_ids = fields.One2many('stock.picking', 'sale_id')

    def _action_confirm(self):
        self.order_line._action_launch_stock_rule()
        return super()._action_confirm()        # next class in the dynamically built MRO
```

Mechanisms:

| Mechanism | Declared as | Effect |
| --------- | ----------- | ------ |
| Classical extension | `_inherit = 'sale.order'` | Mutates the model in place. At registry build Odoo creates a Python class whose MRO stacks every extension in module load order. |
| Prototype copy | `_name = 'new.model'` + `_inherit = 'old.model'` | A new model and table with a copy of the fields and methods. |
| Delegation | `_inherits = {'product.template': 'product_tmpl_id'}` | `product.product` transparently exposes `product.template` fields through a required many2one. |
| Abstract mixins | `models.AbstractModel` (`mail.thread`) | No table. Fields and methods are copied into each inheriting model. Extending the mixin later propagates to the models that use it. |
| Load order | `depends` in the manifest | Topological order. Each database has its own registry, depending on which modules are installed. |

This is Odoo's most important idea. It's why thousands of community modules can coexist. Shutro keeps the model and fixes
its weaknesses.

### Weaknesses

| #  | Weakness | Consequence |
| -- | -------- | ----------- |
| W1 | **No types at all.** `self.picking_ids` is unknown to any tool, and so is the MRO. | IDE completion is heuristic. Refactors break modules you don't know exist. |
| W2 | **Undeclared dependencies "work by accident".** Module X can read `order.margin` without depending on `sale_margin`, and it works whenever `sale_margin` happens to be installed. | Breaks in other customers' databases. A classic Odoo support ticket. |
| W3 | **The MRO is invisible.** Which `_action_confirm` runs first, and who forgot to call `super()`, can only be answered by reading every installed module. | Lost behaviour when an override forgets `super()`. Debugging requires `print` in the MRO. |
| W4 | **Required fields added by extensions** break existing code paths, e.g. a test or a lower module creating `sale.order` without `warehouse_id`. Odoo also fails installation on existing rows unless a default exists. | Install-time failures, or `NotNullViolation` in production. |
| W5 | **Silent field collisions.** Two modules defining the same field name: the last loaded one wins, attributes merge, and the result depends on load order. | Heisenbugs between modules. |
| W6 | **Selection extension (`selection_add`) is unsafe for consumers:** a lower module's `if state == 'sale' … else` now mishandles the new value. | Workflow bugs when a new state is added. |
| W7 | **Monkey-patching is still possible** (assigning methods to classes, `_patch_method`). | Hidden behaviour that violates traceability. |

---

## 4. Prior art

### Prisma

- Multi-file schema (`prismaSchemaFolder`) lets a schema be split across files, but there's no extension. A model is
  declared exactly once, and a second package cannot add a field.
- **Client extensions (`$extends`)** add computed `result` fields, `model` methods and `query` middleware. They're fully
  typed because each `$extends` call returns a new client type, and the chain of types is explicit.
- ✅ Lesson: **"extension returns a new type" keeps typing honest.** Shutro applies the same idea per module (§6).
- ❌ Extensions are client-side only: no new columns, no schema change, and no module dependency graph.

### Drizzle

- No module system. Schemas are TS objects, and "extension" means spreading column objects (`...timestamps`) into a table.
- ✅ Lesson: composition of plain objects is enough for mixin-like reuse.
- ❌ No way for package B to add a column to package A's table, and no override concept.

### Kysely

- Types come from a user-written (or `kysely-codegen`-generated) `Database` interface. Plugins (`KyselyPlugin`) transform
  queries and results.
- ✅ Lesson: **codegen from the source of truth into interfaces** scales to large schemas and resolves cycles lazily.
- ❌ No model layer to extend.

### MikroORM

- Entity inheritance through class `extends`, with single-table inheritance (`discriminatorColumn`) and embeddables.
  Subscribers and lifecycle hooks are available for behaviour.
- ✅ Lesson: embeddables are a good fit for value objects (e.g. an address).
- ❌ `extends` is single-parent and creates a *new* entity. There's no in-place extension from another package, and the
  `class` hierarchy is fixed at compile time.

### TypeScript declaration merging (the standard way to augment types)

```ts
declare module '@shutro/core' {
  interface Models { 'sale.order': { warehouse: Many2one<'stock.warehouse'> } }
}
```

- ✅ No codegen, and editors understand it immediately.
- ❌ **Global:** once any file in the compilation contains the augmentation, *every* module sees `warehouse`, including
  `sale`, which must not know about it. This recreates W2 at the type level.

---

## 5. Options

### Option A — Global declaration merging

Each module augments a global `Models` interface. Registry build checks the runtime shape.

### Option B — Pure inference with handle composition (no codegen)

`extendModel(SaleOrder, {...})` returns a new typed handle. A module combines handles from its dependencies:
`extendModel([SaleStock.SaleOrder, SaleMargin.SaleOrder], {...})`. All types are inferred from `typeof` the handles.

### Option C — Per-module generated views (`shutro generate`) plus an application view

The generator loads the module graph and emits, **for each module**, a declaration of the schema that module can see
(its transitive dependencies plus itself), and a typed `bindings.ts` (`defineModel`, `extendModel`, `f`) bound to that
view. It also emits **one application view** for everything installed.

### Trade-offs

| Criterion | A: global augmentation | B: handle composition | C: per-module generated views |
| --------- | ---------------------- | --------------------- | ----------------------------- |
| R3 dependency-correct types | ❌ global; lower modules see upper fields | ✅ | ✅ |
| Cyclic relations (RFC 0001 §5.4) | ✅ interfaces are lazy | ❌ `typeof` cycles (TS7022) as soon as handles reference each other or methods use `this` | ✅ generated interfaces are lazy |
| Compute and method bodies typed inline | ⚠️ only by repeating field types in the augmentation | ❌ forces data and behaviour into separate steps to avoid cycles | ✅ |
| Build step | None | None | `shutro generate` (watch mode in dev, `--check` in CI) |
| Stale types possible | Yes (augmentation out of sync with runtime) | No | Yes, mitigated by watch mode, a definition hash and a CI check |
| Type-check performance on ~700 models | ⚠️ one huge interface | ❌ deep intersections of `typeof` handles get slow | ✅ flat interfaces, per-module subsets |
| Writing effort | Duplicate types by hand | Verbose (explicit handle imports, multi-handle merges) | Lowest: write definitions only |
| Matches `CLAUDE.md` ("fully typed after `shutro generate`") | ❌ | ⚠️ | ✅ |

**Why not B, which looks attractive?** It works for one extension of one model. It fails for real ERP code:

```ts
// sale_stock: order methods need line fields, and line methods need order fields
export const SaleOrder = extendModel(Sale.SaleOrder, {
  methods: { async createPickings(): Promise<void> { for (const l of this.lines) l.routeFor(this) } },
});
export const SaleOrderLine = extendModel(Sale.SaleOrderLine, {
  methods: { routeFor(order: RecordSet<typeof SaleOrder>): Route { … } },  // typeof SaleOrder → cycle → TS7022
});
```

Avoiding the cycle requires splitting every model into a "data" step and a "behaviour" step, plus manual merges for
diamonds. That costs more than a fast generator.

---

## 6. Decision

**Option C: per-module generated views plus an application view.** On top of that:

- The registry enforces the same rules at runtime (a dependency check, conflicts, extension safety), so types and runtime
  can't disagree even when generated types are stale.
- Generated output is **interfaces only** (no `typeof` back-references to definitions), so cycles resolve lazily (§7.7).
- Definitions stay plain data plus functions (RFC 0001). The generator reads field metadata at runtime and uses the
  TypeScript compiler API only to print **method signatures**, which RFC 0001 §7.8 requires to be explicitly typed.

---

## 7. Detailed design

### 7.1 Declaring a module

```ts
// modules/sale_stock/module.ts
import { defineModule } from '@shutro/core';
import base from '../base/module.js';
import sale from '../sale/module.js';
import stock from '../stock/module.js';
import { SaleOrderStock } from './models/sale_order.js';
import { SaleOrderLineStock } from './models/sale_order_line.js';
import { StockPickingSale } from './models/stock_picking.js';

export default defineModule({
  name: 'sale_stock',
  version: '1.0.0',
  label: 'Sales and Warehouse Management',
  depends: [sale, stock],             // module objects, not strings: typos are impossible and the import graph equals the dependency graph
  // `base` is reachable transitively through `sale`; listing it is allowed but unnecessary
  models: [],                          // models this module owns
  extensions: [SaleOrderStock, SaleOrderLineStock, StockPickingSale],
});
```

Rules:

- `name` is unique, `snake_case`, and stable (it's stored in the database for migrations).
- `depends` must form a DAG. A cycle produces `ModuleCycleError: sale_stock → stock → sale_stock. Move the shared models into a new module that both depend on.`
- Data files, demo data and migration hooks are out of scope here (migrate RFC).

### 7.2 Extending a model

```ts
// modules/sale_stock/models/sale_order.ts
import { extendModel, f } from '../.shutro/bindings.js';   // typed view: base + product + account + sale + stock + sale_stock

export const SaleOrderStock = extendModel('sale.order', {
  fields: {
    warehouse: f.many2one('stock.warehouse', {
      required: true,
      default: (env) => env.model('stock.warehouse').defaultFor(env.company),   // required ⇒ default is mandatory (§7.5)
    }),
    pickings:     f.one2many('stock.picking', 'saleOrder'),
    deliveryDate: f.date({ label: 'Effective date', store: true, depends: ['pickings.dateDone', 'pickings.state'], compute: 'computeDeliveryDate' }),
    pickingPolicy:f.selection({ direct: 'As soon as possible', one: 'When all products are ready' },
                    { required: true, default: 'direct' }),
  },

  methods: {
    computeDeliveryDate(orders): void {
      for (const o of orders) o.deliveryDate = o.pickings.filter((p) => p.state === 'done').minDate('dateDone');
    },
    async createPickings(): Promise<void> {
      await this.lines.launchStockRules();        // method contributed by SaleOrderLineStock, visible in this view
    },
  },

  overrides: {
    // Previous implementation is passed explicitly as `next`, already bound to `this`.
    async confirm(next): Promise<void> {
      await next();
      await this.createPickings();
    },
    // Overriding a compute declared as a method key (RFC 0001 §7.9)
    computeAmounts(next): void {
      next();
      // sale_stock doesn't change amounts; this is shown only to illustrate overriding computes
    },
  },

  constraints: {
    warehouseCompany: {
      depends: ['warehouse', 'company'],
      check: (orders) => orders.filter((o) => !o.warehouse.company.equals(o.company)),
      message: (bad) => `The warehouse of ${bad.names()} belongs to another company. Pick a warehouse of the order's company.`,
    },
  },
});
```

```ts
// modules/sale_margin/models/sale_order_line.ts — independent of sale_stock
export const SaleOrderLineMargin = extendModel('sale.order.line', {
  fields: {
    purchasePrice: f.decimal({ scale: 'product.price', store: true, depends: ['product', 'uom'], compute: 'computePurchasePrice' }),
    margin:        f.monetary({ currency: 'currency', store: true, depends: ['subtotal', 'purchasePrice', 'quantity', 'currency'], compute: 'computeMargin' }),
  },
  methods: {
    computePurchasePrice(lines): void { /* product.standardPrice converted to the line's uom */ },
    computeMargin(lines): void {
      for (const l of lines) l.margin = l.subtotal.minus(l.currency.money(l.purchasePrice.times(l.quantity.value)));
    },
  },
});

// modules/sale_margin/models/sale_order.ts
export const SaleOrderMargin = extendModel('sale.order', {
  fields: {
    margin: f.monetary({ currency: 'currency', store: true, depends: ['lines.margin'], compute: 'computeMargin' }),
  },
  methods: {
    computeMargin(orders): void { for (const o of orders) o.margin = o.lines.sum('margin'); },
  },
});
```

```ts
// modules/sale/models/account_move_line.ts — `sale` extends a model owned by `account` (sale depends on account)
export const AccountMoveLineSale = extendModel('account.move.line', {
  fields: {
    saleLines: f.many2many('sale.order.line', { relation: 'sale_order_line_invoice_rel', copy: false }),
  },
});

// modules/sale/models/sale_order_line.ts (excerpt): the inverse side, on the model `sale` owns
invoiceLines: f.many2many('account.move.line', { relation: 'sale_order_line_invoice_rel' }),
```

### 7.3 What an extension may contain

| Key | Meaning | Rule |
| --- | ------- | ---- |
| `fields` | Add new fields | The name must not exist in the view. If it does, use `fieldOverrides`. Name collisions with unrelated modules fail at registry build (§7.6). |
| `fieldOverrides` | Change attributes of an existing field | Only the view-safe attributes in §7.5. |
| `methods` | Add new methods | The name must not exist in the view. Use `overrides` to change an existing method. |
| `overrides` | Wrap an existing method or compute | The signature must equal the base signature. `next` is typed as the base method. |
| `constraints`, `sqlConstraints`, `indexes` | Add more | Keys must be unique per model (prefixing the module name is recommended for SQL constraints). |
| `tracking` | Add tracked fields | Union. |

What an extension can't do: remove a field, change a field's kind, column or `store`, rename the table, replace a method
without `next` in scope, or touch a model that isn't in its view.

An override that doesn't call `next` is allowed but must be explicit:
`overrides: { confirm: replace(async function (): Promise<void> { … }) }`. `shutro inspect` reports replacements as
warnings. This addresses W3 ("forgot super()").

### 7.4 Registry build

```ts
// app/registry.ts
import { buildRegistry } from '@shutro/core';
import saleStock from '../modules/sale_stock/module.js';
import saleMargin from '../modules/sale_margin/module.js';

export const registry = await buildRegistry({ modules: [saleStock, saleMargin] });   // dependencies collected transitively
```

Algorithm:

1. **Collect** the transitive closure of `depends`. Fail on cycles or duplicate module names (two copies of `sale` from
   different package versions produce `DuplicateModuleError` with both paths).
2. **Order** topologically using Kahn's algorithm, breaking ties by **module name**. The order is a pure function of the
   module set (R5). Example: `base, uom, product, account, sale, stock, sale_margin, sale_stock`.
3. **Define**: for each module in order, register its `models`. A model name owned by two modules produces `DuplicateModelError`.
4. **Extend**: for each module in order, apply `extensions`. Each one is checked as follows:
   - The target model must be owned by the module itself or by a transitive dependency. Otherwise:
     `UndeclaredDependencyError: module 'sale_margin' extends 'stock.picking' (owned by 'stock') but does not depend on it. Add stock to sale_margin.depends.` (W2)
   - It must satisfy the view-safety rules (§7.5).
   - It must not conflict with other extensions (§7.6).
5. **Apply mixins** (§7.8), including extensions of mixins.
6. **Compose method chains.** For each method, start with the owner's implementation and wrap it with each override
   in module order. Odoo's MRO is the same idea, but here the chain is data that can be printed.
7. **Resolve and validate references:** relation targets, one2many inverses, `related` paths, `depends` paths,
   `currency` / `uom` fields and `compute` method keys. This catches anything stale types missed.
8. **Build the compute dependency graph** (compute-engine RFC). Compute cycles fail here.
9. **Freeze** everything with `Object.freeze` deep. After that, nothing can modify the registry (R10).
   The registry is immutable, so tests can build many registries in parallel.

Every field, method layer and constraint carries `origin: { module, file, line? }`.

```
$ shutro inspect sale.order.confirm
sale.order.confirm  (3 layers, outermost first)
  3. sale_stock    modules/sale_stock/models/sale_order.ts:41   override → next()
  2. sale_margin   (no override)
  1. sale          modules/sale/models/sale_order.ts:118        definition

$ shutro inspect sale.order --fields
field          kind       module        store  required  computed
partner        many2one   sale          yes    yes       -
warehouse      many2one   sale_stock    yes    yes(def)  -
margin         monetary   sale_margin   yes    -         computeMargin (sale_margin)
amountTotal    monetary   sale          yes    -         computeAmounts (sale ← sale_stock)
```

### 7.5 View-safety rules (why per-module types stay correct at runtime)

A module's code is compiled against **its view**, but it runs against the **final model**, which may contain more.
That's sound only if every final model is a *safe extension* of every view. The following rules guarantee this. They're
enforced in the generated `extendModel` type (compile time) and again at registry build (runtime).

| # | Rule | Why |
| - | ---- | --- |
| S1 | **New fields that are required must have a `default` or a `compute`.** | Lower modules' `create()` calls don't know the field and must still succeed (W4). Existing rows get the default at migration time. |
| S2 | `fieldOverrides.required: true` is allowed only with a default (the existing one or a new one). Relaxing `required` to `false` is **forbidden**. | Lower views typed `partner: Record<…>` (non-null) would read `null`. |
| S3 | `fieldOverrides.default` may change. | Doesn't affect any view's types. |
| S4 | `label`, `help`, `index`, `tracking`, `copy` and `groups` may change. | Metadata only. Security changes are governed by the security RFC. |
| S5 | **Selections and states can only be widened if the owner opted in** with `extensible: true`. In every view, an extensible selection reads as `'draft' \| 'sent' \| 'sale' \| 'cancel' \| UnknownOption<'sale.order.state'>`. | Lower modules must handle values they don't know about, so an exhaustive `switch` without a `default` fails to compile (W6). |
| S6 | `fieldOverrides.selectionAdd` / `statesAdd` / `transitionsAdd`: new values only. Existing values and transitions can't be removed or redirected. A new transition can be inserted *between* states only by adding states and transitions, never by changing an existing transition's `to`. | Lower modules calling `order.confirm()` keep the meaning they were written for. |
| S7 | `overrides` keep the exact signature (parameters and return type). | Callers compiled against a lower view stay correct. |
| S8 | Kind, column, `store`, relation target and `ondelete` are immutable. | These change the storage contract. A real need for that is a migration, not an extension. |

Together these make each view a **supertype** of the final model, for reads and for writes. Code type-checked against
its view can't observe a broken invariant at runtime, assuming the registry build succeeded.

### 7.6 Conflicts between independent modules

The case is two modules that don't depend on each other (e.g. `sale_margin` and `sale_commission`) and both add
`sale.order.margin`.

- **Types can't see this.** Each module's own view is valid.
- **The application view and the registry can.** `shutro generate` (application) and `buildRegistry` both fail with:
  `FieldConflictError: 'sale.order.margin' is added by both sale_margin (…/sale_order.ts:7) and sale_commission (…:12).
  Rename one field, or make one module depend on the other and use fieldOverrides.`
- Same rule for methods, constraint keys and SQL constraint names. Odoo's behaviour here is "last one wins" (W5).
  Shutro never resolves conflicts silently.
- There's no enforced field-prefix convention. Conflicts are rare in practice and fail loudly. Third-party modules
  may use a module prefix (`commissionMargin`) for generic names.

### 7.7 Generated output

```
modules/
  sale/
    module.ts
    models/…
    .shutro/                      # generated, git-ignored in apps (see open question 3)
      schema.d.ts                 # interface SchemaView for module `sale`
      bindings.ts                 # defineModel / extendModel / f typed against SchemaView
app/
  .shutro/
    schema.d.ts                   # application view (all installed modules)
    index.ts                      # typed `Env`, `model('sale.order')`, etc. for application code
```

Shape of a generated view (abridged):

```ts
// modules/sale_stock/.shutro/schema.d.ts — GENERATED, do not edit. definitions-hash: 9f3c…
import type { F, RecordSet, Id, Money, CalendarDate, UnknownOption } from '@shutro/core/types';

export interface SchemaView {
  'sale.order': SaleOrder;
  'sale.order.line': SaleOrderLine;
  'stock.warehouse': StockWarehouse;
  'res.partner': ResPartner;
  // … every model visible to sale_stock, nothing else (no 'sale.order'.margin from sale_margin)
}

export interface SaleOrder {
  fields: {
    partner:   F.Many2one<'res.partner', { required: true }>;
    currency:  F.Many2one<'res.currency', { required: true; default: true }>;
    lines:     F.One2many<'sale.order.line', 'order'>;
    amountTotal: F.Monetary<'currency', { store: true; computed: true }>;
    state:     F.State<'draft' | 'sent' | 'sale' | 'cancel', { extensible: true }>;
    warehouse: F.Many2one<'stock.warehouse', { required: true; default: true }>;   // origin: sale_stock
    pickings:  F.One2many<'stock.picking', 'saleOrder'>;                          // origin: sale_stock
    // …
  };
  methods: {
    confirm(): Promise<void>;                       // printed from the declared signature, not `typeof`
    computeAmounts(): void;
    createPickings(): Promise<void>;                // origin: sale_stock
  };
  paths: 'partner' | 'partner.name' | 'lines' | 'lines.subtotal' | 'lines.product.uom' | /* depth ≤ 3 */ …;
}
```

Key properties:

- **Interfaces only**, with model references by name (`'res.partner'`) and lookups through `SchemaView[...]` resolved
  lazily. That's why cyclic relations and methods that use `this` type-check without TS7022.
- Fields are read from the **runtime definitions** (the generator imports the module graph. Definitions must be free of
  side effects, which a Biome rule checks for `module.ts` and `models/`).
- Method signatures are printed with the TypeScript compiler API. That's possible because RFC 0001 §7.8 requires
  explicit parameter and return types.
- Each file embeds a **definitions hash**. In development, `buildRegistry` compares it and warns:
  `Generated types for module 'sale_stock' are stale (hash 9f3c ≠ 1a7e). Run "shutro generate" or start "shutro generate --watch".`
- `shutro generate --check` fails CI when the output would change.
- `paths` (used by `depends` and `related`) is depth-limited (default 3, configurable per model). Longer paths are validated at
  registry build only. This keeps type-check time bounded on large schemas.

**Developer loop:** `shutro generate --watch` runs next to `tsc --watch` / the editor. Changing a definition regenerates
only the affected module views (incremental by module hash). The target is under 500 ms for an `erp-demo`-sized graph.
This will be benchmarked during Phase 2.

### 7.8 Mixins and delegation

**Mixins** (abstract, no table) cover R8:

```ts
// modules/mail/models/mail_thread.ts
export const MailThread = defineMixin('mail.thread', {
  fields: {
    messages:  f.one2many('mail.message', 'resId', { polymorphic: 'model' }),
    followers: f.one2many('mail.followers', 'resId', { polymorphic: 'model' }),
  },
  methods: {
    async messagePost(body: string, opts?: PostOptions): Promise<RecordSet<'mail.message'>> { /* … */ },
  },
});

// modules/sale/models/sale_order.ts (sale depends on mail)
export const SaleOrder = defineModel('sale.order', { mixins: ['mail.thread'], fields: { … } });
```

- Mixin fields and methods are copied into each model that uses them, with `origin` recording both the mixin and the
  model's module.
- `extendModel('mail.thread', …)` from another module (e.g. `mail_bot`) applies to every model that uses the mixin, but only
  in views that include `mail_bot`. The same view-safety rules apply.
- A method defined both by a mixin and by the model itself must be declared in the model's `overrides`, and its `next`
  is the mixin's implementation. Nothing is overridden silently.

**Prototype copy** (Odoo `_name` + `_inherit` with a different name) is **not supported**. Use a mixin instead, which
makes the shared part explicit.

**Delegation** (`_inherits`) is sketched here and needs its own RFC (it interacts with recordsets, the SQL compiler and security):

```ts
export const Product = defineModel('product.product', {
  delegates: { template: 'product.template' },   // required many2one + transparent read/write of template fields
  fields: { barcode: f.char(), defaultCode: f.char() },
});
```

### 7.9 End-to-end example: what each module sees

```
base ─┬─ uom ── product ─┬─ account ── sale ─┬─ sale_margin
      │                  └─ stock ───────────┴─ sale_stock (depends: sale, stock)
      └─ mail ──────────────────────────────── (sale depends on mail)
```

| Code location | Can use `order.warehouse` | `order.margin` | `order.messagePost()` |
| ------------- | :-: | :-: | :-: |
| `modules/sale/**` | ❌ compile error | ❌ | ✅ |
| `modules/sale_stock/**` | ✅ | ❌ compile error (no dependency on sale_margin) | ✅ |
| `modules/sale_margin/**` | ❌ | ✅ | ✅ |
| `app/**` (both installed) | ✅ | ✅ | ✅ |

Runtime: `buildRegistry({ modules: [saleStock, saleMargin] })` produces one final `sale.order` with `warehouse` and `margin`.
`sale`'s `create({ partner, currency })` still succeeds, because `warehouse` has a default (S1).

---

## 8. Type-level guarantees

```ts
// modules/sale/models/foo.ts — view of `sale`
extendModel('stock.picking', { … });                          // ❌ 'stock.picking' is not visible to module 'sale'
order.warehouse;                                              // ❌ property 'warehouse' does not exist

// modules/sale_stock/models/sale_order.ts — view of `sale_stock`
extendModel('sale.order', { fields: { partner: f.char() } }); // ❌ 'partner' already exists. Use fieldOverrides.
extendModel('sale.order', { fields: { warehouse: f.many2one('stock.warehouse', { required: true }) } });
                                                              // ❌ S1: required field added by extension needs default or compute
extendModel('sale.order', { fieldOverrides: { partner: { required: false } } });
                                                              // ❌ S2: cannot relax required
extendModel('sale.order', { overrides: { confirm(next, force: boolean): Promise<void> { … } } });
                                                              // ❌ S7: signature differs from base `confirm(): Promise<void>`
extendModel('sale.order', { overrides: { confrim(next) { … } } });
                                                              // ❌ 'confrim' is not a method of sale.order

switch (order.state) {                                        // state is extensible → includes UnknownOption
  case 'draft': case 'sent': case 'sale': case 'cancel': return …;
}                                                             // ❌ not all code paths return (S5)

expectTypeOf<SaleStockView['sale.order']['fields']>().not.toHaveProperty('margin');
expectTypeOf<AppView['sale.order']['fields']>().toHaveProperty('margin');
```

---

## 9. Runtime metadata

`registry.describe()` (RFC 0001 §9) is extended with:

- `modules`: name, version, depends, load order index.
- Per field: `origin`, plus `overriddenBy: [{ module, attributes }]`.
- Per method: `layers: [{ module, file, kind: 'definition' | 'override' | 'replace' }]`.
- `extensions`: what each module contributed to each model, which Kosh can show as "fields added by Inventory" in the form editor.

---

## 10. Interactions

- **0001:** relations by name and explicit method signatures exist so that this RFC's generated views work.
- **0003:** `env.model('sale.order')` returns the application view in app code. Module code gets the module view through
  its bindings (`import { env } from '../.shutro/bindings.js'` exposes a narrowed `Env` type over the same runtime object).
- **0004:** recordset method dispatch uses the composed chains from §7.4 step 6, with no per-call lookup cost.
- **Migrate:** module load order drives migration order. S1 defaults are used to backfill new required columns.
- **Security:** `groups` overrides follow security-RFC rules, not S4 alone.

---

## 11. Resolved questions

Resolved on 2026-10-14. The original questions are kept below for context.

| # | Resolution |
| - | ---------- |
| 1 | **One module set per application in v1.** Per-database registries are deferred. |
| 2 | **The migrate package's version table is enough for v1.** There's no `ir_module_module` equivalent. |
| 3 | **`.shutro/` is git-ignored in applications** (regenerated in `postinstall`, checked in CI with `--check`). **Published module packages ship their generated declarations.** |
| 4 | **A Phase 2 spike** covers the TypeScript 7 API. The fallback is `typeof`-based method types with mandatory annotations. |
| 5 | **`replace()` is allowed** and always reported as a warning by `shutro inspect` and at registry build in dev mode. |
| 6 | **Selections are closed by default.** `extensible: true` is an explicit opt-in by the owner. |

**Original questions:**

1. **Registries per database.** Odoo serves many databases with different installed modules from one process. The
   recommendation for v1 is **one module set per application**, so every database served by the process has the same
   modules and types match runtime exactly. Per-database registries (module install/uninstall at runtime, as in an Odoo
   SaaS) would make the application view an upper bound and need runtime guards. Is that a v1 requirement for Kosh?
2. **Module install state in the database.** Do we need `ir_module_module`-style rows (installed version, for data
   migrations) in v1, or is the version stored by the migrate package enough?
3. **Committing generated files.** The recommendation is to git-ignore them in applications (regenerate in `postinstall`
   and CI with `--check`), and to **ship** `.shutro/` declarations in the published build of third-party module packages, so
   consumers get types without running a generator on someone else's sources.
4. **Generator and TypeScript 7.** The native (Go) TypeScript compiler has a different programmatic API. We need a
   Phase 2 spike to confirm method-signature printing works with both, or to fall back to `typeof`-based method
   types plus mandatory annotations.
5. **`replace()` overrides:** allow them (with an inspector warning) or forbid them entirely?
6. **Extensible-by-default selections.** The recommendation is closed by default and `extensible: true` as an explicit
   opt-in by the owner (S5). Odoo developers expect `selection_add` everywhere. Is that acceptable?

## 12. Deferred

- Delegation inheritance (`delegates`): its own RFC.
- Module data files (XML/CSV/TS seed data), demo data and `noupdate` semantics: migrate RFC.
- Runtime module install/uninstall and per-database registries: depends on open question 1.
- Module packaging and distribution (npm conventions, version ranges in `depends`).

---

## Implementation notes (2026-10-14, registry: first half)

`packages/core/src/registry/`. Where the implementation refines this RFC:

1. **No cycle error.** `depends` takes module *objects*, and a frozen module can only reference modules defined before
   it, so a dependency cycle can't be written. `ModuleCycleError` (§7.1) is therefore not implemented; a defensive guard
   remains in the ordering loop.
2. **Load order** is Kahn's algorithm with the smallest name first (§7.4 step 2). For the diamond in §7.9 that gives
   `base, uom, product, account, sale, sale_margin, stock, sale_stock`.
3. **Checks implemented** (§7.4 steps 1–4 and 7): duplicate modules and models, relation targets exist and belong to a
   declared dependency (incl. the implicit `res.users` / `res.company` / `res.currency` targets, so every registry needs
   `base`), one2many inverses, and `depends` paths through real fields.
4. **`describe()`** adds `origin: { module }` to the model and to every field. Field-level origins become meaningful with
   extensions.
5. **Second half (not yet):** `extensions`, `fieldOverrides`, `overrides` with `next`, `replace()`, mixins, module
   `flags`, method-chain composition, and the generated per-module views.

## Implementation notes (2026-10-15, registry: extensions)

`packages/core/src/registry/extension.ts` and the extension steps of `buildRegistry`. Where the implementation refines
§7.2–§7.6:

1. **Extended models are rebuilt through `defineModel`.** Models keep their declared `definition`; the registry merges it
   with the extensions (fields, field overrides, methods, overrides, constraints, indexes, tracking) and defines the
   model again, so every model-level validation and `describe()` applies to the final model.
2. **Typing without the generator:** `Module` carries its extensions' types, and the schema view intersects a model with
   its extensions by name, so extension fields type `env.model()` today. The generator will emit per-module views later.
3. **`OverrideFn` is deliberately loose** (`next: never`) so typed implementations are accepted; exact typing of `next`
   and `this` arrives with the generated views.
4. **Rules implemented:** S1 (required needs default or compute; booleans exempt), S2 (tighten only, with a default), S4
   (allowed attributes), S5/S6 (`selectionAdd` only when `extensible`), S7 (override target must exist), S8 (kind, column,
   store and target are not overridable: no API exposes them), plus §7.6 conflicts with both module names and the
   "use fieldOverrides / overrides" variants when the existing member comes from a dependency. Implicit fields can't be
   overridden.
5. **Cross-model checks use the field's origin module** for the dependency check, so an extension's relation to a model
   its module doesn't depend on is an `UndeclaredDependencyError` even though the base model's owner might depend on it.
6. **Not yet:** mixins (`defineMixin`), module `flags` and `precisions`, `replace()` warnings at build time in dev mode,
   and the generator.

## Implementation notes (2026-10-15, migrations)

`packages/migrate` and `defineModule({ migrations })`. Where the implementation settles what this RFC deferred:

1. **Open question 2 is answered: the migrate package stores module state.** `shutro_module (name, version)` records
   the installed version of every module; `shutro_migration (version, name, checksum, applied_at)` is the ledger of
   applied schema files. No `ir_module_module`-style model: module state is not business data.
2. **Hooks are module manifest entries**, `migrations: [{ version, up(ctx) }]`, validated at `defineModule` (semver
   shape, not beyond the module version) and sorted. They run only on upgrade, for `installed < version <= module.version`,
   in registry load order, one transaction per module. A fresh install records the version and runs nothing.
3. **`MigrationContext` is `{ sql, registry }`**, no `Env`: migrations bypass business logic by design (see the
   [migrations guide](../guides/migrations.md)).
4. **Schema migrations are files, not live DDL.** `planMigration` diffs the live `pg_catalog` against
   `desiredSchema(registry)`; `writeMigrationFile` emits `NNNN_name.sql`; `applyMigrations` runs pending files in order
   and refuses destructive statements without `allowDestructive`. S1's defaults become the backfill when a column turns
   required (§7.3). Check constraints and partial-index predicates must be parameter-free `sql` fragments. Tables the
   application owns outside the models (a framework's own, e.g. `kosh_*`) are passed as `ignore` (names, `prefix*`,
   regular expressions) and never altered or dropped; `shutro_*` are always ignored.
5. **`createTableStatements` in core stays** as the test stopgap; the migrator's plan over a stopgap-created schema
   contains only the indexes the stopgap doesn't create, which is asserted in the integration tests.
6. **Not here:** data files / seed data (§12), renames (a drop plus an add in the diff: write the `RENAME` by hand), and
   the CLI entry points (`shutro migrate plan|write|apply`) which come with the CLI package.

## Implementation notes (2026-10-15, `shutro generate`)

`packages/cli` (`generate` command, `defineConfig`) and `F` in `packages/core/src/model/generated.ts`. Where the
implementation settles §7.7 and open question 4:

1. **Open question 4 is answered: no compiler API.** TypeScript 7 ships no JavaScript API, so method signatures are not
   printed. The fallback from §11 is used: `methods` is an intersection of `F.Methods<typeof import('../module.js').sale,
   'sale.order'>` terms, one per module contributing to the model, which reads the declared signatures from the sources.
   Every module in the graph must therefore be listed in `shutro.config.ts` (`ModuleSourceError` otherwise).
2. **Fields are spelled with `F.*`** using the builders' option vocabulary (`{ readonly required: true; readonly
   compute: 'computeAmounts'; readonly store: true }`), and `FlagsOf` now resolves its result into a fresh structural
   type, so a generated field is *identical* (not merely mutually assignable) to the declared one. The type tests assert
   this with `toEqualTypeOf`.
3. **Layout as in §7.7**, minus `paths`: `<module>/.shutro/{schema.d.ts,bindings.ts}` and `<app>/.shutro/{schema.d.ts,index.ts}`.
   `paths` is deferred until `depends` / `related` are typed; at ERP width the depth-3 union is too large to emit blindly.
4. **Hash and check.** The header carries a hash of the view's definitions (module versions, model descriptions); `--check`
   compares file contents and exits 1 on drift. The development-time stale warning in `buildRegistry` and `--watch` are
   not implemented.
5. **The CLI** currently has only `generate`; `init`, `migrate` and `inspect` print "not implemented" (exit 2) until the
   CLI roadmap item.
