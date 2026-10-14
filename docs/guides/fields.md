# Fields

Fields are declared with the `f.*` builders ([RFC 0001 §7.3](../rfcs/0001-model-and-field-definition.md)). Each
builder returns a frozen descriptor: runtime metadata for the migrator and Kosh, plus phantom types that give the
field its three faces. `defineModel()` (next step) turns a record of fields into a model.

```ts
import { f } from '@shutro/core';

const fields = {
  name:        f.char({ required: true, readonly: true, sequence: 'sale.order' }),
  partner:     f.many2one('res.partner', { required: true, index: true }),
  currency:    f.many2one('res.currency', { required: true }),
  lines:       f.one2many('sale.order.line', 'order'),
  amountTotal: f.monetary({ currency: 'currency', store: true, depends: ['lines.subtotal'], compute: 'computeAmounts' }),
  validityDate: f.date(),
  state: f.state({
    states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' },
    initial: 'draft',
    transitions: { confirm: { from: ['draft'], to: 'sale' }, cancel: { from: ['draft', 'sale'], to: 'cancel' } },
  }),
};
```

## Catalogue

| Builder | PostgreSQL | Read | Create / write | Notes |
| ------- | ---------- | ---- | -------------- | ----- |
| `f.char({ size? })`, `f.text()`, `f.html()` | `text` / `varchar(n)`; `jsonb` with `translate` | `string` | `string` | |
| `f.boolean()` | `boolean` | `boolean` | `boolean` | Never null; defaults to `false` |
| `f.integer()` | `integer` | `number` | `number` | |
| `f.bigint()` | `bigint` | `bigint` | `bigint \| number` | |
| `f.float()` | `double precision` | `number` | `number` | Discouraged; the descriptor says why |
| `f.decimal({ scale })` | `numeric(32, s)` or `numeric` (named precision) | `Decimal` | `Decimal \| string` | A `number` default such as `0.1` is rejected |
| `f.monetary({ currency })` | `numeric` | `Money` | `Decimal \| string` | `currency` names a sibling `many2one('res.currency')` |
| `f.quantity({ uom })` | `numeric` | `Quantity` | `Decimal \| string` | |
| `f.date()` | `date` | `'YYYY-MM-DD'` string | same | Never a JS `Date` |
| `f.datetime()` | `timestamptz` | `Date` | `Date` | UTC in storage |
| `f.selection({ a: 'A' })` | `text` | `'a' \| …` | same | Function form is dynamic (`string`) |
| `f.state({ states, initial, transitions })` | `text` | union | **not writable** | Changes through transitions |
| `f.json<T>()` | `jsonb` | `T` | `T` | |
| `f.binary()` | `bytea` | `Uint8Array` | `Uint8Array` | Never prefetched |
| `f.many2one('res.partner')` | `bigint` FK | `{ id: Id<'res.partner'> }` for now | `Id<'res.partner'>` | `ondelete`: restrict (default), cascade, set null |
| `f.one2many('sale.order.line', 'order')` | — | set | `X2ManyCommands` | `'order'` is the inverse many2one |
| `f.many2many('account.tax')` | junction table | set | `X2ManyCommands` | |

Common options: `label`, `help`, `required`, `readonly`, `default` (a value or `(env) => value`), `index`
(`true | 'unique' | 'trigram' | 'brin'`), `copy`, `tracking`, `column`, `groups`, `deprecated`, `translate`,
`sequence`, and `compute` / `depends` / `inverse` / `store` for computed fields.

## The three faces

```ts
import type { CreateOf, ReadOf, WriteOf } from '@shutro/core';

type Order = ReadOf<typeof fields>;     // name: string; validityDate: string | null; state: 'draft' | 'sale' | 'cancel'
type NewOrder = CreateOf<typeof fields>; // partner: Id<'res.partner'> (mandatory); lines?: X2ManyCommands; no name, no state
type OrderPatch = WriteOf<typeof fields>; // everything optional; readonly, computed and state fields absent
```

| Rule | Effect |
| ---- | ------ |
| `required` | Read `T` instead of `T \| null`; mandatory on create unless it has a `default` or a `sequence` |
| `readonly`, `sequence`, `state`, `compute` without `inverse` | Absent from create and write |
| `compute` with `inverse` | Writable |
| `boolean`, one2many, many2many | Never null (`false` / empty set) and never mandatory |

## What's checked where you write the field

At compile time: unknown options (`requird`), a default of the wrong type, a selection default that isn't a key,
unknown states in `initial` or `transitions`, `depends` without `compute`, `store` on an x2many, and a required
many2one with `ondelete: 'set null'`.

At runtime, with `InvalidFieldError` (code `INVALID_FIELD`, a `hint` in the message): the same rules, plus sizes,
scales, identifiers and model names.

Checks that need the sibling fields (`monetary.currency` must be a `many2one('res.currency')`) or the schema
(`depends` paths, relation targets) happen in `defineModel()` and the registry.
