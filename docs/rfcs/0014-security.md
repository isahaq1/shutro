# RFC 0014 — Security

- **Status:** Accepted (2026-10-15)
- **Scope:** `@shutro/security` (groups, ACL, rules, field groups, RLS policy text, encryption), `@shutro/core` (enforcement on every user-facing read and write, `env.access`, `rlsStatements`)
- **Related:** 0003 §7.1 / §7.6 (identity, session settings, superuser), 0004 (loads, flush), 0005 §7.4 (rule injection, `$env` placeholders), 0013 (audited superuser scopes)

## 1. Summary

Access is **denied by default** and granted by data declared in modules:

1. **Groups** (`defineGroup({ code, implies })`) with inheritance; a user's identity names groups, the registry closes
   them over `implies`.
2. **Model ACL** (`access: { 'sale.user': ['read', 'write', 'create'] }`) per group with six permissions: `read`,
   `write`, `create`, `unlink`, `export`, `import`. Extensions add permissions, never remove.
3. **Record rules** (`rules: { own: { groups, perms, domain } }`): domains with `{ $env: 'uid' | 'companyId' |
   'companyIds' }` placeholders, compiled into the `WHERE` of every user search and load, checked per record on
   `write`, `unlink`, transitions and after `create`. Globals AND, group rules OR (Odoo semantics).
4. **Field groups** (`groups: ['hr.manager']` or `{ read, write }`): restricted fields are left out of default
   projections, refused in load specs, filters, sorts, reads and writes.
5. **Optional PostgreSQL RLS**: `rlsStatements(registry)` generates policies from the same record rules over the
   session settings `shutro.run()` pushes (`shutro.user_id`, `shutro.company_id(s)`, `shutro.groups`, `shutro.su`),
   so raw SQL, reports and other clients are bound by the same rules.
6. **Encrypted fields** (`f.char({ encrypted: true })`): AES-256-GCM with an application **key ring**
   (`createKeyRing({ current, keys })`) that never enters the database; rotation by key id; not filterable.

Superuser scopes (`env.asSuperuser({ reason })`, audited) bypass 2–4 and set `shutro.su` for 5. The engine's own
loads (computes, constraints, audit snapshots, sequences, drafts) are system reads: rules apply to what the user
asks for, not to what the engine needs to keep the data consistent.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | A salesperson sees their orders, a manager every order, accounting every invoice but no HR data: per-model, per-record and per-field. |
| R2  | **Default deny**: a model a module forgot to grant is invisible, not public. |
| R3  | No bypass through relations (`order.partner.secret`), searches (filtering on a hidden field leaks it), bulk operations (one forbidden id in a batch), x2many commands, or raw SQL. |
| R4  | Rules are data: storable, serializable, generated into database policies, reviewable without reading Python. |
| R5  | Secrets at rest (national ids, bank details) are unreadable in dumps and backups; keys rotate without downtime. |
| R6  | Privilege elevation is explicit, scoped and audited (RFC 0003 R6). |

## 3. How Odoo does it

`ir.model.access` CSV rows (model × group × 4 perms), `ir.rule` records with Python domains evaluated by
`safe_eval`, `groups=` on fields and views, `sudo()`. Checks run in `check_access_rights` / `check_access_rule` on
`read`, `write`, `create`, `unlink`; search domains get the rules injected. Weaknesses: default *allow* for models with
no access row in older versions (and silent "no access row" warnings), rules as Python strings, `sudo()` leaking,
no database-level enforcement (raw SQL bypasses everything), no encryption.

## 4. Prior art

PostgreSQL RLS (policies per command, permissive OR / restrictive AND); Rails Pundit / CanCan (policy objects per
model, no SQL injection of rules); Prisma / Drizzle (nothing); Hasura (role-based permissions compiled into
GraphQL resolvers, row filters with session variables — the model for §7.5). Field encryption: Rails
`ActiveRecord::Encryption` (deterministic or random, key rotation by key id), which §7.6 follows.

## 5. Options

- **A — ORM-only enforcement** (Odoo): complete for ORM traffic, bypassed by SQL.
- **B — Database-only (RLS)**: binds every client, but policies can't express ACL per permission cleanly, know
  nothing about fields, and make errors opaque (empty results instead of `AccessError`).
- **C — ORM enforcement with optional RLS generated from the same rules (chosen)**: typed errors and field
  security from the ORM; raw SQL, reports and foreign clients bound by the database.

## 6. Decision

Option C. The pure logic lives in `@shutro/security` (no core dependency), so Kosh and tests can evaluate access
without a database; core wires it into every user-facing path.

## 7. Detailed design

### 7.1 Groups and identity

`defineModule({ groups: [defineGroup({ code: 'sale.manager', implies: ['sale.user'] })] })`. Codes are
`module.name`, global, declared once. `shutro.run({ user, company, groups: ['sale.manager'] })` names the user's
direct groups (the application loads them from its user model); `env.groups` is the closure. Access and rule
declarations must name declared groups (build error otherwise).

### 7.2 Model ACL

`defineModel({ access: { 'sale.user': ['read', 'write', 'create'], 'sale.manager': ['read', 'write', 'create',
'unlink', 'export'] } })`; `extendModel({ access })` merges (union). `read` is checked by `search`, `load`,
`onchange`, `trail`; `create` / `write` / `unlink` by the write runtime (so x2many commands are covered);
`export` / `import` through `env.access.can(model, perm)` / `check` for the application. A model without an entry
for any of the user's groups is denied (R2).

### 7.3 Record rules

```ts
rules: {
  own:     { groups: ['sale.user'],    perms: ['read', 'write'],                    domain: { user: { $env: 'uid' } } },
  all:     { groups: ['sale.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
  company: { groups: 'global',         perms: ['read', 'write', 'create', 'unlink'], domain: { company: { in: { $env: 'companyIds' } } } },
}
```

For an operation: the global rules are ANDed; the group rules whose groups intersect the user's are ORed and ANDed
to the globals; a user none of whose groups any group rule names is unrestricted by group rules (Odoo semantics,
tested). Domains support `or` / `and` / `not`, added to the domain compiler with this RFC.

Enforcement: `search` and every user `load` (including many2one and x2many targets) add the `read` conditions to the
statement; ids that come back missing are told apart — out of scope is `AccessError` with the ids, non-existent is
`MissingRecordError`. `write`, transitions and `unlink` check the ids against the `write` / `unlink` rules before
changing anything; `create` checks the inserted rows against the `create` rules (the transaction fails if they are
out of scope). Engine loads (`ComputeHost`) carry no rules.

### 7.4 Field groups

`f.char({ groups: ['hr.manager'] })` or `{ read: ['hr.user'], write: ['hr.manager'] }` (writing implies reading).
Default projections of `search` skip unreadable fields; a load spec, a domain key, an order key, a record read or
a write naming one is an `AccessError` with the field. `registry` rejects undeclared group codes.

### 7.5 PostgreSQL RLS

`rlsStatements(registry)` returns, for every model with rules: `ENABLE` / `FORCE ROW LEVEL SECURITY` and, per
operation with rules, one PERMISSIVE policy per group rule (`shutro.su OR (groups && ARRAY[...] AND domain)`), one
RESTRICTIVE policy per global rule (`shutro.su OR domain`), and a PERMISSIVE policy for users none of whose groups
a rule names (`NOT (groups && ARRAY[all rule groups])`). Placeholders become `current_setting()` reads; literals
from the domain are inlined (identifiers from the registry, values quoted). `shutro.run()` pushes
`shutro.user_id`, `shutro.company_id`, `shutro.company_ids`, `shutro.groups` (closed, comma-separated) and
`shutro.su = '0'`; `asSuperuser` sets `shutro.su = '1'` for the call (`set_config(..., true)`). The application
connects as a role that is not the table owner nor a superuser (the tests create one). Model ACL and field groups
have no RLS counterpart (R3 for raw SQL covers rows, not columns: use views or column grants).

### 7.6 Encrypted fields

`f.char({ encrypted: true })` / `f.text`: column `text`, value `shutro1:<keyId>:<iv>:<tag>:<ciphertext>` (AES-256-GCM,
random IV). `createShutro({ keys: createKeyRing({ current: 'k2', keys: { k1, k2 } }) })`: writes use `current`, reads
use the key the token names, so rotation is "add the new key, switch `current`, re-encrypt at leisure". Reading
without the key or with a tampered token is an `EncryptionError`. Encrypted fields cannot be filtered or sorted on
(`InvalidDomainError`), cannot be `translate`, and the audit trail records `[encrypted]` instead of values.

### 7.7 Superuser

`env.asSuperuser({ reason }, fn)`: ACL, rules and field groups are skipped for `fn`'s environment, `shutro.su` is
`'1'` for the call, and an audit `su` row is written (RFC 0013). Multi-company checks still apply (RFC 0003 §7.6).

### 7.8 Relation paths and verified identities (amendment)

Domains accept dotted many2one paths and x2many `{ any | none }` (feedback #11). A path segment compiles to
`col IN (SELECT "id" FROM target WHERE …)` (`none` on a many2one also matches `NULL`), a one2many to
`"id" IN (SELECT inverse FROM target WHERE …)` and a many2many through its junction table. Sub-selects, not joins, so
the same SQL is valid inside RLS policies and never duplicates rows. In user searches each sub-select also carries the
target's read rules, so `partners where orders.any(name = 'B')` cannot reveal an order the user cannot read; rules
themselves compile without them (no rule→rule recursion through cycles such as order ↔ lines). User domains are checked along the path
(field groups, target read ACL). An optional `identity` loader on `createShutro` verifies each run's user, companies
and groups (feedback #6).

### 7.9 Administrators, feature permissions, special grants, back-dating (amendment)

- `defineGroup({ administrator: true })`: members (closure over `implies`) bypass ACL, rules, field groups,
  permissions and back-date rules on every model; RLS sees `shutro.su = 1` for their transactions. Company scoping
  and `checkCompany` stay. Their changes are audited as themselves (not as superuser scopes).
- `definePermission({ code, label, groups })` in modules; `env.access.has / require`; `requires` on transitions,
  validated at registry build.
- `grants` on the identity (and `VerifiedIdentity`): permission codes and `model:perm` operations for one user.
  A loader's grants bound what a session may claim.
- `backdate: { field, permission, graceDays }` on models: dates before `today - graceDays` need the permission, on
  create (including COPY and nested creates) and on writes of the field.

## 8. Type-level guarantees

`access` perms and rule perms are literal unions; `env.access.can(model, perm)` takes model names of the schema;
`groups` on fields is `readonly string[] | { read?, write? }`.

## 9. Runtime metadata

`describe()` lists `access`, `rules` (serializable), per-field `groups` and `encrypted`; `registry.security.groups`
and `closure()`; `modelPolicies(model)` for inspection.

## 10. Interactions

- **Audit (0013):** `records.trail()` needs `read`; encrypted values are masked.
- **Migrate:** `rlsStatements` are DDL to run after the schema (a `shutro migrate --rls` step comes with the CLI).
- **Kosh:** menus and buttons from `env.access`; field visibility from `canField`.

## 11. Resolved questions

1. **Where do groups come from?** The identity (`run({ groups })`); the ORM does not own the user model.
2. **Engine loads and rules.** System reads bypass rules: a total must be right even when the user cannot read
   every line that makes it up. Exposure is governed at the user-facing boundary.
3. **Rules in flush statements?** Checked before the change (and after `create`), not re-applied to the `UPDATE`:
   engine-made changes (recomputes) of records the user may not write are consequences of allowed writes.

## 12. Deferred

- `.withRules()` on the query builder (RFC 0005 §7.8) and `UnscopedQueryError` for raw builder queries.
- Method-level permissions, column grants / views for field security under RLS, deterministic encryption for
  equality search, key rotation tooling (`shutro reencrypt`).
