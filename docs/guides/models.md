# Models

`defineModel()` turns a record of [fields](fields.md) into a model: frozen metadata, derived names, and the checks
that need the whole model ([RFC 0001 §7](../rfcs/0001-model-and-field-definition.md)). Loading models into a
registry, extending them from other modules, and the recordset API come in the next steps.

```ts
import { defineModel, f } from '@shutro/core';
import { sql } from '@shutro/sql';

export const SaleOrder = defineModel('sale.order', {
  label: 'Sales Order',
  order: ['dateOrder desc', 'id desc'],
  companyScoped: { required: true },           // adds `company`
  tracking: ['state', 'partner', 'amountTotal'],
  fields: {
    name:        f.char({ required: true, readonly: true, sequence: 'sale.order' }),
    partner:     f.many2one('res.partner', { required: true, index: true }),
    dateOrder:   f.datetime({ required: true }),
    currency:    f.many2one('res.currency', { required: true }),
    lines:       f.one2many('sale.order.line', 'order'),
    amountTotal: f.monetary({ currency: 'currency', store: true, depends: ['lines.subtotal'], compute: 'computeAmounts' }),
    state:       f.state({ states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' }, initial: 'draft',
                   transitions: { confirm: { from: ['draft'], to: 'sale' }, cancel: { from: ['draft', 'sale'], to: 'cancel' } } }),
  },
  methods: {
    computeAmounts(): void { /* batch compute; typed `this` arrives with recordsets */ },
  },
  sqlConstraints: {
    nameUniquePerCompany: { unique: ['company', 'name'], message: 'Order reference must be unique per company.' },
    positiveTotal: { check: sql`amount_total >= 0`, message: 'The total cannot be negative.' },
  },
  indexes: [{ fields: ['partner', 'dateOrder'] }],
});
```

## What every model gets

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `Id<'sale.order'>` | `bigint GENERATED ALWAYS AS IDENTITY`, branded per model |
| `createdAt`, `updatedAt` | `Date` | Set by the ORM from the transaction timestamp |
| `createdBy`, `updatedBy` | `many2one('res.users')` | `null` for system writes |
| `displayName` | `string` | Computed from `recName`; a model may define its own |
| `active` | `boolean`, default `true` | Only with `archivable: true` |
| `company` | `many2one('res.company')` | Only with `companyScoped: { required }` |

These names (except `displayName`) are reserved, as are the recordset method names (`load`, `write`, `search`, ...).

## Naming

| Source | Result |
| ------ | ------ |
| model `sale.order` | table `sale_order`, label "Sale Order" (override with `table`, `label`) |
| field `amountTotal` | column `amount_total`, label "Amount Total" |
| many2one `partner` | column `partner_id` |
| one2many / many2many, non-stored computes | no column (`model.columns.lines === undefined`) |
| `sqlConstraints.nameUniquePerCompany` | PostgreSQL constraint `sale_order_name_unique_per_company` |
| index on `partner`, `dateOrder` | `sale_order_partner_id_date_order_idx` |

Two fields that map to the same column (`partner` and `partnerId`) are rejected.

## Checks

At compile time, in addition to the per-field checks: `monetary.currency` and `quantity.uom` must name a sibling
`many2one('res.currency')` / `many2one('uom.uom')`; `compute: 'name'` must be a key of `methods`; `recName`, `order`
and `tracking` must name fields; reserved keys and unknown model options are errors.

At runtime, `InvalidModelError` (code `INVALID_MODEL`, message prefixed with the model name) covers the same rules
plus naming, column collisions, constraint and index validity. Checks that need other models (relation targets,
one2many inverses, `depends` paths) happen when the registry loads the modules.

## `describe()`

Returns plain, JSON-serializable metadata for Kosh and the CLI: every field with its kind, label, column, PostgreSQL
type, flags, selection values and transitions, plus constraints, indexes and method names. Field `tracking` is
reported `true` when either the field or the model's `tracking` list says so.

## Hierarchies

```ts
export const ProductCategory = defineModel('product.category', {
  hierarchy: { parent: 'parent', path: 'parentPath' },
  fields: {
    name: f.char({ required: true }),
    parent: f.many2one('product.category', { ondelete: 'cascade' }),
    parentPath: f.char({ readonly: true, index: 'trigram' }), // maintained by the engine: '1/5/9/'
  },
});

await env.model('product.product').search({ where: { category: { childOf: goodsId } } }); // the subtree
await env.model('product.category').search({ where: { id: { parentOf: fruitId } } });     // the ancestors
```

- The engine fills the path on create (a batch may contain its own parents) and rewrites a subtree's paths in one
  statement when a record moves. Moving a record under itself or a descendant is a `ValidationError`.
- `childOf` / `parentOf` take an id or ids, on `id` of the tree model or on any many2one to it, and include the
  given records. They compile to prefix matches on the path; index it with `index: 'trigram'` (a plain btree on
  text serves prefix `LIKE` only under the C collation).
