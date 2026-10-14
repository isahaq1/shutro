# Shutro

**The ORM built for business software.** Shutro is the data layer of the Kosh ERP framework: a
PostgreSQL-only ORM for Node.js and TypeScript that is type-safe, secure by default, modular,
multi-company, audit-ready and fast at scale.

> Status: **Phase 1, core (in progress).** No package is usable yet.
> Design decisions are in [`docs/rfcs/`](docs/rfcs/README.md).

## Repository layout

| Path | Contents |
| ---- | -------- |
| `packages/core` | Fields, `defineModel`, recordsets, environment, registry, compute engine |
| `packages/sql` | Typed query builder, SQL AST, parameterized renderer |
| `packages/driver-pg` | Pool, prepared statements, transactions, savepoints |
| `packages/migrate` | Schema diff and versioned migrations |
| `packages/security` | ACL, record rules, field security, RLS |
| `packages/audit` · `sequence` · `i18n` | Change tracking · document numbering · translations |
| `packages/cli` | `shutro init \| migrate \| generate \| inspect` |
| `packages/testing` | Test helpers, Testcontainers, factories |
| `docs/rfcs` | Design documents, written before implementation |

## Development

Requirements: Node.js ≥ 24, pnpm 11 (`packageManager` field), and Docker for integration tests.

```sh
pnpm install
pnpm typecheck   # tsc (TypeScript 7) for the root and every package
pnpm lint        # Biome
pnpm test        # Vitest; packages resolve to src/ through the "@shutro/source" export condition
pnpm build       # emits dist/ for each package
pnpm changeset   # record a release note for your change
```

Contribution rules (design first, test first, Conventional Commits) are in [`CLAUDE.md`](CLAUDE.md).
