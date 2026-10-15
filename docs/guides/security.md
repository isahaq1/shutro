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
- **Field groups**: an array restricts both reading and writing, `{ read, write }` separately. Restricted fields are
  left out of default projections and are an `AccessError` in load specs, filters, sorts, reads and writes.
- **Superuser**: `env.asSuperuser({ reason }, fn)` skips all three for `fn` (audited, RFC 0013). The engine's own
  loads (computes, constraints, audit snapshots) carry no rules; what the user *sees* is governed at the boundary.

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
