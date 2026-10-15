# Shutro RFCs

Design documents written **before** implementation (see `CLAUDE.md` → Workflow rules).
An RFC is only implemented after it has been approved and its status set to **Accepted**.

## Index

| #    | Title                                         | Status | Depends on |
| ---- | --------------------------------------------- | ------ | ---------- |
| 0001 | [Model & field definition API](0001-model-and-field-definition.md) | Accepted | — |
| 0002 | [Module registry & model extension](0002-module-registry-and-model-extension.md) | Accepted | 0001 |
| 0003 | [Environment & transaction context](0003-environment-and-transaction-context.md) | Accepted | 0001, 0002 |
| 0004 | [Recordsets, identity map & batched prefetch](0004-recordsets-identity-map-and-prefetch.md) | Accepted | 0001, 0002, 0003 |
| 0005 | [Query builder & SQL compiler](0005-query-builder-and-sql-compiler.md) | Accepted | 0001, 0002, 0003 |
| 0006 | [Money, decimals & currency](0006-money-decimals-and-currency.md) | Accepted | 0001, 0003, 0004, 0005 |
| 0007 | [PostgreSQL driver](0007-postgresql-driver.md) | Accepted | 0003, 0004, 0005, 0006 |
| 0008 | [Compute engine](0008-compute-engine.md) | Accepted | 0001, 0002, 0004 |
| 0009 | [Constraints and onchange](0009-constraints-and-onchange.md) | Accepted | 0001, 0004, 0008 |
| 0010 | [State machines](0010-state-machines.md) | Accepted | 0001, 0002, 0008, 0009 |
| 0011 | [Translatable fields](0011-translatable-fields.md) | Accepted | 0001, 0003, 0004, 0005 |
| 0012 | [Sequences](0012-sequences.md) | Accepted | 0001, 0003, 0010 |
| 0013 | [Audit trail](0013-audit-trail.md) | Accepted | 0001, 0003, 0004, 0008, 0010, 0012 |
| 0014 | [Security](0014-security.md) | Accepted | 0001, 0003, 0004, 0005 |
| 0015 | [Bulk operations, partitioning and benchmarks](0015-bulk-partitioning-benchmarks.md) | Accepted | 0004, 0007 |
| 0016 | [Aggregates and amount helpers](0016-aggregates-and-amount-helpers.md) | Implemented | 0004, 0006, 0014 |
| 0017 | [External IDs and module data](0017-external-ids-and-module-data.md) | Implemented | 0002, 0012, 0013 |
| 0018 | [Lost-update protection, transactional events, jobs and history](0018-concurrency-events-jobs-history.md) | Accepted | 0003, 0004, 0013 |

## Lifecycle

`Draft` → `In review` → `Accepted` → `Implemented` (or `Rejected` / `Superseded by NNNN`).

- Changing an **Accepted** RFC requires a new revision section at the bottom, or a superseding RFC.
- When an RFC is implemented, tick the matching roadmap checkbox in `CLAUDE.md`.

## Template

Every RFC uses these sections (omit only with a stated reason):

1. **Summary**: what is being decided, in five lines or fewer.
2. **Problem & ERP requirements**: what business software needs, as concrete requirements (R1, R2, …).
3. **How Odoo does it**: the mechanism, then its weaknesses.
4. **Prior art**: Prisma, Drizzle, Kysely, MikroORM.
5. **Options**: two or three serious options with a trade-off table.
6. **Decision**: the recommended option and why.
7. **Detailed design**: API with realistic ERP examples (partner, product, sale order, invoice).
8. **Type-level guarantees**: what the compiler rejects, with `expectTypeOf` sketches.
9. **Runtime metadata**: what Kosh / the CLI can introspect.
10. **Interactions**: with other RFCs.
11. **Open questions**: decisions still needed from reviewers.
12. **Deferred**: explicitly out of scope for this RFC.

## Conventions used in examples

- Example modules: `base` (res.partner, res.company, res.currency, res.users), `uom`, `product`,
  `sale`, `account`, `stock`, `sale_stock`, `sale_margin`. Names follow Odoo so comparisons are easy.
- Imports such as `@shutro/core` are illustrative; nothing in an RFC is a published API until implemented.
- Money is always `Decimal` (decimal.js) in code and `numeric` in PostgreSQL. Never `number`.
