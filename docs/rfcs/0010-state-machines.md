# RFC 0010 — State machines

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/core` (`f.state`, generated transition methods, `recordset/transitions.ts`), `extendModel`
- **Related:** 0001 §7.3 (`f.state` shape), 0002 §7.5 S6 (`statesAdd` / `transitionsAdd`), 0008 (triggers), 0009 (`ConstraintError`)
- **Resolves:** the state-machine runtime deferred by 0001

## 1. Summary

A `f.state` field declares states, an initial state and named transitions. This RFC makes transitions **generated,
overridable model methods** (`await orders.confirm()`), adds **guards** (a batch function returning the records that
may not transition) and **events** (`onExit` / `onEnter` on states, `before` / `after` on transitions), and lets
other modules add states and transitions (`fieldOverrides.state.statesAdd` / `transitionsAdd`) or wrap a transition
(`overrides.confirm(next)`). The state field stays unwritable: the only way to change it is a transition, which goes
through the unit of work like any write, so computes, constraints and (later) tracking react to it.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | Documents move through states (quotation → order → done; draft → posted → cancelled) along **declared** paths only; `state = 'done'` by hand is a bug. |
| R2  | Transitions are **batch** operations: confirming 500 orders is one method call and a bounded number of queries. |
| R3  | A transition is **all-or-nothing** for its batch: one record in the wrong state or failing a guard means none change. |
| R4  | **Guards** express business preconditions ("an order needs a line", "a journal entry must balance") with a user-facing message. |
| R5  | Modules **extend** workflows: `sale_stock` wraps `confirm` to create pickings; `sale_hold` adds a `hold` state and `resume` transition. Lower modules keep the meaning of their transitions (RFC 0002 S6). |
| R6  | The UI needs to know which transitions are **available** for a record. |

## 3. How Odoo does it

`state = fields.Selection([...])` plus plain methods (`action_confirm`) that `write({'state': 'sale'})` after ad-hoc
checks; `ensure_one` and `if self.state != 'draft': raise` are copy-pasted. Nothing declares the graph, the UI
derives buttons from view `states="draft"` attributes, and any module can `write` the state directly. Older Odoo had a
generic `workflow` engine (removed in 11.0 for being too dynamic).

## 4. Prior art

| Library | Notes |
| ------- | ----- |
| XState | Statecharts for UI; actors, guards, actions. Rich, but not record-oriented or batched. |
| AASM (Rails), django-fsm | Declarative `event :confirm, transitions from: :draft, to: :sale` with guards and callbacks, per object, writing the column; `django-fsm` protects the field (`protected=True`). The shape adopted here, batched. |
| Temporal / workflow engines | Long-running orchestration; out of scope. |

## 5. Options

### Option A — Methods written by hand that `write({ state })` (Odoo)

No graph to validate, no availability for the UI, unwritable state impossible.

### Option B — Declared transitions generating methods (chosen)

The field declares the graph; `defineModel` generates one method per transition; the field is unwritable.

### Option C — A separate workflow engine (Odoo ≤ 10)

Too dynamic for typed models; the removal from Odoo is the lesson.

## 6. Decision

Option B. Generated methods are ordinary methods for the registry (`overrides` compose over them, `methodLayers`
show them), for the type generator (they appear in `methods`) and for recordsets (`orders.confirm()`).

## 7. Detailed design

### 7.1 Declaration

```ts
state: f.state({
  states: {
    draft: 'Quotation',
    sale: { label: 'Sales Order', onEnter: async (orders) => { ... } },      // string, or label + events
    cancel: { label: 'Cancelled', onExit: (orders) => { ... } },
  },
  initial: 'draft',
  transitions: {
    confirm: {
      from: ['draft'], to: 'sale',
      guard: (orders) => orders.filter((o) => o.lines.length === 0),         // the records that may not transition
      message: 'Add at least one line before confirming.',
      before: async (orders) => { ... },
      after: async (orders) => { ... },
    },
    cancel: { from: ['draft', 'sale'], to: 'cancel' },
  },
  extensible: true,                                                          // allows statesAdd / transitionsAdd
}),
```

`defineModel` generates `methods.confirm` and `methods.cancel` (`(): Promise<void>`). A declared method with a
transition's name is an `InvalidModelError` (the transition *is* the method; wrap it with `overrides` instead).

### 7.2 Running a transition (`await records.confirm()`)

1. Load the state of the records (one query when missing).
2. Every record must be in a `from` state, else `InvalidTransitionError` (model, transition, the offending ids with
   their states, the allowed states). Nothing changes (R3).
3. `guard`, if any, runs once with the recordset; the records it returns fail with `TransitionGuardError` carrying
   the transition's `message` (or a default). Guards may load what they need; they run before any hook.
4. Events, batched: `onExit` of each source state (one call per distinct state), the transition's `before`, the
   state write, the transition's `after`, `onEnter` of the target state.
5. The state write is a system write: cache + journal + dirty + triggers (RFC 0008 §7.2), so computed fields and
   constraints depending on `state` run at the next flush point, and the savepoint journal undoes it on rollback.

Overrides wrap the whole sequence: `overrides: { async confirm(next) { await next(); await this.createPickings(); } }`.

### 7.3 Availability (R6)

`record.transitions()` (singleton, state loaded) returns the transition names whose `from` contains the current
state; `describe()` lists states and transitions for the UI, as before.

### 7.4 Extension (R5)

`fieldOverrides.state.statesAdd: { hold: 'On hold' }` and `transitionsAdd: { hold: { from: ['sale'], to: 'hold' },
resume: { from: ['hold'], to: 'sale' } }` on an `extensible` state field. New transitions generate methods when the
registry rebuilds the model; existing states and transitions are never changed or removed (S6).

### 7.5 Schema

The column stays `text`; values are validated by the ORM. A `CHECK (state IN (...))` would turn every `statesAdd`
into a migration and is not emitted (see §12).

### 7.6 Types

- `Model.methods` is the declared methods plus `TransitionMethods<Fs>`: `{ confirm(): Promise<void>; ... }` per state
  field. The generated views (RFC 0002 §7.7) pick them up through `F.Methods`.
- Recordsets expose the model's methods: `RecordSet<S, M, L>` is now the recordset API intersected with
  `MethodsOf<S, M>`, so `orders.confirm()` type-checks (this was missing until now: methods were only callable by the
  engine).
- `create()` / `write()` exclude the state field (RFC 0001 §7.3).

## 8. Type-level guarantees

`initial`, `from`, `to` are checked against the state keys at the declaration site (RFC 0001 §8); transition methods
exist on `Model['methods']` with the right signature; `write({ state })` is a type error.

## 9. Runtime metadata

`describe()` of a state field: `states`, `initial`, `transitions` (from / to, `guarded: true` when a guard exists).
`registry.explain(model, 'confirm')` shows the generated definition and the overrides.

## 10. Interactions

- **Compute / constraints (0008, 0009):** the state write records triggers; `depends: ['state']` works.
- **Audit (later):** state fields are tracked by default (`tracking: true`), so transitions appear in the trail.
- **Security:** transitions are methods; method-level ACL applies to them.

## 11. Resolved questions

1. **Why not `write({ state: 'sale' })` with validation?** Declared paths are the point (R1); the method is also the
   extension point (R5).
2. **Events vs. a bus.** Hooks on states and transitions plus `overrides` cover every ERP case seen so far without a
   global emitter; a bus can come with jobs.

## 12. Deferred

- A `CHECK` constraint over the state values (needs migrations that follow `statesAdd`).
- Transition parameters (`cancel({ reason })`), timed transitions, parallel regions.
