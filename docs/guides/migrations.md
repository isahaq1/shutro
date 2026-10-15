# Migrations

`@shutro/migrate` keeps the database in step with the registry. It reads the live schema from `pg_catalog`, diffs it
against the models, writes the difference as a versioned SQL file, applies pending files, and runs each module's
data-migration hooks when the module is upgraded ([RFC 0002 §7.1](../rfcs/0002-module-registry-and-model-extension.md)).

```ts
import { applyMigrations, planMigration, writeMigrationFile } from '@shutro/migrate';

const plan = await planMigration({ driver, registry });   // what the database is missing
if (plan.operations.length > 0) {
  await writeMigrationFile({ dir: 'migrations', name: 'sale_margin', plan });   // migrations/0003_sale_margin.sql
}
await applyMigrations({ driver, dir: 'migrations', registry });               // pending files, then module hooks
```

## Plan

`planMigration` returns `{ operations, destructive, statements }`. Operations are structured (`createTable`,
`addColumn`, `alterType`, `backfill`, `setNotNull`, `addForeignKey`, `createIndex`, ...), in a safe order: extensions and
tables first, then columns, then constraints (foreign keys after every table exists), then indexes, and the destructive
drops last. `statements` is the rendered DDL in that order.

The pure parts are exported too: `desiredSchema(registry)` builds the intended schema, `readLiveSchema(driver, schema?)`
reads the live one into the same shape, `diffSchema(desired, live)` compares them, `renderOperations(ops)` renders.
Both schemas are plain data (`tables` by name with `columns`, `primaryKey`, `foreignKeys`, `uniques`, `checks`,
`indexes`, plus `extensions`), so they diff and snapshot cleanly in tests.

What the desired schema derives from a model:

| Model                                          | Database                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| `id`                                           | `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`                    |
| `createdAt` / `updatedAt`                      | `timestamp with time zone NOT NULL DEFAULT now()`                    |
| `f.char({ size: 64 })`                         | `character varying(64)`                                              |
| `f.decimal({ scale: 2 })`                      | `numeric(32,2)`                                                      |
| `f.boolean({ default })`, `f.integer({ default })` | database default (`true`, `1`)                                   |
| other defaults                                 | applied by `create()`; used to **backfill** when a column becomes required |
| `f.many2one('res.partner', { ondelete })`      | `partner_id bigint` + `<table>_partner_id_fkey ... ON DELETE RESTRICT` |
| `f.many2many('sale.tag')`                      | `sale_order_sale_tag_rel (sale_order_id, sale_tag_id)` with cascading FKs |
| `index: true` / `'unique'` / `'trigram'`       | `<table>_<column>_idx` (btree, unique btree, gin with `pg_trgm`)     |
| `indexes`, `sqlConstraints`                    | named indexes, `UNIQUE` constraints, `CHECK` constraints             |

Check constraints and partial-index `where` clauses are `sql` fragments and must contain no parameters: DDL cannot
bind values, so write literals (`sql\`amount >= 0\``). A fragment with a parameter is rejected when the schema is built.

## Destructive changes

Dropping a table or column and changing a column's type lose data, so they are `destructive: true` in the plan,
written to the file after a `-- destructive` marker, and **refused by `applyMigrations` unless `allowDestructive: true`**
(`DestructiveMigrationError` lists the statements). Review the generated file: renaming a field looks like a drop plus
an add, and the right migration is often a hand-written `ALTER TABLE ... RENAME COLUMN` instead.

Making a column required backfills it first: `UPDATE t SET c = <default> WHERE c IS NULL`, then `SET NOT NULL`. A
required field without a default has no backfill, and `SET NOT NULL` fails on existing nulls, which is the right outcome:
the data needs a decision.

## Files and the ledger

Migration files are `NNNN_name.sql` in one directory, one statement per `;`-terminated line, comments allowed.
`writeMigrationFile` picks the next number. Applying a file runs it in one transaction and records
`(version, name, checksum, applied_at)` in `shutro_migration`. Applied files are immutable: editing one makes
`migrationStatus` and `applyMigrations` throw `MigrationChecksumError`. Write a new file instead.

`migrationStatus({ driver, dir })` returns `{ applied, pending }`, so a deploy step can refuse to boot with pending
migrations.

Hand-written files work the same way as generated ones. Anything the generator doesn't express (renames, data moves,
custom indexes) goes in a file you write; the next plan sees the result through the catalog, not through the files.

## Module data-migration hooks

Schema migrations change tables; modules migrate data. A module declares hooks with the version that introduces them:

```ts
export const sale = defineModule({
  name: 'sale',
  version: '1.2.0',
  depends: [base],
  models: [SaleOrder],
  migrations: [
    {
      version: '1.2.0',
      description: 'Default the new note on existing orders',
      up: async (ctx) => {
        await ctx.sql`UPDATE sale_order SET note = ${'migrated'} WHERE note IS NULL`;
      },
    },
  ],
});
```

`applyMigrations` records each module's version in `shutro_module`. On a fresh install it records the version and runs
no hooks (new tables have no data to migrate). On an upgrade from `installed` to `module.version`, it runs the hooks with
`installed < hook.version <= module.version`, in version order, in one transaction per module, in registry load order,
and records the new version. A hook that fails rolls its module back and stops the run; the modules before it stay
upgraded.

`MigrationContext` is deliberately small: `ctx.sql` runs raw SQL (values are bound, never interpolated) on the
migration transaction, and `ctx.registry` describes the models. Hooks don't get an `Env` or recordsets: the ORM would
run business logic (computes, constraints, tracking) that the migration usually must bypass, and the registry at
migration time describes the *new* models, not the ones the data was written with.

## Order of a deploy

1. `planMigration` / `writeMigrationFile` at development time; commit the file with the model change.
2. `applyMigrations` at deploy time: schema files first (so hooks see the new columns), then module hooks.
3. Boot the application. `planMigration` returning `[]` is a good startup assertion.
