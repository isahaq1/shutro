# CLI and query inspector

## `shutro`

```
shutro init [dir]                        config, a base module (users, currencies, companies, groups), migrations/
shutro generate [--check]                per-module and application type views (guide: generate.md)
shutro migrate status                    applied and pending migration files
shutro migrate plan                      what the database is missing; destructive statements are marked
shutro migrate write <name>              the plan as the next NNNN_name.sql file
shutro migrate apply [--allow-destructive]   pending files, then module data-migration hooks
shutro inspect [model]                   the schema explorer
```

`shutro.config.ts`:

```ts
export default defineConfig({
  modules: ['./modules/base/module.ts', './modules/sale/module.ts'],
  app: './app',
  migrations: './migrations',                      // default
  database: 'postgres://localhost/erp',            // SHUTRO_DATABASE_URL overrides it
});
```

`shutro inspect` lists modules in load order with the models they own and extend; `shutro inspect sale.order` shows
every field with its kind, column, origin module and flags (required, computed, translate, encrypted, tracked,
groups), each method's override chain (`confirm: sale → sale_stock(override)`), computed fields with rank and
dependencies, constraints, access and record rules — what Odoo developers hunt for across modules.

Exit codes: 0 success, 1 failure (including `generate --check` with stale files), 2 usage or configuration errors.
The module files are imported at runtime; with `./x.js` specifiers between TypeScript sources, run the CLI through a
loader (`node --import tsx node_modules/.bin/shutro ...`).

## Query inspector (development)

```ts
const inspector = createInspector({ n1Threshold: 10, slowMs: 200 });
const shutro = createShutro({ driver, registry, inspector });

// ... run requests ...
console.log(inspector.report());
//   42 statement(s), 1 warning(s)
//      30×     18.2 ms  max 1.1 ms  SELECT "id", "partner_id" FROM "sale_order" WHERE "id" = ANY($1)
//   ! n+1: Possible N+1: the same statement ran 10 times in one transaction. Load the relation for the whole ...
```

Every statement the environments run is recorded with its SQL, parameters, duration, transaction id and user;
failed statements carry the error. The same SQL text run `n1Threshold` times in one transaction attempt is an **N+1
warning** (batched loads never repeat a statement per record); statements over `slowMs` are **slow warnings**.
Warnings go to `onWarning` (default `process.emitWarning`). It keeps parameters in memory: do not enable it in
production.
