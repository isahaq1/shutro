# RFC 0001 — Model & field definition API

- **Status:** Accepted (2026-10-14)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** —
- **Related:** 0002 (registry, extension, type generation), 0004 (recordsets), 0005 (SQL compiler), 0006 (money)

---

## 1. Summary

Models are declared with `defineModel(name, { fields, ... })`. Fields come from the `f.*` builders, and each
builder produces a fully typed, introspectable `Field` descriptor. The definition is plain data plus batch-oriented
functions (compute, constraints, methods), so the same object drives the TypeScript types, the SQL schema, the migration
diff and the Kosh metadata API.

There are two key decisions:

1. **Relations reference models by name** (`f.many2one('res.partner')`), not by thunk (`() => Partner`). Relations
   are checked at compile time against the generated schema of the module (RFC 0002). This deliberately
   **deviates from the illustrative API in `CLAUDE.md`**; §5.4 explains why.
2. **Every field type has three TypeScript faces**, a *read* type, a *create* type and a *write* type, derived
   from field flags (`required`, `default`, `readonly`, `compute`, `store`). Null is `null`, never `false`.

---

## 2. Problem & ERP requirements

An ERP data model has hundreds of models (Odoo Community 18 ships with ~700), deep relations, money everywhere, and
fields contributed by many independent modules. The definition API must satisfy the following:

| #   | Requirement |
| --- | ----------- |
| R1  | **One source of truth.** The definition produces TS types, DDL, migrations, validation and UI metadata. Nothing is declared twice. |
| R2  | **Full type inference.** Users never write `as`, never annotate field types by hand, and never see `any`. |
| R3  | **ERP field types are first-class:** monetary (tied to a currency field), quantity, selection, state, translatable text, many2one/one2many/many2many, reference, date vs datetime. |
| R4  | **Accounting-safe values.** Money and quantities are `Decimal`, dates without a time are not JS `Date`, and ids of different models cannot be mixed. |
| R5  | **Batch-first behaviour.** Compute functions, constraints and methods receive recordsets, never single records. |
| R6  | **Cyclic relations just work.** Partner ↔ company ↔ user, order ↔ line, move ↔ move line. |
| R7  | **Extensible by other modules** without editing the original file (RFC 0002), so definitions must be mergeable data. |
| R8  | **Introspectable at runtime** for Kosh: labels, help, groups, selection labels, relation targets, field origin. |
| R9  | **PostgreSQL-native.** Field types map to precise PG types (`numeric(p,s)`, `date`, `timestamptz`, `jsonb`, `bigint`). |
| R10 | **Typed one2many/many2many writes.** No magic command tuples. |

---

## 3. How Odoo does it

```python
class SaleOrder(models.Model):
    _name = 'sale.order'
    _description = 'Sales Order'
    _order = 'date_order desc, id desc'

    name = fields.Char(required=True, readonly=True, default=lambda self: _('New'))
    partner_id = fields.Many2one('res.partner', required=True, index=True)
    currency_id = fields.Many2one('res.currency', related='pricelist_id.currency_id', store=True)
    order_line = fields.One2many('sale.order.line', 'order_id')
    amount_total = fields.Monetary(compute='_compute_amounts', store=True, currency_field='currency_id')
    state = fields.Selection([('draft', 'Quotation'), ('sale', 'Sales Order'), ('cancel', 'Cancelled')],
                             default='draft')

    @api.depends('order_line.price_total')
    def _compute_amounts(self):
        for order in self:
            order.amount_total = sum(order.order_line.mapped('price_total'))

    _sql_constraints = [('name_uniq', 'unique(company_id, name)', 'Order reference must be unique!')]
```

Odoo's model is very productive. Several of its ideas are worth keeping:

- Recordset-first compute functions with `self` as a batch.
- Relations by **model name**, which makes cycles a non-issue and makes extension by other modules natural.
- Rich field attributes (`compute`, `store`, `related`, `company_dependent`, `tracking`, `groups`) that live on the
  field, close to where they matter.
- Introspection: `fields_get()` drives every view in the client.

### Weaknesses

| #  | Weakness | Consequence for business software |
| -- | -------- | --------------------------------- |
| W1 | **No static types.** Field names, kwargs, `depends` paths and `compute='_compute_amounts'` are all strings. | Typos surface at runtime (sometimes only in production on a rarely used path). Renaming a field means grep and hope. |
| W2 | **`False` is the universal empty value.** An empty Char, an unset Date and an empty Many2one in `read()` are all `False`. | Every consumer special-cases `False`. `0` vs `False` vs `None` bugs are common in reports and integrations. |
| W3 | **Money is a Python `float` in memory.** `Monetary` is stored as `numeric`, but the ORM converts to float and relies on `float_round` / `float_compare` / `currency.round()`. | Rounding drift. Every developer must remember to call `float_compare` instead of `==`. Accounting modules contain a large amount of defensive rounding code. |
| W4 | **Unchecked kwargs.** `fields.Char(requird=True)` only logs a warning, and a wrong `currency_field` fails late. | Configuration mistakes ship. |
| W5 | **Magic x2many command tuples:** `[(0, 0, vals), (4, id), (6, 0, ids)]` (newer versions add `Command.create(...)` helpers, but the wire format stays tuples). | Unreadable and untyped, and a frequent source of API-integration bugs. |
| W6 | **Ids are bare `int`.** Nothing stops passing a product id where a partner id is expected. | Silent data corruption in imports and integrations. |
| W7 | **`fields.Date` and `fields.Datetime` blur together.** Datetimes are stored as naive UTC `timestamp without time zone`, and the timezone lives in the user context. | Off-by-one-day bugs in invoices and reports around midnight. |
| W8 | **Constraints split three ways:** `_sql_constraints`, `@api.constrains` and `ondelete` on fields, with different error formats. | Inconsistent user-facing errors and duplicated validation. |

---

## 4. Prior art

### Prisma

A separate schema language (`schema.prisma`) plus `prisma generate`, which emits a fully typed client.

- ✅ Excellent generated types: `Prisma.SaleOrderCreateInput` vs `SaleOrderUpdateInput` vs the model type.
- ✅ Relations by **name** in the schema, so there are no cycle problems.
- ✅ `Decimal` columns map to `Prisma.Decimal` (decimal.js).
- ✅ Typed nested writes (`lines: { create: [...], connect: [...] }`). This is the model Shutro should follow for x2many writes.
- ❌ It's a second language: no computed fields, no business logic, no custom field types, and extension is
  limited to multi-file schemas (no "module B adds a field to module A's model").
- ❌ Behaviour lives elsewhere (`$extends` for computed results and methods), so the data model and its logic are split.

### Drizzle

Tables are TypeScript values: `pgTable('sale_order', { id: bigserial(...), partnerId: bigint(...).references(() => partner.id) })`.
`$inferSelect` and `$inferInsert` give read and insert types.

- ✅ No codegen, the schema is just TS, and SQL types are precise.
- ✅ Separate select and insert types derived from column flags (`notNull`, `default`, `generatedAlwaysAs`).
- ❌ **Cycles need manual annotation.** Self-references require `(): AnyPgColumn => table.id`, because TypeScript cannot
  infer a `const` whose initializer refers to itself. This is the same problem §5.4 has to solve.
- ❌ `numeric` comes back as `string` by default. That's safe, but you have to bring your own decimal handling.
- ❌ Table-centric. It has no notion of a model with behaviour, computed fields or extension.

### Kysely

Users (or `kysely-codegen`) write a `Database` interface of tables. `ColumnType<Select, Insert, Update>` and
`Generated<T>` express different types per operation.

- ✅ **`ColumnType<S, I, U>` is the right idea:** a field has different types for reading, inserting and updating.
  Shutro adopts this explicitly (§7.3).
- ✅ Interfaces are resolved lazily by TypeScript, so cycles are free.
- ❌ It's a query builder, not a model layer. There's no behaviour, metadata or extension.

### MikroORM

Entities are classes with decorators (`@Entity() @Property() @ManyToOne(() => Author)`), or `EntitySchema`, or the newer
`defineEntity` helper. It has an identity map and a unit of work, and relations are wrapped in `Reference<T>` / `Collection<T>`.

- ✅ Closest to an ERP ORM in spirit: identity map, unit of work and lazy relations.
- ✅ `Collection<T>` for one2many/many2many, with explicit `add` / `remove` / `set`.
- ❌ The decorator API depends on `reflect-metadata` (or a metadata-provider build step), and field types are written twice
  (once in the decorator, once in the TS property type).
- ❌ Class-per-entity with `extends` gives single-parent inheritance. There's no cross-package "add a field" story.

### What to take

| Idea | From |
| ---- | ---- |
| Recordset-first compute and methods, relations by model name, rich per-field attributes, runtime introspection | Odoo |
| Separate read / create / write types | Kysely, Drizzle, Prisma |
| Typed nested x2many writes (`create` / `link` / `unlink` / `set`) | Prisma, MikroORM |
| Definitions as plain TS values (no second language, no decorators) | Drizzle |

---

## 5. Options

### Option A — Decorated classes

```ts
@Model('sale.order')
class SaleOrder extends BaseModel {
  @Field.many2one('res.partner', { required: true }) partner!: Partner;
  @Field.monetary({ currency: 'currency' }) amountTotal!: Decimal;
}
```

### Option B — `defineModel()` with field builders (data + functions)

```ts
export const SaleOrder = defineModel('sale.order', {
  fields: {
    partner: f.many2one('res.partner', { required: true }),
    amountTotal: f.monetary({ currency: 'currency', compute: ..., depends: ['lines.subtotal'] }),
  },
});
```

### Option C — External schema language + codegen (Prisma style)

```
model sale.order {
  partner      many2one(res.partner) required
  amountTotal  monetary(currency) computed
}
```

### Trade-offs

| Criterion | A: decorators | B: defineModel | C: schema DSL |
| --------- | ------------- | -------------- | ------------- |
| Type inference without duplication | ❌ type written twice (decorator + property) | ✅ inferred from builder | ✅ generated |
| Business logic next to fields (compute, constraints) | ✅ | ✅ | ❌ split across files/languages |
| Extension by other modules (0002) | ⚠️ class mixins / mutation | ✅ definitions are mergeable data | ⚠️ needs a DSL-level `extend` |
| Runtime introspection | ⚠️ needs `reflect-metadata` or a compiler plugin | ✅ the object *is* the metadata | ✅ |
| Tooling cost | Decorator semantics (TC39 vs legacy) | None beyond TS | Parser, LSP, formatter, syntax highlighting |
| Familiarity for Odoo developers | ✅ class-like | ✅ close to Odoo field declarations | ⚠️ |
| Matches `CLAUDE.md` direction | ❌ | ✅ | ❌ (a second language) |

### 5.4 The cyclic-reference problem (which shapes B)

The illustrative API in `CLAUDE.md` writes relations as thunks, `f.many2one(() => Partner)`. With pure inference this
breaks down in real ERP schemas:

```ts
// sale_order.ts
export const SaleOrder = defineModel('sale.order', {
  fields: { lines: f.one2many(() => SaleOrderLine, 'order') },   // needs typeof SaleOrderLine …
});
// sale_order_line.ts
export const SaleOrderLine = defineModel('sale.order.line', {
  fields: { order: f.many2one(() => SaleOrder) },                // … which needs typeof SaleOrder
});
// error TS7022: 'SaleOrder' implicitly has type 'any' because it does not have a type annotation
//               and is referenced directly or indirectly in its own initializer.
```

TypeScript has to infer the type of each `const` from its initializer, and the initializer depends on the other `const`.
Drizzle runs into exactly this and asks users to write `(): AnyPgColumn => …`. In an ERP, cycles are the norm
(partner ↔ company ↔ user, move ↔ move line, product ↔ template ↔ variant), so asking users to annotate would break R2.

It gets worse once compute functions and methods are in the same object. Their parameter (`orders`) and `this` types
depend on the model type, and the model type includes those functions.

**Resolution:** fields reference other models **by name** (`'sale.order.line'`), exactly as Odoo and Prisma do. A field
carries only the *name literal* (`Many2one<'sale.order.line'>`), so inferring a definition never needs another
definition's type. The name → shape lookup goes through a **generated interface** per module (RFC 0002). Interfaces are
resolved lazily by TypeScript, so cycles cost nothing. Names are still type-checked: `f.many2one('res.partnr')` is a
compile error because the parameter type is `keyof Schema`.

---

## 6. Decision

**Option B, `defineModel()` + `f.*` builders**, with these rules:

1. Relations reference models by name, constrained to the model names visible in the module (RFC 0002).
2. Compute, constraint and method bodies are typed through the module's generated schema bindings (RFC 0002 §6). The
   definition object itself (field options, references to the model's own fields) is checked by local inference and
   needs no codegen.
3. Every field has read / create / write faces (§7.3).
4. `null` is the only empty value. Ids are branded per model. Money and quantities are `Decimal`. `date` is a
   calendar date, not a JS `Date`.
5. x2many writes use a typed command object (§7.6), never tuples.

---

## 7. Detailed design

### 7.1 Where `defineModel` comes from

Each module imports `defineModel` (and `extendModel`, RFC 0002) from its **own generated binding**, which is pre-bound
to the model names and shapes visible to that module:

```ts
// modules/sale/models/sale_order.ts
import { defineModel, f } from '../.shutro/bindings.js';   // generated by `shutro generate`, see RFC 0002
```

The binding re-exports the runtime `defineModel` from `@shutro/core` with a narrower type. At runtime there is only one
`defineModel`. A model that has no cross-model typing needs (e.g. a test fixture) may import directly from
`@shutro/core`, in which case relation targets are typed as `string`.

### 7.2 Full example: `base`, `product`, `sale`, `account`

```ts
// modules/base/models/res_partner.ts
import { defineModel, f, sql } from '../.shutro/bindings.js';

export const Partner = defineModel('res.partner', {
  label: 'Contact',
  order: ['displayName asc', 'id asc'],
  recName: 'displayName',
  archivable: true,                          // adds `active: boolean` (default true) + default domain filter
  companyScoped: { required: false },        // adds `company: many2one('res.company')`, nullable = shared contact

  fields: {
    name:        f.char({ required: true, label: 'Name', index: 'trigram' }),
    isCompany:   f.boolean({ default: false }),
    parent:      f.many2one('res.partner', { ondelete: 'cascade', label: 'Related company' }),
    children:    f.one2many('res.partner', 'parent'),
    email:       f.char({ validate: emailSchema }),            // any Standard Schema validator (Zod, Valibot, …)
    vat:         f.char({ label: 'Tax ID' }),
    country:     f.many2one('res.country'),
    lang:        f.selection(() => languageCodes()),           // dynamic selection, typed as string
    creditLimit: f.monetary({ currency: 'creditCurrency' }),
    creditCurrency: f.many2one('res.currency'),
    displayName: f.char({
      store: true,
      depends: ['name', 'parent.name', 'isCompany'],
      compute(partners) {
        for (const p of partners) {
          p.displayName = p.parent && !p.isCompany ? `${p.parent.name}, ${p.name}` : p.name;
        }
      },
    }),
  },

  sqlConstraints: {
    vatUniquePerCompany: {
      unique: ['company', 'vat'],
      where: sql`vat IS NOT NULL AND active`,
      message: 'Another contact in this company already has this Tax ID. Merge the contacts or correct the Tax ID.',
    },
  },
});
```

```ts
// modules/product/models/product_product.ts
export const Product = defineModel('product.product', {
  label: 'Product',
  archivable: true,
  companyScoped: { required: false },

  fields: {
    name:         f.char({ required: true, translate: true }),        // JSONB { "en_US": "...", "bn_BD": "..." }
    defaultCode:  f.char({ label: 'Internal reference', index: true }),
    barcode:      f.char({ index: 'unique' }),
    type:         f.selection({ consu: 'Goods', service: 'Service', combo: 'Combo' }, { required: true, default: 'consu' }),
    uom:          f.many2one('uom.uom', { required: true }),
    listPrice:    f.decimal({ scale: 'product.price', default: '0' }),  // named precision, see RFC 0006
    standardPrice:f.decimal({ scale: 'product.price', companyDependent: true }), // cost per company
    taxes:        f.many2many('account.tax', { relation: 'product_taxes_rel', label: 'Customer taxes' }),
    weight:       f.quantity({ uom: 'weightUom', scale: 'stock.weight' }),
    weightUom:    f.many2one('uom.uom'),
  },
});
```

```ts
// modules/sale/models/sale_order.ts
export const SaleOrder = defineModel('sale.order', {
  label: 'Sales Order',
  order: ['dateOrder desc', 'id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'partner', 'amountTotal'],

  fields: {
    name:       f.char({ required: true, readonly: true, sequence: 'sale.order' }),
    partner:    f.many2one('res.partner', { required: true, index: true }),
    dateOrder:  f.datetime({ required: true, default: (env) => env.now() }),
    validityDate: f.date(),
    currency:   f.many2one('res.currency', { required: true, default: (env) => env.company.currency }),
    lines:      f.one2many('sale.order.line', 'order', { copy: true }),

    amountUntaxed: f.monetary({ currency: 'currency', store: true,
      depends: ['lines.subtotal'],
      compute: 'computeAmounts' }),                 // one compute fills several fields; the name is a typed key of `methods`
    amountTax:     f.monetary({ currency: 'currency', store: true, depends: ['lines.taxAmount'], compute: 'computeAmounts' }),
    amountTotal:   f.monetary({ currency: 'currency', store: true, depends: ['amountUntaxed', 'amountTax'], compute: 'computeAmounts' }),

    state: f.state({
      states: { draft: 'Quotation', sent: 'Quotation sent', sale: 'Sales Order', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        send:    { from: ['draft'], to: 'sent' },
        confirm: { from: ['draft', 'sent'], to: 'sale' },
        cancel:  { from: ['draft', 'sent', 'sale'], to: 'cancel' },
      },
    }),
  },

  methods: {
    computeAmounts(orders): void {
      for (const o of orders) {
        o.amountUntaxed = o.lines.sum('subtotal');   // Decimal, currency-checked (RFC 0006)
        o.amountTax     = o.lines.sum('taxAmount');
        o.amountTotal   = o.amountUntaxed.plus(o.amountTax);
      }
    },
  },

  constraints: {
    validityAfterOrderDate: {
      depends: ['validityDate', 'dateOrder'],
      check(orders) {
        return orders.filter((o) => o.validityDate !== null && o.validityDate.isBefore(o.dateOrder.toCalendarDate(o.env.tz)));
      },
      message: (bad) => `Expiration date is before the order date on ${bad.names()}. Set a later expiration date.`,
    },
  },

  sqlConstraints: {
    nameUniquePerCompany: { unique: ['company', 'name'], message: 'Order reference must be unique per company.' },
  },
});
```

```ts
// modules/sale/models/sale_order_line.ts
export const SaleOrderLine = defineModel('sale.order.line', {
  label: 'Sales Order Line',
  order: ['order', 'sequence', 'id'],

  fields: {
    order:     f.many2one('sale.order', { required: true, ondelete: 'cascade', index: true }),
    sequence:  f.integer({ default: 10 }),
    product:   f.many2one('product.product', { ondelete: 'restrict' }),
    name:      f.text({ required: true }),
    quantity:  f.quantity({ uom: 'uom', default: '1' }),
    uom:       f.many2one('uom.uom', { required: true }),
    priceUnit: f.decimal({ scale: 'product.price', required: true, default: '0' }),
    discount:  f.decimal({ scale: 'discount', default: '0' }),       // percent
    taxes:     f.many2many('account.tax'),
    currency:  f.related('order.currency', { store: true }),          // typed as many2one('res.currency')
    subtotal:  f.monetary({ currency: 'currency', store: true,
      depends: ['quantity', 'priceUnit', 'discount', 'taxes'], compute: 'computeAmounts' }),
    taxAmount: f.monetary({ currency: 'currency', store: true,
      depends: ['quantity', 'priceUnit', 'discount', 'taxes'], compute: 'computeAmounts' }),
    displayType: f.selection({ section: 'Section', note: 'Note' }),  // null = regular product line
  },

  methods: {
    computeAmounts(lines): void {
      // Batch: one call computes taxes for all lines (RFC 0004 guarantees taxes/currency are prefetched once).
      const results = lines.env.model('account.tax').computeAll(lines);
      for (const line of lines) {
        line.subtotal  = results.get(line).untaxed;
        line.taxAmount = results.get(line).tax;
      }
    },
  },
});
```

```ts
// modules/account/models/account_move.ts — invoices
export const AccountMove = defineModel('account.move', {
  label: 'Journal Entry',
  companyScoped: { required: true },
  tracking: ['state', 'partner', 'amountTotal'],

  fields: {
    name:       f.char({ readonly: true, sequence: { code: 'account.move', gapless: true } }),
    moveType:   f.selection({
                  entry: 'Journal Entry', out_invoice: 'Customer Invoice', out_refund: 'Customer Credit Note',
                  in_invoice: 'Vendor Bill', in_refund: 'Vendor Credit Note' }, { required: true, readonly: true, default: 'entry' }),
    partner:    f.many2one('res.partner'),
    invoiceDate:f.date(),
    journal:    f.many2one('account.journal', { required: true }),
    currency:   f.many2one('res.currency', { required: true }),
    lines:      f.one2many('account.move.line', 'move'),
    amountTotal:f.monetary({ currency: 'currency', store: true, depends: ['lines.balance'], compute: 'computeTotals' }),
    state:      f.state({
                  states: { draft: 'Draft', posted: 'Posted', cancel: 'Cancelled' },
                  initial: 'draft',
                  transitions: {
                    post:   { from: ['draft'], to: 'posted' },
                    reset:  { from: ['posted', 'cancel'], to: 'draft' },
                    cancel: { from: ['draft'], to: 'cancel' },
                  },
                }),
  },

  // Posted entries are immutable except for explicitly allowed fields: enforced by the ORM, not by convention.
  lockedWhen: { state: ['posted'], except: ['paymentState'] },

  methods: { computeTotals(moves): void { /* … */ } },
});

// modules/account/models/account_move_line.ts
export const AccountMoveLine = defineModel('account.move.line', {
  fields: {
    move:    f.many2one('account.move', { required: true, ondelete: 'cascade' }),
    account: f.many2one('account.account', { required: true, ondelete: 'restrict' }),
    currency:f.related('move.currency', { store: true }),
    companyCurrency: f.related('move.company.currency', { store: true }),
    debit:   f.monetary({ currency: 'companyCurrency', default: '0' }),
    credit:  f.monetary({ currency: 'companyCurrency', default: '0' }),
    balance: f.monetary({ currency: 'companyCurrency', store: true, depends: ['debit', 'credit'],
               compute: 'computeBalance' }),
    amountCurrency: f.monetary({ currency: 'currency', default: '0' }),
  },
  sqlConstraints: {
    debitOrCredit: { check: sql`debit = 0 OR credit = 0`,
      message: 'A journal item cannot have both a debit and a credit. Split it into two lines.' },
  },
  methods: { computeBalance(lines): void { for (const l of lines) l.balance = l.debit.minus(l.credit); } },
});
```

### 7.3 Field catalogue: three faces per field

`Read` is the value you get from a record, `Create` is the type accepted by `create()`, `Write` is the type accepted by
`write()`. `T?` means optional, and `| null` means the field is nullable. Relational read types (`Record<…>`,
`RecordSet<…>`) are defined in RFC 0004.

| Builder | PostgreSQL | Read | Create / Write | Notes |
| ------- | ---------- | ---- | -------------- | ----- |
| `f.char({ size? })` | `varchar(n)` / `text` | `string` | `string` | Empty string is a value, distinct from `null`. |
| `f.text()` / `f.html({ sanitize })` | `text` | `string` | `string` | `html` is sanitized on write. |
| `f.boolean()` | `boolean` | `boolean` | `boolean` | Boolean fields are never nullable (`default: false` is implied). |
| `f.integer()` | `integer` | `number` | `number` | Range-checked to int4. |
| `f.bigint()` | `bigint` | `bigint` | `bigint \| number` | |
| `f.float()` | `double precision` | `number` | `number` | **Discouraged.** Lint rule `no-float-business-field`. Meant for scientific values only. |
| `f.decimal({ precision?, scale })` | `numeric(p,s)` | `Decimal` | `Decimal \| string` | `scale` can be a named precision (`'product.price'`), RFC 0006. JS `number` is rejected at the type level. |
| `f.monetary({ currency })` | `numeric` | `Money` (RFC 0006) | `Decimal \| string` | `currency` must name a `many2one('res.currency')` field of the same model (checked locally, §8). |
| `f.quantity({ uom, scale? })` | `numeric` | `Quantity` (RFC 0006) | `Decimal \| string` | Tied to a `uom.uom` field, so mixing kg and units is a type error. |
| `f.date()` | `date` | `CalendarDate` | `CalendarDate \| 'YYYY-MM-DD'` | Never a JS `Date` (W7). |
| `f.datetime()` | `timestamptz` | `Instant` | `Instant \| Date` | Always UTC in storage, converted to the user's tz only for display (RFC 0003). |
| `f.selection(map \| () => …)` | `varchar` + `CHECK` | union of keys | union of keys | The map form gives labels. The function form is dynamic (`string`). |
| `f.state({ states, initial, transitions })` | `varchar` + `CHECK` | union of keys | **not writable** | Changes only through transitions, which generate `order.confirm()` etc. (Phase 3). |
| `f.json({ schema })` | `jsonb` | `StandardSchemaV1.InferOutput<S>` | `InferInput<S>` | Validated on write with any Standard Schema validator. |
| `f.binary({ attachment? })` | `bytea` or attachment table | `Uint8Array` (lazy) | `Uint8Array` | Never prefetched by default. |
| `f.many2one(model, { ondelete })` | `bigint` FK | `Record<M> \| null` | `Id<M> \| null` | `ondelete`: `'restrict'` (default) \| `'cascade'` \| `'set null'`. |
| `f.one2many(model, inverse)` | — (inverse FK) | `RecordSet<M>` | `X2ManyCommands<M>` (§7.6) | `inverse` is checked to be a many2one back to this model. |
| `f.many2many(model, { relation? })` | junction table | `RecordSet<M>` | `X2ManyCommands<M>` | Junction table name derived deterministically. |
| `f.reference(models[])` | `varchar` (`'model,id'`) | `Record<M1> \| Record<M2> \| … \| null` | `{ model, id }` | Polymorphic, so prefer explicit many2ones. |
| `f.related('a.b.c', { store? })` | (column if stored) | type of the target field | read-only | Path checked against the schema. |

**Common options:** `label`, `help`, `required`, `readonly`, `default` (value or `(env) => value`), `index`
(`true | 'unique' | 'trigram' | 'brin'`), `copy`, `groups` (security, RFC 0009+), `column` (column-name override),
`tracking`, `translate` (char/text/html only), `companyDependent` (per-company value, stored as JSONB keyed by
company id, like Odoo 17+), `deprecated: 'message'`.

**How flags map to faces:**

```
Read   = required || boolean ? T : T | null           (a default does not make a field non-null; `required` does)
Create = computed && !inverse ? (never present)
       : readonly && !sequence ? (never present)
       : required && !default && !sequence ? T            (mandatory key)
       : T | null                                         (optional key)
Write  = computed || readonly || state ? (never present) : T (| null if not required), optional key
```

### 7.4 Implicit fields

Every model gets the following, and none of them can be redefined:

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | `Id<'sale.order'>` | `bigint GENERATED ALWAYS AS IDENTITY`. Branded per model (W6). |
| `createdAt`, `updatedAt` | `Instant` | Set by the ORM inside the transaction (one timestamp per transaction, like Odoo's `create_date`). |
| `createdBy`, `updatedBy` | `Record<'res.users'> \| null` | `null` for system/migration writes. |
| `displayName` | `string` | Non-stored, from `recName` unless defined explicitly (as `res.partner` does above). |

Opt-ins:

- `archivable: true` adds `active: boolean`, and searches filter `active = true` by default.
- `companyScoped: { required }` adds `company: many2one('res.company')` plus the multi-company consistency check (Phase 3).

### 7.5 Naming and SQL mapping

- Field keys are camelCase in TS and map to snake_case columns (`amountTotal` → `amount_total`). A many2one maps to
  `<name>_id` (`partner` → `partner_id`) so the database remains readable for SQL users and BI tools.
- Model `sale.order` maps to table `sale_order`. Override with `table: 'sales_orders'`.
- Field keys must be valid identifiers, can't collide after snake-casing (`fooBar` vs `foo_bar` is a compile-time
  error), and can't use reserved names (`id`, `env`, `ids`, recordset methods). The list of reserved names is checked at the type level.

### 7.6 Typed x2many writes (replacing Odoo command tuples)

```ts
await env.model('sale.order').create({
  partner: partnerId,                        // Id<'res.partner'>, not just any number
  currency: bdt.id,
  lines: {
    create: [
      { product: laptop.id, name: 'Laptop 14"', quantity: '2', uom: unit.id, priceUnit: '85000.00' },
      { displayType: 'section', name: 'Services' },
      { product: setup.id, name: 'On-site setup', quantity: '1', uom: hour.id, priceUnit: '1500.00' },
    ],
  },
});

await order.write({
  lines: {
    update: [{ id: line1.id, values: { quantity: '3' } }],
    delete: [line2.id],                      // deletes the line record
    create: [{ product: mouse.id, name: 'Mouse', uom: unit.id, priceUnit: '900' }],
  },
});

await product.write({ taxes: { set: [vat15.id] } });   // many2many: set | link | unlink | create | clear
```

`X2ManyCommands<M>` is a discriminated set of optional keys:

- `create: Create<M>[]`
- `update: { id: Id<M>; values: Write<M> }[]`
- `delete: Id<M>[]`
- `link` / `unlink: Id<M>[]`
- `set: Id<M>[]`
- `clear: true`

For a one2many, the inverse field (`order`) is omitted from nested `Create<M>`, because the ORM fills it in.

### 7.7 Constraints: one model, three levels

| Kind | Declared as | Enforced by | Error |
| ---- | ----------- | ----------- | ----- |
| Field-level | `required`, `size`, `validate` (Standard Schema), selection keys | ORM on write, and DB `NOT NULL` / `CHECK` | `ValidationError` with field path |
| SQL | `sqlConstraints: { key: { unique \| check \| exclude } }` | PostgreSQL | DB error code mapped to a `ConstraintViolationError` that carries the declared `message` |
| Business (batch) | `constraints: { key: { depends, check(records) → failing records, message } }` | ORM before commit, only for records whose `depends` changed | `ValidationError` listing the failing records |

All three produce typed errors with the same shape (`code`, `model`, `fields`, `records`, `message`, `hint`), which addresses W8.

### 7.8 Methods

`methods` holds the model's business API. Inside a method, `this` is the recordset (`RecordSet<'sale.order'>`, RFC 0004).
Rules:

- **Batch only.** There is no "single record" method. Use `this.ensureOne()` when needed.
- **Explicit parameter and return types are required** on every method (enforced by a Biome rule and by the type
  generator). This keeps generated declarations exact and avoids inference cycles between methods.
- Methods that change state are `async`, because they may flush to the database.

### 7.9 Compute (shape only; the semantics belong to the compute-engine RFC)

- `compute` is either an inline function `(records) => void | Promise<void>` or a typed key of `methods` (when several
  fields share one compute). Async computes are allowed for computes that need queries (taxes, currency rates). RFC 0004
  §7.5 guarantees that the `depends` paths are loaded before the call.
- `depends` is a list of **dotted paths, type-checked against the schema** (`'lines.subtotal'` is valid, `'lines.subtota'` is a
  compile error). Template-literal path types are generated per model (RFC 0002), which avoids deep recursive types at
  the definition site.
- `store: true` persists the result and recomputes it in batches before commit. Non-stored fields are computed on read and cached per transaction.
- An `inverse` function makes a computed field writable.

---

## 8. Type-level guarantees

Checked **locally** (no codegen, from inference on the definition object):

```ts
f.monetary({ currency: 'currnecy' });          // ❌ 'currnecy' is not a field of this model
f.monetary({ currency: 'partner' });           // ❌ 'partner' is many2one('res.partner'), expected many2one('res.currency')
f.decimal({ scale: 2, default: 0.1 });         // ❌ number not assignable to Decimal | string
f.char({ requird: true });                     // ❌ object literal may only specify known properties
f.state({ initial: 'drafr', states: {...} });  // ❌ 'drafr' not in 'draft' | 'sent' | 'sale' | 'cancel'
transitions: { confirm: { from: ['dratf'] } }  // ❌ same
fields: { id: f.char() }                       // ❌ 'id' is a reserved field name
```

Checked against the **module's generated schema** (RFC 0002):

```ts
f.many2one('res.partnr');                      // ❌ not a model name visible to module 'sale'
f.one2many('sale.order.line', 'ordr');         // ❌ 'ordr' is not a many2one('sale.order') on sale.order.line
depends: ['lines.subtota']                     // ❌ invalid path
f.related('order.currncy')                     // ❌ invalid path
```

Faces:

```ts
type R = Read<'sale.order'>;
expectTypeOf<R['amountTotal']>().toEqualTypeOf<Money>();
expectTypeOf<R['validityDate']>().toEqualTypeOf<CalendarDate | null>();
expectTypeOf<R['state']>().toEqualTypeOf<'draft' | 'sent' | 'sale' | 'cancel'>();

type C = Create<'sale.order'>;
expectTypeOf<C>().toHaveProperty('partner');                 // required, no default → mandatory
expectTypeOf<C>().not.toHaveProperty('amountTotal');         // computed
expectTypeOf<C>().not.toHaveProperty('name');                // readonly + sequence
expectTypeOf<C['currency']>().toEqualTypeOf<Id<'res.currency'> | undefined>(); // has a default → optional

type W = Write<'sale.order'>;
expectTypeOf<W>().not.toHaveProperty('state');               // only via transitions
expectTypeOf<Id<'res.partner'>>().not.toEqualTypeOf<Id<'product.product'>>();
```

---

## 9. Runtime metadata (for Kosh and the CLI)

A definition is a frozen plain object. After registry build (RFC 0002), `registry.describe('sale.order')` returns:

```ts
{
  name: 'sale.order', label: 'Sales Order', table: 'sale_order',
  fields: {
    amountTotal: {
      kind: 'monetary', label: 'Amount Total', column: 'amount_total', pgType: 'numeric',
      required: false, readonly: true, store: true, computed: true,
      currencyField: 'currency', depends: ['amountUntaxed', 'amountTax'],
      origin: { module: 'sale', file: 'modules/sale/models/sale_order.ts' },   // see RFC 0002
      groups: [], tracking: true,
    },
    state: { kind: 'state', selection: [['draft', 'Quotation'], …], transitions: { confirm: { from: [...], to: 'sale' } } },
    …
  },
  constraints: [...], sqlConstraints: [...], methods: ['computeAmounts', ...],
}
```

This covers what Odoo's `fields_get()` returns, plus provenance (`origin`), so Kosh can generate forms, list views,
filters and API schemas (OpenAPI/JSON Schema) without extra declarations.

---

## 10. Interactions

- **0002:** definitions are the unit of extension. `extendModel` merges fields, methods and constraints, and the generated bindings give `defineModel` its typed view.
- **0003:** `default: (env) => …` and `compute` receive the environment (user, company, tz, lang).
- **0004:** `Record<M>` / `RecordSet<M>` read types, the prefetch rules (`binary` is never prefetched), and the identity map.
- **0005:** field → column mapping and `sql` template usage in `sqlConstraints` / `where`.
- **0006:** `Money`, `Quantity`, named precisions (`scale: 'product.price'`) and rounding.
- **Migrate (Phase 2):** the definition is diffed against the live catalog. `column` and `table` overrides exist so
  legacy databases can be adopted.

---

## 11. Resolved questions

Resolved on 2026-10-14 (the recommended option was accepted for each). The original questions are kept below for context.

| # | Resolution |
| - | ---------- |
| 1 | **Relations by model name.** `CLAUDE.md`'s illustrative API is updated to match. |
| 2 | **`Id<M>` is a branded `number`**, backed by PostgreSQL `bigint`, with a runtime guard above `Number.MAX_SAFE_INTEGER`. |
| 3 | **Small `CalendarDate` / `Instant` value classes ship in `@shutro/core`.** The API is shaped like Temporal so it can switch to Temporal once it's unflagged in the target Node LTS. There's no polyfill dependency. |
| 4 | **`companyDependent` uses a JSONB column keyed by company id.** |
| 5 | **The TS key stays `partner`, and the column is `partner_id`.** |

**Original questions:**

1. **Relations by name vs by thunk.** This RFC recommends names (§5.4). Do you accept deviating from the `CLAUDE.md`
   illustrative API? If you do, `CLAUDE.md` should be updated once this RFC is accepted.
2. **Id representation.** The recommendation is `bigint` in PostgreSQL, exposed as a branded **`number`** (`Id<M>`) with a
   runtime guard above `Number.MAX_SAFE_INTEGER` (~9×10¹⁵ rows). That keeps ids JSON-friendly and fast. The alternative is
   branded `bigint`, which is exact but awkward in JSON and APIs.
3. **`CalendarDate` / `Instant`.** Ship small value classes in `@shutro/core` now and switch to `Temporal.PlainDate` /
   `Temporal.Instant` once Temporal is unflagged in the Node LTS we target? Or depend on a Temporal polyfill from day one?
4. **`companyDependent` storage.** A JSONB column keyed by company id (Odoo 17+ style, fast reads) or a side table (more
   normalized, easier constraints)?
5. **Column naming for many2one.** Is `partner` → `partner_id` acceptable, or should the TS key be `partnerId` too?
   The recommendation is to keep `partner`, because the record value is a record, not an id.

## 12. Deferred

- Full compute / recompute semantics, `inverse`, and onchange: compute-engine RFC (Phase 3).
- State-machine runtime (`order.confirm()` generation, guards, hooks): state-machine RFC.
- Field-level security (`groups`) and record rules: security RFC.
- Delegation inheritance (`_inherits`, product.template ↔ product.product): RFC 0002 §7.8 sketch, then its own RFC.
- Translation storage details: i18n RFC.
