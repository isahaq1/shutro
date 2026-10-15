# RFC 0017: External IDs and module data

- **Status:** Implemented
- **Related:** 0002 (modules), 0012 (sequences), 0013 (audit), 0014 (security), 0016

## 1. Summary

Modules ship records (currencies, taxes, the main company, default roles' records) as typed data:
`record(model, name, values, { noupdate })`, with `ref(model, 'module.name')` for references. Each record has an
external id `module.name`, stored in `shutro_external_id`. `loadData()` (run by `shutro migrate apply`) creates,
updates or deletes records idempotently; `env.ref(model, 'module.name')` finds them at runtime.

## 2. Problem

An ERP module needs reference data and needs to point at other modules' records ("the BDT currency", "the main
company") without knowing database ids, and upgrades must update shipped data without touching data users own.

## 3. How Odoo does it

XML/CSV data files, `ir.model.data` (`module.name` → `model, res_id, noupdate`), `env.ref()`, `noupdate="1"`,
obsolete records deleted at upgrade. Weaknesses: no types (field names and values checked at install), a broken
`ref` fails in the middle of an upgrade, every data record is rewritten at every module update (slow, and it
overwrites user changes of non-`noupdate` records even when the data did not change).

## 4. Decision

- **Declaration:** `defineModule({ data: [record(...), ...] })`. Local names (`'currency_bdt'`) belong to the
  module; a full id of a dependency's record (`'base.main_company'`) **overrides** that record (update only, same
  model). Generated bindings type `record` and `ref` against the module's view.
- **Checked at `buildRegistry`:** names, duplicates, override targets, and every `ref` (it must name a record
  declared earlier in the module or in a dependency, of the given model). Broken data never reaches a database.
- **Storage:** `shutro_external_id(module, name, model, res_id, noupdate, checksum)`, primary key
  `(module, name)`, created on first use.
- **Loading** (per module, in load order, one system transaction each, audited `data: <module>`): create when the
  id is new or its record was deleted; skip `noupdate` records that exist; skip records whose checksum (a stable
  hash of the declared values) is unchanged; update the others. Ids no longer declared are deleted with their
  records (non-`noupdate`); a record a foreign key keeps is reported and its id kept.
- **Runtime:** `env.ref(model, id)` (a recordset, cached per transaction), `env.refId(model, id)`;
  `UnknownExternalIdError` for unknown ids or a model mismatch.

## 5. Deferred

Exporting existing records as data, CSV import of data, per-company data (`company` per record set).
