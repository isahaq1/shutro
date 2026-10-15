# Computed fields

A computed field is declared with `compute` and `depends` ([RFC 0008](../rfcs/0008-compute-engine.md)). The engine
builds the dependency graph at `buildRegistry`, records what changed on every write, and recomputes stored fields in
batches at flush points. Non-stored fields are computed when loaded.

```ts
export const SaleOrderLine = defineModel('sale.order.line', {
  fields: {
    order: f.many2one('sale.order', { required: true, ondelete: 'cascade' }),
    quantity: f.decimal({ scale: 3, required: true, default: '1' }),
    priceUnit: f.decimal({ scale: 4, required: true, default: '0' }),
    currency: f.many2one('res.currency', { required: true }),
    subtotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['quantity', 'priceUnit'],
      compute(lines: ComputeSet<Schema, 'sale.order.line', Loaded>): void {
        for (const line of lines) line.subtotal = line.quantity.times(line.priceUnit);
      },
    }),
  },
});

export const SaleOrder = defineModel('sale.order', {
  fields: {
    lines: f.one2many('sale.order.line', 'order'),
    taxRate: f.decimal({ scale: 4, required: true, default: '0.1' }),
    amountUntaxed: f.monetary({ currency: 'currency', store: true, depends: ['lines.subtotal'], compute: 'computeAmounts' }),
    amountTotal: f.monetary({ currency: 'currency', store: true, depends: ['amountUntaxed', 'taxRate'], compute: 'computeAmounts' }),
    lineCount: f.integer({ depends: ['lines'], compute(orders) { for (const o of orders) o.lineCount = o.lines.length; } }),
  },
  methods: {
    computeAmounts(orders: ComputeSet<Schema, 'sale.order', Loaded>): void {
      for (const o of orders) {
        const untaxed = [...o.lines].reduce((acc, l) => acc.plus(l.subtotal?.amount ?? toDecimal(0)), toDecimal(0));
        o.amountUntaxed = untaxed;
        o.amountTotal = untaxed.times(toDecimal(1).plus(o.taxRate));
      }
    },
  },
});
```

## Rules

- **Batch.** A compute receives a recordset, never one record, and runs once per batch: 90 lines changed means one
  `subtotal` call and one `computeAmounts` call.
- **`depends` is loaded first.** Every path in `depends` is loaded for the whole batch before the call, so the body
  reads synchronously and never queries. Paths go through many2one (`partner.name`), one2many (`lines.subtotal`) and
  many2many (`tags.name`) fields; a bare relation (`lines`) depends on membership.
- **Assign inside the compute only.** `o.amountTotal = ...` is the way to set a computed value, and it is accepted only
  while that field is being computed (`ComputeAssignmentError` otherwise). Values are normalized like writes: a `Money`
  must be in the record's currency; a `Decimal` or string is fine.
- **One compute, several fields.** Fields naming the same method (`compute: 'computeAmounts'`) are computed together
  by one call, whatever their rank.
- **Chains compute in order.** `subtotal` (rank 0) runs before `amountUntaxed` (rank 1) before `amountTotal` (rank 2),
  each once per flush. A cycle between computed fields is a `ComputeCycleError` at `buildRegistry`.

## Stored fields

Writes, creates, deletes and x2many commands record **triggers**. The affected records are recomputed at the next
**flush point**: before `search`, raw SQL, savepoint release and commit, on `env.flush()`, and when a `load()` asks for
a stored computed field. Resolution walks the paths backwards: a renamed partner recomputes every order of that partner,
including orders not in the cache (one query per reverse many2one step per round, not per record).

Between the write and the flush point, the cached value is **invalidated** rather than left stale: reading it throws
`FieldNotLoadedError` ("pending recompute") until `env.flush()` or `load([...])`. New records have no cached value for
their stored computes until the first flush point either.

Stored computed columns are nullable in the database even when the field is `required`; the engine enforces
required-ness after the compute (a compute that leaves a required field empty is a `ValidationError`).

## Non-stored fields

Not loaded by `search()`; computed for the whole prefetch group by `load(['lineCount'])` or a nested spec, cached per
transaction, invalidated by triggers like stored fields (reading an invalidated value throws until it is loaded again).

## Inverse

A computed field with `inverse` is writable. `write({ code: 'X' })` stores the value and calls the inverse once with
the written records; the inverse typically writes the dependencies. The compute still runs at the next flush point and
should agree with what the inverse wrote.

## `displayName`

Every model has a non-stored `displayName` computed from `recName` unless the model defines its own.

## Types

Declare computes with `ComputeSet<Schema, Model, Loaded>`: iteration yields `ComputeRec`, where computed keys are
assignable (type: read value or write value) and everything else is as in `Rec`. `Loaded` is the shape your `depends`
load (`Merge<DefaultLoaded<S, M>, ToLoaded<S, M, { lines: ['subtotal'] }>>`); generated `LoadedFrom<paths>` types come
with the type generator. In the model definition itself the parameter is typed `unknown` and cast, because the schema
type is only known once the module is built.

## Inspecting the graph

`registry.compute.fields` lists every computed field with its rank and parsed paths; `registry.compute.triggers` maps
`model → key → dependents`. `shutro inspect` will print both.

## Computes in onchange drafts

A draft can lack a required relation (a new line before its order is chosen). For those records the compute is
skipped and the field stays empty until the relation is given, so inside a compute a required many2one in
`depends` is always set: write `l.order.currency.id`, not `l.order?.currency.id`.

## Related fields

A related field mirrors a field at the end of a many2one path. It is a compute underneath, so a stored related
field is recomputed when any step of the path changes, in batches, and audited like other stored computes.

```ts
partnerEmail: f.char({ ...related('partner.email', { writable: true }) }), // writes go to the partner
countryCode: f.char({ store: true, ...related('partner.country.code') }),  // a column: searchable, sortable
country: f.many2one('res.country', { store: true, ...related('partner.country') }),
```

The field's kind (and many2one target) must match the field the path ends at, and every step must be a
many2one: both are checked when the registry is built. An empty step gives `null`.

## Searching non-stored computed fields

Give the field a `search(operator, value)` that returns a domain on stored fields (annotate its parameters):

```ts
expensive: f.boolean({
  depends: ['price'],
  compute(records) { for (const p of records) p.expensive = p.price.gt(100); },
  search: (op: string, value: unknown) =>
    (op === 'eq' && value === true) || (op === 'ne' && value === false) ? { price: { gt: '100' } } : { price: { lte: '100' } },
}),

await env.model('product.product').search({ where: { expensive: true } });
```

The returned domain is compiled like any other (rules, paths, operators apply). Non-stored related fields are
searchable without one: they filter through their path.
