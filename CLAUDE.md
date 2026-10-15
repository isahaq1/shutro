# Shutro — Project Instructions for Claude Code

## Mission

Shutro is **the ORM built for business software**. It is the data layer of the
Kosh ERP framework and is designed to be better than Odoo's ORM: type-safe,
secure by default, modular, multi-company, audit-ready and fast at scale.

Shutro is NOT a general-purpose ORM. For every decision ask:
**"Does this help developers build ERP / business software?"** If not, leave it out.

## Tech stack (do not change without an approved RFC)

- Language: TypeScript, `strict: true`, ESM only, no `any` (use `unknown` + narrowing)
- Runtime: Node.js LTS
- Database: **PostgreSQL only** (latest stable). Use its features fully:
  JSONB, row-level security, LISTEN/NOTIFY, partitioning, GROUPING SETS,
  generated columns, advisory locks.
- Driver: `postgres` (postgres.js), wrapped by `@shutro/driver-pg` (RFC 0007, measured in spike 0002)
- Money/decimals: PostgreSQL `numeric` + `decimal.js` (isolated clone, precision 64). **Never** JS `number` for money or quantities.
- Validation: Standard Schema compatible (users can plug in Zod, Valibot, etc.)
- Monorepo: pnpm workspaces + Turborepo
- Testing: Vitest + Testcontainers (real PostgreSQL) + fast-check (property-based)
- Lint/format: Biome
- Releases: Changesets

## Core principles

1. **PostgreSQL-only, on purpose** — no multi-database abstraction.
2. **Type-safe by default** — anything checkable at compile time must be.
3. **Secure by default** — access denied unless granted; no string-concatenated SQL ever.
4. **Explicit over magic** — extensions are traceable; no hidden monkey-patching.
5. **Batch-first** — every operation works on sets of records (recordsets), never one-by-one.
6. **ERP-first** — money, companies, currencies, rules, audit, workflows are core, not plugins.

## Package layout

```
packages/
  core/        # fields, defineModel, recordsets, environment, registry, compute engine
  sql/         # typed query builder -> AST -> parameterized SQL
  driver-pg/   # connection pool, prepared statements, transactions, savepoints
  migrate/     # schema diff, versioned migrations, module data-migration hooks
  security/    # model ACL, record rules, field security, RLS integration
  audit/       # append-only change tracking
  sequence/    # concurrency-safe document numbering
  i18n/        # translatable JSONB fields
  cli/         # shutro init | migrate | generate | inspect
  testing/     # test helpers, Testcontainers setup, factories
examples/
  erp-demo/    # real ERP modules (partner, product, sale, invoice) used as integration tests
docs/
  rfcs/        # design documents — written BEFORE implementation
```

## Architecture layers (bottom to top)

1. Connection layer — pooling, prepared statements, PgBouncer compatibility, replica routing
2. SQL compiler — typed query builder, AST, always parameterized
3. Model & field layer — `defineModel()`, rich field types
4. Registry & module system — dependency-ordered loading, model extension, type generation
5. Environment — `AsyncLocalStorage` carrying user, company, allowed companies, lang, tz, transaction
6. Recordset engine — identity map, batched prefetch (no N+1), unit of work
7. Compute engine — dependency graph at startup, dirty tracking, batched recompute before commit
8. Business features — constraints, onchange, state machines, sequences, multi-company, multi-currency, translations, archiving
9. Security — ACL, record rules compiled to SQL WHERE + optional PostgreSQL RLS, field-level security
10. Events — domain events, transactional outbox, LISTEN/NOTIFY
11. Metadata API — full schema introspection for Kosh (APIs, views, forms)
12. Migration engine — model/database diff, versioned migrations

## In-scope features

Accounting-safe money and decimals · multi-company and multi-currency ·
record rules and audit trails · computed fields · workflows and state machines ·
modular extension · translations · sequences · bulk data operations ·
reporting performance.

## Out of scope

Other databases, browser/mobile/embedded use, non-business app patterns.

## Target API (as decided in RFCs 0001–0006)

```ts
// Each module imports from its own generated bindings, typed to the models it can see (RFC 0002)
import { defineModel, extendModel, f } from '../.shutro/bindings.js';

export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },                      // adds `company`
  tracking: ['state', 'partner', 'amountTotal'],
  fields: {
    name: f.char({ required: true, readonly: true, sequence: 'sale.order' }),
    partner: f.many2one('res.partner', { required: true }),          // relations by model name (RFC 0001 §5.4)
    currency: f.many2one('res.currency', { required: true }),
    lines: f.one2many('sale.order.line', 'order'),
    amountTotal: f.monetary({
      currency: 'currency',
      store: true,
      depends: ['lines.subtotal'],                           // typed path
      compute(orders) {                                      // batch; depends are pre-loaded (RFC 0004)
        for (const o of orders) o.amountTotal = o.lines.sum('subtotal');   // Money (RFC 0006)
      },
    }),
    state: f.state({
      states: { draft: 'Quotation', sale: 'Sales Order', cancel: 'Cancelled' },
      initial: 'draft',
      transitions: {
        confirm: { from: ['draft'], to: 'sale' },
        cancel: { from: ['draft', 'sale'], to: 'cancel' },
      },
    }),
  },
});

// Another module (sale_stock) extends it. It's typed by its own module view, and the override is explicit
export const SaleOrderStock = extendModel('sale.order', {
  fields: { deliveryDate: f.date() },
  overrides: {
    async confirm(next): Promise<void> { await next(); await this.createPickings(); },
  },
});

// Usage: explicit env, batched loads, typed sync access afterwards (RFCs 0003, 0004)
await shutro.run({ user, company }, async (env) => {
  const orders = await env.model('sale.order').search({ where: { state: 'sale' } });
  const loaded = await orders.load({ partner: ['name'] });
  for (const o of loaded) console.log(o.partner.name, o.amountTotal.format(env.lang));
});
```

## Coding rules

- Every SQL value is parameterized. Raw SQL only via the `sql\`...\`` tagged template.
- Money: `Decimal` in code, `numeric` in DB, rounding by currency precision.
- Monetary arithmetic across different currencies must be impossible without explicit conversion (with a date).
- All public APIs have TSDoc comments and full type inference — no casts required by users.
- Errors are typed classes with a clear message explaining what went wrong AND how to fix it.
- Minimize dependencies. Justify every new dependency in the PR/commit message.
- No global mutable state except the registry; context flows through the environment.

## Workflow rules for Claude Code

1. **Design before code.** For any new subsystem, write `docs/rfcs/NNNN-name.md`
   (problem, options considered, decision, API examples, trade-offs) and wait for approval.
2. **Plan, then implement in small steps.** Show the plan first; implement one step at a time.
3. **Test-first for core logic.** Tests run against real PostgreSQL via Testcontainers.
4. Before declaring a task done, run: `pnpm typecheck`, `pnpm lint`, `pnpm test` — all must pass.
5. Small, focused commits with clear messages (Conventional Commits).
6. If a requirement is ambiguous or conflicts with these principles, **ask** instead of guessing.
7. Update this file's roadmap checkboxes and the relevant RFC when work is completed.

## Definition of done

- Types: no `any`, full inference verified with type tests (`expectTypeOf`)
- Tests: unit + integration on PostgreSQL; property tests for query compiler and decimals
- Security: injection and permission-bypass tests where relevant
- Docs: TSDoc + usage example in `docs/`
- Performance: no N+1 queries (verified by query-count assertions in tests)

## Roadmap

### Phase 0 — Research & design
- [x] RFC 0001: Model & field definition API
- [x] RFC 0002: Module registry & model extension (with type generation)
- [x] RFC 0003: Environment & transaction context
- [x] RFC 0004: Recordset, identity map & prefetch
- [x] RFC 0005: Query builder & SQL compiler
- [x] RFC 0006: Money, decimals & currency

### Phase 1 — Core
- [ ] Monorepo scaffold, CI, tooling
- [x] Driver layer, transactions, savepoints (`@shutro/driver-pg`, RFC 0007; replica routing deferred)
- [x] SQL compiler (select/insert/update/delete, joins, aggregates) (`@shutro/sql`; domains and record rules come with the registry)
- [x] Basic fields + CRUD + relations (many2one, one2many, many2many)
- [x] Environment via AsyncLocalStorage (`createShutro`, `Env`; `env.model()` comes with the registry)
- [x] Recordsets with batched prefetch

### Phase 2 — Schema & modules
- [x] Schema diff + migrations (`@shutro/migrate`: catalog diff, versioned SQL files, ledger, module data-migration hooks)
- [x] Module registry, dependency ordering, model extension (mixins and module flags pending)
- [x] Type generation (`shutro generate`: per-module and application views, `--check`; paths and --watch pending)

### Phase 3 — ERP engine
- [x] Computed fields (stored / non-stored) + dependency graph (RFC 0008: triggers, rank-ordered batched recompute at flush points, non-stored on load, inverse)
- [ ] Constraints & onchange
- [ ] State machines
- [ ] Multi-company & multi-currency
- [ ] Translations (JSONB)
- [ ] Sequences (incl. gapless)
- [ ] Audit trail

### Phase 4 — Security
- [ ] Model ACL, record rules, field security
- [ ] PostgreSQL RLS integration
- [ ] Encrypted fields

### Phase 5 — DX & performance
- [ ] CLI, query inspector, schema explorer
- [ ] Bulk operations (COPY), partitioning support
- [ ] Benchmarks in CI

### Phase 6 — Proof
- [ ] `examples/erp-demo`: partner, product, sale, invoice modules built on Shutro
