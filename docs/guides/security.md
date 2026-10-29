# Security

[RFC 0014](../rfcs/0014-security.md). Access is **denied by default**; modules grant it as data.

## Groups

```ts
export const sale = defineModule({
  name: 'sale',
  groups: [
    defineGroup({ code: 'sale.user', label: 'Sales user', implies: ['base.user'] }),
    defineGroup({ code: 'sale.manager', label: 'Sales manager', implies: ['sale.user'] }),
  ],
  models: [SaleOrder],
});

await shutro.run({ user: alice.id, company, groups: ['sale.user'] }, fn);   // the application loads the user's groups
env.groups;                                                                    // Set { 'sale.user', 'base.user' }
```

## Model ACL and record rules

```ts
export const SaleOrder = defineModel('sale.order', {
  access: {
    'sale.user':    ['read', 'write', 'create'],
    'sale.manager': ['read', 'write', 'create', 'unlink', 'export', 'import'],
  },
  rules: {
    own:     { groups: ['sale.user'],    perms: ['read', 'write'],                     domain: { user: { $env: 'uid' } } },
    all:     { groups: ['sale.manager'], perms: ['read', 'write', 'create', 'unlink'], domain: {} },
    company: { groups: 'global',         perms: ['read', 'write', 'create', 'unlink'], domain: { company: { in: { $env: 'companyIds' } } } },
  },
  fields: {
    user: f.many2one('res.users', { required: true, default: (env) => env.uid }),
    margin: f.decimal({ scale: 2, groups: ['sale.manager'] }),              // field groups: read and write
    ssn: f.char({ encrypted: true, groups: { read: ['hr.manager'], write: ['hr.manager'] } }),
  },
});
```

- **ACL**: a model without an entry for any of the user's groups is denied. `read` guards `search`, `load`,
  `onchange` and `trail`; `create` / `write` / `unlink` guard the write runtime, so x2many commands are covered;
  `export` / `import` are for the application (`env.access.can('sale.order', 'export')`). Extensions add
  permissions and rules, never remove them.
- **Record rules**: global rules are ANDed, the group rules that name one of the user's groups are ORed; a user none
  of whose groups any rule names is unrestricted by group rules. Rules are compiled into every user search and
  load (relations included); `browse(id).load()` on a record out of scope is an `AccessError` naming the ids
  (`MissingRecordError` when it does not exist); `write`, transitions and `unlink` check the ids first; `create`
  checks the inserted rows and fails the transaction if they are out of scope. Domains take `or` / `and` / `not`.
  They follow relations: `{ 'order.user': { $env: 'uid' } }` ("lines of my orders"), `{ lines: { any: { … } } }`,
  `{ tags: { none: { … } } }`. Paths compile to sub-selects, so the same rule works in RLS policies.
- **Field groups**: an array restricts both reading and writing, `{ read, write }` separately. Restricted fields are
  left out of default projections and are an `AccessError` in load specs, filters, sorts, reads and writes.
- **Superuser**: `env.asSuperuser({ reason }, fn)` skips all three for `fn` (audited, RFC 0013). The engine's own
  loads (computes, constraints, audit snapshots) carry no rules; what the user *sees* is governed at the boundary.

## Administrators

```ts
defineGroup({ code: 'base.admin', label: 'Administrator', implies: ['base.user'], administrator: true });
```

Members of an administrator group, directly or through `implies`, pass every check on every model and feature of
every module: ACL, record rules, field groups, feature permissions, transition requirements and back-date rules. No
model needs to grant them anything. In RLS mode their transactions set `shutro.su = 1`, so the database policies let
them through too. Company scoping still applies: an administrator works in the companies of the session. Other users
stay default-deny. Unlike `env.asSuperuser({ reason })` (an audited elevation for one call), an administrator acts as
themselves and their changes are audited under their own user.

## Roles, feature permissions and special grants

Roles are groups (`defineGroup`), and models grant operations to them (`access`). Features that are not a model
operation (an app, a menu, a button, an approval) are **permissions**, declared by modules and granted to roles:

```ts
defineModule({
  name: 'sale',
  permissions: [definePermission({ code: 'sale.discount_approve', label: 'Approve discounts', groups: ['sale.manager'] })],
  // ...
});

env.access.has('sale.discount_approve');      // boolean, for menus and buttons
env.access.require('sale.discount_approve');  // AccessError unless granted
// on a transition: approve: { from: ['draft'], to: 'approved', requires: 'sale.discount_approve' }
```

**Special grants** give one user something extra without a new role: a permission code, or a model operation
(`'<model>:<read|write|create|unlink|export|import>'`).

```ts
await shutro.run({ user: 7, company: 1, groups: ['account.user'], grants: ['account.backdate', 'account.move:unlink'] }, fn);
// With an identity loader, grants come from the user record, and a session cannot claim more:
createShutro({ driver, registry, identity: async (uid) => ({ companies, groups, grants }) });
```

Unknown permission codes are definition errors (a misspelled `requires` fails at `buildRegistry`, a misspelled
`env.access.has()` throws).

## Elevated methods and `withGrants`

A method that must touch something its callers cannot (an accountant invoicing reads order lines) declares exactly
that, instead of granting the whole role or using a superuser scope:

```ts
createInvoices: method('sale.order', { elevate: ['sale.order.line:read'], reason: 'invoice confirmed orders' },
  async function (): Promise<readonly Id<'account.move'>[]> { /* this.load({ lines: [...] }) works */ }),
```

Each call writes an `elevate` audit row (reason, grants). The grants exist only inside the call; record rules, field
groups and company scoping still apply. `env.withGrants({ grants, reason }, fn)` is the same thing for any code.

## Roles, access and rules edited at runtime

Code declarations are the reviewed baseline. With `createShutro({ runtimeSecurity: true })`, administrators extend
them while the system runs:

```ts
await shutro.run({ user: adminId, company: 1, groups: ['base.admin'] }, async (env) => {
  const admin = env.securityAdmin;
  await admin.saveRole({ code: 'sale.team_lead', label: 'Team lead', implies: ['sale.user'] });
  await admin.setAccess('sale.team_lead', 'sale.order', ['read', 'write', 'create', 'unlink']);
  await admin.saveRule({ name: 'team_orders', role: 'sale.team_lead', model: 'sale.order', perms: ['read', 'write'],
    domain: { 'user.team': { $env: 'uid' } } });
  await admin.grantPermission('sale.team_lead', 'sale.discount_approve');
});
```

- Only administrators (or superuser scopes) can change them. Every change is **validated when saved**: the role
  and model must exist, permissions must be declared by a module, and the rule domain is compiled against the model.
  A broken rule is refused instead of failing for users later.
- Additive: runtime grants and rules add to the code's; they never remove a code grant (change those in the module).
  Runtime roles can be administrator roles and can imply code groups.
- Each change is audited (`security` rows) and announced with `NOTIFY shutro_security` on commit; every process
  using `runtimeSecurity` reloads. Assign runtime roles to users like any group (identity loader / `groups`).
- Runtime rules apply in the ORM; generated RLS policies cover the code's rules only.

### Field security at runtime

```ts
await admin.setFieldGroups('hr.employee', 'salary', { read: ['hr.manager'] });  // hidden from everyone else
await admin.setFieldGroups('sale.order', 'discount', { write: ['sale.team_lead'] }); // read-only for everyone else
await admin.setFieldGroups('hr.employee', 'salary', {});                        // removes the runtime entry
```

The roles are added to the field's code groups (writers can read whenever reading is restricted). A field without
code groups becomes restricted to the given roles: the one narrowing runtime security allows, so administrators can
hide or lock a field without code. It applies everywhere `groups` on a field does (reads, writes, filters, grouping,
onchange, `canField`). A role still used by field security cannot be deleted.

`admin.describe()` reads the runtime additions back as stored — roles, model access, record rules, permission
grants and field groups — through the current transaction (changes made earlier in it show), for administration
screens; code declarations stay in the registry. Administrators and superuser scopes only, like the changes.

```ts
const { roles, access, rules, permissions, fields } = await env.securityAdmin.describe();
```

`env.access.administratorGroups()` returns the codes that make their holder an administrator (administrator groups,
runtime administrator roles, and roles implying either): for sign-in policies such as mandatory 2FA, and for
"keep at least one administrator" checks.

## Back-dated entries

```ts
defineModel('account.move', {
  backdate: { field: 'date', permission: 'account.backdate', graceDays: 0 },
  // ...
});
```

Creating a record, or changing its date, to a day before today (in the user's time zone) minus `graceDays` needs the
permission: from a role, a special grant, or administrator rights. Checked on `create`, nested x2many creates,
bulk `copy()` and `write`; editing other fields of an old entry is not back-dating. Raw SQL is outside the ORM (use
RLS or a database trigger if other services write directly).

## Development mode: `enforce: 'warn'`

```ts
const registry = buildRegistry({ modules, security: { enforce: 'warn' } }); // never in production
```

A missing ACL or field-group grant is reported once (`process.emitWarning`, code `SHUTRO_ACCESS_WOULD_DENY`, or
your `onDenied`) and allowed, so a prototype runs before its `access` declarations exist. Record rules still apply.
`buildRegistry` refuses `'warn'` when `NODE_ENV=production`.

## Installing a database: `bootstrap`

```ts
await shutro.bootstrap({ reason: 'install' }, async (env) => {
  const bdt = (await env.model('res.currency').create([{ name: 'BDT' }])).first();
  await env.model('res.company').create([{ name: 'Acme', currency: bdt.id }]);
  await env.model('res.users').create([{ login: 'admin' }]);
});
```

`bootstrap` acts as the system (`SYSTEM_UID`, 0) in an audited superuser scope: no `res.users` row is needed, and
`created_by` / `updated_by` are `NULL`. Pass `company` once the first company exists so company-scoped defaults
have a value. Everything after installation runs through `shutro.run` as real users.

## Verified identities

`shutro.run` trusts its caller unless `createShutro` gets an `identity` loader:

```ts
const shutro = createShutro({
  driver, registry,
  identity: async (uid) => loadUser(uid), // { companies: number[], groups: string[] } or null when unknown/disabled
});
await shutro.run({ user: 7, company: 2 }, fn); // groups come from the loader
```

An unknown user is an `InvalidIdentityError`, a company outside `companies` a `CompanyNotAllowedError`, and requested
`groups` must be a subset of the loaded ones.

## PostgreSQL row-level security

```ts
for (const statement of rlsStatements(registry)) await driver.query({ text: statement, params: [] });
```

Every model with record rules gets `ENABLE` / `FORCE ROW LEVEL SECURITY` and policies derived from the same rules:
group rules as PERMISSIVE policies, global rules as RESTRICTIVE ones, plus the "no rule names my groups" escape and
the superuser escape. They read the settings `shutro.run()` pushes (`shutro.user_id`, `shutro.company_id`,
`shutro.company_ids`, `shutro.groups`, `shutro.su`), so `env.sql`, reports and other clients on the same session
are bound by the rules. Connect as a role that is neither the table owner nor a superuser. RLS covers rows; model
ACL and field groups stay in the ORM.

## Encrypted fields

```ts
const shutro = createShutro({
  driver,
  registry,
  keys: createKeyRing({ current: 'k2', keys: { k1: process.env.KEY_K1 ?? '', k2: process.env.KEY_K2 ?? '' } }),
});
```

`f.char({ encrypted: true })` stores `shutro1:<keyId>:<iv>:<tag>:<ciphertext>` (AES-256-GCM). Writes use `current`;
reads use the key the token names, so rotation is: add the new key, switch `current`, re-encrypt when convenient.
A missing key or a tampered value is an `EncryptionError`. Encrypted fields cannot be filtered or sorted on, cannot be
`translate`, and the audit trail records `[encrypted]`.
