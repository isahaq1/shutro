# State machines

[RFC 0010](../rfcs/0010-state-machines.md). A `f.state` field declares the states and the transitions between them;
each transition becomes a method, the field itself is never written directly.

```ts
state: f.state({
  states: {
    draft: 'Quotation',
    sale: { label: 'Sales Order', onEnter: async (orders) => { /* event */ } },
    cancel: 'Cancelled',
  },
  initial: 'draft',
  transitions: {
    confirm: {
      from: ['draft'],
      to: 'sale',
      guard: (orders) => orders.filter((o) => o.lines.length === 0),   // records that may not transition
      message: 'Add at least one line before confirming.',
      before: async (orders) => { /* event */ },
      after: async (orders) => { /* event */ },
    },
    cancel: { from: ['draft', 'sale'], to: 'cancel' },
  },
  extensible: true,
}),
```

```ts
await orders.confirm();           // generated method, batch
order.transitions();              // ['cancel', 'hold'] — what the current state allows
await order.write({ state: 'sale' }); // ❌ type and runtime error: state changes only through transitions
```

## What a transition does

1. Loads the state of the records (one query if needed) and checks every record is in a `from` state;
   otherwise `InvalidTransitionError` lists the offending ids with their states, and **nothing changes**.
2. Runs the `guard` once with the whole batch; the records it returns fail with `TransitionGuardError` and the
   transition's `message`. Guards may `load()` what they need.
3. Runs the events, each once per batch: `onExit` of each source state, `before`, the state write, `after`,
   `onEnter` of the target state.
4. The state write goes through the unit of work: computed fields and constraints that depend on `state` run at the
   next flush point, a savepoint rollback undoes it, and the audit trail (later) records it.

## Extending a workflow

```ts
extendModel('sale.order', {
  fieldOverrides: {
    state: {
      statesAdd: { hold: 'On hold' },
      transitionsAdd: { hold: { from: ['sale'], to: 'hold' }, resume: { from: ['hold'], to: 'sale' } },
    },
  },
  overrides: {
    async confirm(next) { await next(); await this.createPickings(); },
  },
});
```

Additions need `extensible: true` on the field; existing states and transitions are never changed or removed, so
lower modules keep the meaning of their transitions. New transitions become methods on the rebuilt model with the
extension module as their origin (`registry.explain('sale.order', 'hold')`).

## Types

`Model['methods']` includes a `(): Promise<void>` per transition, recordsets expose the model's methods
(`RecordSet<S, M, L>` now carries `MethodsOf<S, M>`), and `create()` / `write()` exclude the state field.
