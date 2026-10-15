# Shutro and the Odoo ORM

An honest comparison of Shutro 0.x with the Odoo ORM (17/18), for people choosing a data layer for business
software. Shutro is a data layer only: Odoo is a complete application platform, and much of what makes Odoo
valuable (web client, views, reports, thousands of modules) is outside an ORM's scope. The comparison is about the
ORM and the guarantees it gives application code.

Evidence for every Shutro claim is in the repository: 600+ tests against real PostgreSQL, an ERP demo (partner,
product, sale, invoice) with no casts in its modules, CI benchmarks with query budgets, and the RFCs in
[`docs/rfcs/`](rfcs/README.md).

## Where Shutro is ahead

| Area | Odoo | Shutro |
| ---- | ---- | ------ |
| **Types** | Python, no static types; `False` stands in for null; string field paths. | TypeScript end to end: models, load shapes (`NotLoaded` at compile time), domains, relation paths, `aggregate()` rows, typed compute / constraint / onchange / method callbacks from generated per-module views. |
| **Money** | `float` columns with `digits` rounding; monetary is a float with a currency field. | `Decimal` everywhere, `Money` with currency-checked arithmetic, per-currency rounding; aggregates never add two currencies (each currency is its own row). |
| **Default security** | Models without ACL are readable by everybody before 12; `sudo()` is a global switch on the environment. | Default deny on every model and field. `asSuperuser({ reason })` is scoped to a callback and audited; elevated methods declare exactly the grants they need (`elevate: ['sale.order.line:read']`), audited per call. |
| **Record rules in the database** | Rules are applied by the ORM only; raw SQL bypasses them. | Rules compile to SQL and can also be generated as PostgreSQL row-level security policies, so raw SQL and other services see the same rows. Relation paths in rules (`'order.user'`) compile to sub-selects that work in RLS too. |
| **Field security** | `groups=` hides fields in views and reads; filtering on hidden fields is possible through domains. | Field groups apply to reads, writes, filters, sorts, relation paths (`'partner.secret'`) and aggregates. |
| **Encrypted fields** | None in core. | AES-256-GCM with keys outside the database and key rotation. |
| **Permissions** | Groups, ACL CSV, record rules; feature checks by `has_group`. | Roles (groups with `implies`), administrator groups that need no grants, declared feature permissions (`definePermission`, `env.access.require`, `requires` on transitions), **special per-user grants** (`'account.backdate'`, `'account.move:unlink'`) loaded from the user record and impossible to claim from a session. |
| **Back-dated entries** | Lock dates per company (accounting only). | `backdate: { field, permission, graceDays }` on any model: earlier dates need a permission (role, special grant or administrator), checked on create, nested creates, bulk COPY and date changes. |
| **Audit** | `mail.thread` tracking: messages in an editable table, opt-in per field. | Append-only `shutro_audit` (a trigger forbids updates and deletes), per-field old/new, superuser and elevation rows with reasons. |
| **Sequences** | `ir.sequence` with `no_gap` via row locks. | Standard and gapless sequences, per-company and per-period resets, numbering at create or manually at posting (`assignNumber`), all concurrency-tested. |
| **Bulk and scale** | `create()` batches INSERTs; no COPY; no partitioning. | `COPY` bulk loads (documents with lines in one COPY per model), declarative range partitioning, references into partitioned tables, CI query budgets (2,000 records created in 7 statements). |
| **N+1** | Prefetching by recordset; no detector. | Prefetch groups plus a dev-mode inspector that reports N+1 patterns and slow statements. |
| **Migrations** | Schema auto-updated at module upgrade; columns are never dropped; no plan to review. | Diff against the live catalog, reviewed migration files with checksums, destructive changes refused unless allowed, SQL defaults for literal defaults, module data-migration hooks in version order. |
| **Errors** | `UserError` / `ValidationError` strings. | Typed errors (`AccessError`, `MissingRecordError`, `CurrencyMismatchError`, …), each with the problem and a hint. |
| **Reports** | `read_group` with `lazy`, untyped `__count` keys, monetary sums across currencies unless grouped by currency. | `aggregate()` with typed rows, date buckets in the user's time zone, rules / field groups / company scope applied, per-currency `Money` totals. |
| **Module data** | XML/CSV data files checked at install; every data record rewritten at each module update. | Typed `record()` / `override()` / `ref()`; every reference, field and override checked at `buildRegistry` (startup, CI); unchanged records skipped by checksum; `noupdate` records stay the users'. |
| **Runtime security** | Groups, ACLs and rules edited in the UI; a broken rule domain fails when users hit it. | Roles, access, rules and permission grants edited at runtime on top of the reviewed code baseline; rule domains compiled when saved; changes audited and reloaded in every process through NOTIFY. |
| **Feature parity, typed** | `related`, `_inherits`, `parent_path` / `child_of`, `company_dependent`, `search=`. | `related()` (stored or not, writable), `delegates`, `hierarchy` with `childOf` / `parentOf`, `companyDependent`, `search(operator, value)`: same capabilities, with kinds, paths and declarations checked at startup. |

## Where Odoo is ahead

Be clear about these before choosing:

- **Maturity and ecosystem.** Fifteen years in production and thousands of community modules. Shutro is alpha (0.x):
  its API may still change, and it has no production history.
- **Platform.** Views, the web client, QWeb reports, the mail / activity / chatter framework, cron and job queues,
  import / export UI, website and portal. Shutro provides the data layer for them (Kosh), not the features.
- **Lazy recompute on read.** Odoo recomputes a pending stored field when it is read. Shutro's field reads are
  synchronous, so after a write a dependent stored field is fresh after `await env.flush()` or a `load()`; reading it
  earlier throws instead of returning a stale value.
- **Smaller conveniences:** sorting on delegated / non-stored related fields, `name_search` / `display_name`
  conventions, and x2many fields through delegation are not there yet.
- **Multi-database per process.** Shutro is one registry per database.

## Choosing

Choose Shutro when you are building business software in TypeScript and want correctness guarantees from the
compiler and the database: money that cannot be a float, security that defaults to deny and holds in raw SQL,
an audit trail nobody can edit, and migrations you review. Choose Odoo when you want a complete ERP today and
can live with Python's dynamic typing and Odoo's conventions.
