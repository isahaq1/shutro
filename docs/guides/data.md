# Module data and external ids

Modules ship records (currencies, taxes, the main company, default journals) as typed data. Each record has an
external id `module.name`; other modules and application code refer to it by that id, never by a database id.

```ts
// modules/base/module.ts
import { defineModule, record, ref } from './.shutro/bindings.ts';

export const base = defineModule({
  name: 'base',
  models: [ResCurrency, ResCompany],
  data: [
    record('res.currency', 'currency_bdt', { name: 'BDT', rounding: '0.01' }),
    record('res.company', 'main_company', { name: 'My Company', currency: ref('res.currency', 'base.currency_bdt') }, { noupdate: true }),
  ],
});

// modules/sale/module.ts: override a dependency's record (update only)
data: [override('res.company', 'base.main_company', { name: 'Acme Ltd' })],
```

- `record(model, name, values, { noupdate })`: values are typed like a `create` of the model (from the module's
  generated bindings). `ref(model, 'module.name')` is an id of `model`, usable in many2one values and x2many
  `link` / `set`.
- **Checked when the registry is built:** names, duplicate ids, field names, override targets, and every `ref`
  (it must name a record of that model declared earlier in the module, or in a dependency). Broken data fails at
  startup and in CI, not halfway through an upgrade.

## Loading

`shutro migrate apply` loads every module's data after the schema (or call `loadData(shutro)`), one system
transaction per module, through the ORM (computes, sequences, constraints, audit):

| Situation | What happens |
| --------- | ------------ |
| New id | Created. |
| Unchanged since the last load | Skipped (a checksum of the declared values): upgrades cost nothing for unchanged data. |
| Changed in the module | Updated (x2many `create` commands are not re-run on updates). |
| `noupdate` and created before | Left to the users: not updated, and not recreated if they deleted it. |
| Deleted by users (not `noupdate`) | Recreated. |
| No longer declared | Deleted with its record; if a foreign key still references it, kept and reported. |

## At runtime

```ts
const company = await env.ref('res.company', 'base.main_company'); // a recordset, nothing loaded
const bdt = await env.refId('res.currency', 'base.currency_bdt');   // Id<'res.currency'>
```

An unknown id, or a record of another model, is an `UnknownExternalIdError`.

Records made outside module data, by an import for example, can be named too, so a later file finds them again:

```ts
await env.setExternalId('res.partner', partner.id, '__import__.partner_42');
```

The module part may not be an installed module's (those ids are its data, and `loadData` deletes the ones it no
longer declares), the record must be readable in the scope, and an id that already names another record is refused.
The row commits with the transaction.
