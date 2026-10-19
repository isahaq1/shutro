# Contributing to Shutro

Thank you for helping. Shutro is the ORM built for business software, so every change is weighed against one question:
**does it help people build ERP and business applications?**

## Before you start

- **Bugs:** open an issue with the smallest reproduction you can (a model, the call, the SQL or error you got).
- **Features and design changes:** open an issue first. Anything that adds a subsystem or changes a public API needs a
  short design document in [`docs/rfcs/`](docs/rfcs/README.md) (problem, options, decision, API examples, trade-offs),
  agreed before code is written.
- **Security issues:** never in public issues. See [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements: Node.js 24 or newer, pnpm 11, and Docker (integration tests start PostgreSQL 18 with Testcontainers).

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test        # unit and integration tests against real PostgreSQL
pnpm build
```

Run one package's tests with `pnpm vitest run packages/<name>`. The web client builds with `pnpm --filter @shutro/web build`
and runs against a database with `shutro init` followed by `shutro serve`.

## Rules for code

- **TypeScript strict, ESM, no `any`.** Use `unknown` and narrow it. Public APIs need TSDoc and must infer their types;
  users should never need a cast.
- **PostgreSQL only.** Use its features fully; do not add abstractions for other databases.
- **No string-built SQL.** Every value is a parameter; raw SQL goes through the `sql` tagged template.
- **Money is `Decimal` in code and `numeric` in the database**, never a JavaScript `number`.
- **Errors are typed classes** whose message says what went wrong and how to fix it.
- **Batch-first:** operations work on sets of records; no per-record queries (tests assert query counts).
- **Dependencies:** as few as possible; justify every new one in the pull request.

## Tests

Tests come first for core logic, and they run against a real PostgreSQL, not mocks. Add property-based tests
(fast-check) for parsers, the query compiler and decimal arithmetic; add injection and permission-bypass tests for
anything that touches SQL or security.

## Commits and pull requests

- Small, focused commits following [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat(core): …`, `fix(server): …`, `docs: …`).
- A pull request passes `pnpm typecheck`, `pnpm lint` and `pnpm test`, updates the relevant guide in `docs/guides/`,
  and adds a changeset (`pnpm changeset`) when it changes a published package.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
