# Shutro

**The ORM built for business software.** Shutro is a PostgreSQL-only ORM for Node.js and TypeScript, designed for
ERP workloads: type-safe, secure by default, modular, multi-company, multi-currency, audit-ready and fast at scale.
It is the data layer of the Kosh ERP framework.

> **Status: alpha (0.x).** The engine is tested end to end against real PostgreSQL (600+ tests, an ERP demo with
> partner, product, sale and invoice modules), but the API may still change between minor versions. Known gaps are
> tracked in [`docs/feedback.md`](docs/feedback.md).

```sh
npm install shutro
```

Requirements: Node.js ≥ 24, PostgreSQL ≥ 14.

## What it does

- **Models and modules**: `defineModel` with typed field builders, modules with dependencies, typed extension of
  other modules' models, explicit method overrides.
- **Recordsets**: batch-first `search` / `load` / `write` / `unlink`, typed load specs, no N+1 by construction.
- **Computed fields**: stored and non-stored, dependency graph built at startup, batched recompute before commit.
- **Constraints and onchange**: Python-free validators at flush points, form drafts with virtual records.
- **State machines**: transitions, guards and events as generated methods.
- **Multi-company and multi-currency**: automatic company scoping, cross-company link protection, dated rates,
  `Decimal` money (never floats).
- **Translations** in JSONB with language fallback; **sequences**, including gapless ones; append-only **audit trail**.
- **Security**: default-deny ACL, record rules compiled to SQL (following relations, e.g. "lines of my orders"),
  optional PostgreSQL row-level security, field-level security, encrypted fields with keys outside the database,
  verified identities, administrator roles that need no grants, feature permissions, special per-user grants,
  back-date permissions for transactions, and audited elevated methods.
- **Reports**: `aggregate()` (grouped totals with rules applied, per-currency `Money`), `records.sum()`.
- **Odoo-ORM parity, typed and checked at startup**: module data with external ids (`record`, `ref`, `env.ref`),
  related fields, delegation (`delegates`), hierarchies (`childOf` / `parentOf`), company-dependent fields, search
  on computed fields, and roles / access / rules editable at runtime.
- **Beyond Odoo**: compare-and-set writes against lost updates, transactional events (outbox) and PostgreSQL jobs
  with exactly-once database effects, and time travel (`history: true`, `env.asOf(instant)`).
- **Typed definitions**: `shutro generate` writes per-module bindings, so computes, checks, onchange handlers and
  methods are typed with no casts.
- **Migrations**: schema diff against the live catalog, versioned migration files, destructive-change guard.
- **Apps**: Settings, Accounting, Sales, Purchase and Project out of the box. Install and uninstall apps at runtime
  in one transaction each; an uninstalled app's data is kept in quarantine for 30 days and comes back on reinstall
  ([guide](docs/guides/apps.md)).
- **Tooling**: `shutro init | doctor | apps | migrate | generate | inspect`, dev-mode query inspector with N+1
  warnings, COPY bulk loads, partitioned tables, CI benchmarks.

## Quick start

```sh
npx shutro init my-erp      # asks a few questions, creates the database, installs the five default apps
cd my-erp && npm install
npx shutro apps             # what is installed; "shutro apps install | uninstall <app>" changes it
```

Or use the ORM alone (`npx shutro init --minimal`):

```ts
import { buildRegistry, createShutro, defineModel, defineModule, f } from 'shutro';
import { createDriver } from 'shutro/driver-pg';

const Partner = defineModel('res.partner', {
  access: { 'base.user': ['read', 'write', 'create'] },
  fields: { name: f.char({ required: true }), credit: f.decimal({ scale: 2, default: '0' }) },
});

const registry = buildRegistry({ modules: [defineModule({ name: 'base', models: [Partner] })] });
const shutro = createShutro({ driver: createDriver({ url: process.env.DATABASE_URL ?? '' }), registry });

await shutro.run({ user: 1, company: 1, groups: ['base.user'] }, async (env) => {
  const partners = await env.model('res.partner').search({ where: { name: { ilike: 'acme%' } } });
  return partners.length;
});
```

Entry points: `shutro` (core), `shutro/sql`, `shutro/driver-pg`, `shutro/migrate`, `shutro/apps`, `shutro/cli`, `shutro/security`,
`shutro/audit`, `shutro/sequence`, `shutro/i18n`.

## Documentation

- Guides: [`docs/guides/`](docs/guides/)
- Design documents (RFCs): [`docs/rfcs/`](docs/rfcs/README.md)
- A complete example: [`examples/erp-demo`](examples/erp-demo/README.md)
- How it compares with Odoo's ORM, including where Odoo is ahead: [`docs/odoo-comparison.md`](docs/odoo-comparison.md)

## Development

Requirements: Node.js ≥ 24, pnpm 11, and Docker for integration tests.

```sh
pnpm install
pnpm typecheck   # TypeScript 7, every package
pnpm lint        # Biome
pnpm test        # Vitest against real PostgreSQL (Testcontainers)
pnpm build       # dist/ for each package
node scripts/pack-npm.ts   # assemble the single `shutro` npm package in dist-npm/shutro
```

The repository is a pnpm workspace (`packages/*`); the npm package `shutro` bundles all of them. Contribution rules
(design first, test first, Conventional Commits) are in [`CLAUDE.md`](CLAUDE.md).

## Author

**Isahaq**, hmisahaq01@gmail.com, mobile +8801852376598

## License

[MIT](LICENSE)
