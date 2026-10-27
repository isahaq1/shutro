# Constraints and onchange

[RFC 0009](../rfcs/0009-constraints-and-onchange.md). Three levels of constraints ([RFC 0001 §7.7](../rfcs/0001-model-and-field-definition.md)),
one error shape, and a form-assist API that computes without writing.

## Business constraints

```ts
constraints: {
  validity: {
    depends: ['validityDate', 'dateOrder'],                       // field keys of this model
    check(orders) {                                               // returns the failing records
      return orders.filter((o) => o.validityDate !== null && o.validityDate < o.dateOrder);
    },
    message: (bad) => `The validity date is before the order date on ${bad.length} order(s). Set a later validity date.`,
  },
},
```

- Checked at **flush points** (`search`, raw SQL, savepoint release, commit, `env.flush()`), after computes have run
  and before any `UPDATE`, **only for records whose `depends` changed** since the last check, in one batch per
  constraint with `depends` loaded. Multi-step edits inside a transaction are validated once.
- `depends` are keys of the model (a relation key means membership changed). Dotted paths are rejected at
  `buildRegistry`: put the rule on the model that owns the data, or depend on a computed field that carries the value.
- Failure: `ConstraintError` with `model`, `constraint`, `fields`, `records` (ids) and the declared message. The
  transaction fails.
- `extendModel({ constraints })` adds rules from other modules.

## SQL constraints

```ts
sqlConstraints: {
  nameUnique: { unique: ['company', 'name'], message: 'Order reference must be unique per company.' },
  taxRateNonNegative: { check: sql`tax_rate >= 0`, message: 'The tax rate cannot be negative.' },
},
```

PostgreSQL enforces them; the ORM maps the failure (on insert, flush or delete) to `ConstraintViolationError` with
`model`, `constraint` (the key), `kind` (`unique` | `check` | `exclusion` | `foreign_key`), `fields` and the declared
message. A foreign-key failure names the many2one field (`constraint: 'order'`).

## Field-level

`required`, `size`, selection values and types are validated by `create()` / `write()` (`ValidationError`) and by
the database (`NOT NULL`, `varchar(n)`). `validate` with Standard Schema is still to come.

## Onchange

```ts
onchange: {
  partner: async (draft, env) => {
    const partner = await draft.record('partner');               // loaded many2one, or null
    if (partner === null) return;
    if (partner.currency !== null) draft.set('currency', partner.currency.id);
    if (partner.email === null) draft.warn('This partner has no email address.');
  },
},
```

```ts
const result = await env.model('sale.order').onchange({
  id,                                                           // optional: start from an existing record
  values: { partner, lines: { create: [{ name: 'a', quantity: '2', priceUnit: '10', currency }] } },
  changed: ['partner', 'lines'],
});
result.values;     // { currency, note, amountTotal: { amount: '22.00', currency: 'BDT' }, ... } — only what changed
result.children;   // { lines: [{ name: 'a', subtotal: { amount: '20.00', ... }, ... }] }
result.warnings;   // ['This partner has no email address.']
```

What happens: a **draft** (a virtual record in the transaction's cache, negative id) is filled with the record's
values or the defaults, then with `values`; the handlers of `changed` run (a `set()` queues that field's handler, each
runs at most once); the real compute engine computes the virtual child rows and then the draft; the plain values that
differ from the input come back (for a new draft that includes its defaults: `onchange({ values: {}, changed: [] })`
gives a new form its default values). Nothing is written, no sequence is consumed, and the draft is purged afterwards.

Drafts understand `create`, `set` and `link` commands for x2many fields; `update` / `delete` / `unlink` are ignored
(a form sends whole child rows). `draft.get(key)` returns ids for many2one, `Decimal` for amounts, commands for x2many.

Handlers are typed `(draft: Draft<Schema, 'sale.order'>, env: Env)` through the generated bindings; in the definition
they take `unknown` and cast, like computes.
