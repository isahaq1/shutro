# Apps: install, uninstall, upgrade

Shutro ships five business apps (Settings, Accounting, Sales, Purchase, Project) and installs them with one command.
Apps are ordinary modules with storefront details. A database records which of them are installed, and every install,
uninstall and upgrade runs in **one PostgreSQL transaction**: it fully happens or leaves the database untouched.
Design: [RFC 0019](../rfcs/0019-apps-installer-and-lifecycle.md).

## Start a project

```sh
npx shutro init my-erp
```

```text
◆ Shutro · the ORM for business software

  ✔ Node.js 24.3.0
  ? PostgreSQL URL (postgres://postgres@localhost:5432/my_erp)
  ? Company name (My Erp) Paragon Ltd
  ? Currency (USD, EUR, GBP, BDT, INR, JPY) (USD) BDT
  ? Administrator login (admin)
  ? Apps
      ◉ ⚙️ Settings    settings  required
      ◉ 📒 Accounting  account   Invoices, vendor bills, payments, chart of accounts and journals
      ◉ 💼 Sales       sale      Quotations, sales orders and customers
      ◉ 🛒 Purchase    purchase  Requests for quotation, purchase orders and vendors
      ◉ 📋 Project     project   Projects, tasks, stages and deadlines

◆ Database
  ✔ PostgreSQL 18.6 at localhost:5432/my_erp (database created)

◆ Install plan · 12 modules, 141 statements
    ├─ 🧩 base              1.0.0  shared by the apps
    ├─ 📒 Accounting        1.0.0  Invoices, vendor bills, payments, chart of accounts and journals
    ├─ 🔗 sale_account      1.0.0  connects sale + account
    └─ …

◆ Installing
  ✔ schema · 141 statement(s)  135ms
  ✔ 🧩 base               32ms · 6 record(s)
  ✔ 📒 account            37ms · 20 record(s)
  …
  ✔ 12 modules installed in 298ms

  ✔ Ready in 545ms. 5 apps, 12 modules.
```

What `init` does, in order:

1. Checks Node.js.
2. Asks its questions; apps are picked with ↑/↓, space and Enter. Each question has a flag for scripts:
   `--database`, `--company`, `--currency`, `--admin`, `--apps settings,account,…` and `--yes`.
3. Writes `package.json`, `shutro.config.ts`, `modules/`, `migrations/` and `.gitignore`. Existing files are kept.
4. Creates the database when it is missing.
5. Installs the apps atomically.
6. Creates the company and the administrator.

Running `init` again in the same directory resumes where it stopped. `--no-install` writes the files only.
`--minimal` keeps the bare scaffold (a `base` module and no apps) for projects that only want the ORM.

The URL's password is never written to `shutro.config.ts`. Put it in `SHUTRO_DATABASE_URL` instead.

## The official apps

| App | Module | What v1 does |
| --- | ------ | ------------ |
| ⚙️ Settings (required) | `settings` | Per-company parameters with a global fallback: `browse([]).getParam(key)`, `setParam(key, value, { global })` |
| 📒 Accounting | `account` | Chart of accounts and journals (generic), payment terms, customer invoices and vendor bills, each with its own gapless monthly numbering (`INV/2026/10/0001`, `BILL/…`), amounts in the document and the company currency, payments, paid / residual amounts, payment status, `registerPayment()` |
| 💼 Sales | `sale` | Quotations and orders, totals from lines, a guarded workflow (`send`, `confirm`, `lock`, `cancel`, `redraft`) |
| 🛒 Purchase | `purchase` | RFQs and purchase orders, prices from the product cost |
| 📋 Project | `project` | Projects, tasks in shared stages (To do → Done), assignees, deadlines, `markDone()` |

Technical modules are installed when an app needs them: `base` (users, companies, currencies), `partner` and
`product` (with units of measure and taxes).

**Glue modules** connect two apps. Each one installs itself as soon as both of its apps are installed, and goes away
with either of them:

| Glue | Adds |
| ---- | ---- |
| `sale_account` | `order.createInvoices()`, invoice status and count on orders |
| `purchase_account` | `order.createBills()`, billing status on purchase orders |
| `sale_project` | `order.createProjects()`: a project with a task per order line |
| `sale_purchase` | `order.createPurchaseOrders({ vendor })`: buy the goods an order sells |

v1 covers invoicing and payments. The double-entry ledger, reconciliation, reports and country charts of accounts will
each get their own RFC.

## `shutro apps`

```sh
shutro apps                      # the catalog: what is installed, upgradable, or kept in quarantine
shutro apps --all                # with technical and glue modules
shutro apps info purchase        # summary, depends on, used by, models
shutro apps install purchase     # plan → confirm → progress → summary
shutro apps uninstall purchase   # preview of the data affected → confirm → quarantine
shutro apps upgrade              # new module versions: schema, data-migration hooks, module data
shutro apps purge                # drop quarantined data past its retention period
shutro doctor                    # Node, config, type views, PostgreSQL, migrations, apps: each with the fix
```

### Uninstalling keeps your data for 30 days

```text
◆ Uninstall 🛒 Purchase 1.0.0

    Also removed
    ├─ 🔗 sale_purchase     1.0.0  connects installed apps (sale + purchase)
    └─ 🔗 purchase_account  1.0.0  connects installed apps (purchase + account)

    Data affected
    table                                                        rows
    purchase_order                  purchase                     1,284  → quarantine
    purchase_order_line             purchase                     6,903  → quarantine
    account_move.purchase_order_id  purchase_account · column      412  → quarantine

  ✔ Audit history is kept (never deleted).
  ● Recoverable for 30 days: "shutro apps install purchase" restores everything.
  ? Proceed? (y/N)
```

- **Quarantine (the default).** The app's tables move to the `shutro_quarantine` schema. Columns it added to other
  apps' tables are stashed and then dropped. Its foreign keys to tables that stay are dropped and remembered, so
  quarantined rows never block other apps (you can still delete a partner a quarantined order refers to). Reinstalling
  within the retention period restores the tables, the stashed values and the keys.
- **When a referenced row is gone.** If a row a quarantined record refers to was deleted in the meantime, the key comes
  back `NOT VALID` with a warning that names it.
- **Dependents.** Apps that depend on the one you remove are listed. On a terminal you are asked whether to remove them
  too; in scripts, pass `--cascade`.
- **Blockers.** A module can refuse to be uninstalled, for example while documents are posted
  (`uninstall: { blockers }`). Nothing changes when it does.
- **`--purge`** drops the data instead of quarantining it. On a terminal you confirm by typing the app's name.
- **What cannot be uninstalled.** `base` and `settings` are required.
- **Retention.** Set it with `retentionDays` in the config (default 30). The next operation purges expired quarantine,
  and `shutro apps purge --now <app>` purges it at once.

### In scripts and CI

Without a terminal, output is plain ASCII. Operations that remove data need `--yes`, and nothing else ever waits for
input. `--json` prints one object per line: the plan, every step, warnings, and a final `result`:

```sh
shutro apps install purchase --yes --json
# {"type":"plan","plan":{"operation":"install","modules":[...],"statements":[...]}}
# {"type":"step","step":"schema","status":"done","ms":31,"detail":"4 statement(s)"}
# {"type":"step","step":"data","status":"done","module":"purchase","ms":5}
# {"type":"done","operation":"install","ms":80}
# {"type":"result","operation":"install","modules":["purchase","purchase_account","sale_purchase"],"ms":80}
```

`NO_COLOR` turns off colors and glyphs on a terminal too.

## Configuration

```ts
// shutro.config.ts
import { defineConfig } from 'shutro/cli';

export default defineConfig({
  modules: ['shutro/apps', './modules/my_module/module.ts'],   // the catalog: packages and module files
  install: ['settings', 'account', 'sale', 'purchase', 'project'],
  retentionDays: 30,
  migrations: './migrations',
});
```

- **`modules`** lists files (one module each) and packages (any number of modules each). Packages resolve from the
  project's `node_modules`. Generated views import them by package name, and module packages ship their own views.
- **`install`** makes the project *app-managed*. The database's installed set is then authoritative, and
  `shutro migrate` works on the installed modules only. A config without `install` keeps the earlier behaviour: every
  listed module is always part of the application.

## From code (Kosh's app store)

```ts
import { createAppManager } from 'shutro/migrate';
import { officialApps } from 'shutro/apps';

const apps = createAppManager({ driver, modules: [...officialApps, myModule] });
const shutro = createShutro({ driver, registry: await apps.registry(), catalog: apps.catalog });
const stop = await apps.attach(shutro);           // follow installs made by any process (LISTEN/NOTIFY)

await apps.list();                                 // name, label, icon (SVG), glyph, category, state, depends, …
await apps.planInstall(['purchase']);              // the exact plan: the install run and rolled back
await apps.install(['purchase'], { actor: user.login, onEvent: (e) => progress.push(e) });
await apps.uninstall(['purchase'], { cascade: true, actor: user.login });
```

- **Only scopes started after the change see it.** A running transaction keeps the registry it started with.
- **Code that touches an optional app checks for it first.** `env.model('purchase.order')` on a database without
  Purchase throws `AppNotInstalledError`, which names the install command:

  ```ts
  if (env.apps.has('purchase')) await env.model('purchase.order').search({ where: { state: 'purchase' } });
  ```

- **Every operation is logged in `shutro_module_log`.** Each row records who ran it, the modules, the plan and the
  outcome, and failed operations are logged too.

## Writing an app

Any module becomes an app with a few manifest fields:

```ts
export const helpdesk = defineModule({
  name: 'helpdesk',
  version: '1.0.0',
  label: 'Helpdesk',
  application: true,                     // listed in the catalog
  icon: new URL('./icon.svg', import.meta.url),   // or inline '<svg …>' (≤ 64 KB)
  glyph: '🎧',                           // shown in terminals
  category: 'Services',
  summary: 'Tickets, SLAs and customer conversations',
  depends: [partner],
  models: [HelpdeskTicket],
  uninstall: {
    blockers: async ({ sql }) => {
      const open = await sql<{ n: number }>`SELECT count(*)::int AS n FROM helpdesk_ticket WHERE state = 'open'`;
      return (open[0]?.n ?? 0) > 0 ? [`${open[0]?.n} tickets are still open`] : [];
    },
  },
});

export const helpdeskSale = defineModule({
  name: 'helpdesk_sale',
  autoInstall: true,                     // glue: installs with the last of its dependencies
  depends: [helpdesk, sale],
  models: [],
  extensions: [/* … */],
});
```

`application` and `autoInstall` exclude each other: the compiler rejects a module that sets both, and so does
`defineModule`. Mark a module `required: true` only when no database can work without it.
