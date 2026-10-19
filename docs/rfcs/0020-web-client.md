# RFC 0020: Web client (Kosh UI)

- **Status:** Draft
- **Date:** 2026-10-19
- **Depends on:** 0001 (models), 0004 (recordsets), 0009 (onchange), 0010 (state machines), 0013 (audit), 0014
  (security), 0016 (aggregates), 0018 (events, history), 0019 (apps)
- **Builds:** CLAUDE.md layer 11, "Metadata API: full schema introspection for Kosh (APIs, views, forms)"

## 1. Summary

1. **Every model gets screens without any code.** A module ships models; the web client derives list, form, kanban,
   calendar, pivot and chart views from `registry.describe()`. Typed `defineView()` declarations refine them when a
   module wants control.
2. **People shape their own screens.** Any user can save columns, filters, grouping, sort, density and a kanban field
   as a personal or shared view. This is stored as data, so no developer and no XML is involved.
3. **One server package and one SPA.** `@shutro/server` turns the registry into a typed JSON API, where every request
   runs in `shutro.run()` with the signed-in user. `@shutro/web` is the browser app.
4. **Security stays on the server.** ACL, record rules, field groups, permissions and company scope are enforced by
   the ORM exactly as in code. The UI hides what it may not show; it never decides.
5. **Premium by default:** a designed component system, light and dark themes, a command palette, keyboard-first
   editing, live updates, and fast lists (virtual scrolling, prefetch). App icons and the app store come from RFC 0019.

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | **Zero-code screens.** A new model is usable in the browser the moment its app is installed: list, form, search. |
| R2  | **End-user flexibility.** Users choose columns, filters, grouping, sort and layout, and save them as views without a developer. Admins can share views with roles. |
| R3  | **Developer control, typed.** Modules can declare views. Field names, actions and sections are checked by the compiler, not discovered at runtime. |
| R4  | **Business views:** list (inline edit, bulk edit), form (sections, tabs, workflow buttons, related lists), kanban (drag to change state or stage, validated by the state machine), calendar, pivot and chart (from `aggregate()`), and a dashboard. |
| R5  | **Live forms.** Onchange runs as the user types (RFC 0009), computed fields refresh, constraint errors show next to their fields, and the transition buttons are those `records.transitions()` allows. |
| R6  | **History built in.** A timeline per record from the audit trail (RFC 0013), and a "view as of" date picker for models with `history: true` (RFC 0018). |
| R7  | **Real time.** Lists and open records update when another user changes them (outbox events plus NOTIFY), and edit conflicts are caught (`expect: { updatedAt }`, RFC 0018). |
| R8  | **App store.** Browse, install and uninstall apps with icons, the plan preview and progress (RFC 0019 §7.8), for administrators. |
| R9  | **Multi-company, multi-language, multi-currency.** A company switcher (allowed companies), the user's language and time zone, and Money rendered in its currency. |
| R10 | **Secure sign-in.** Password hashing, sessions with CSRF protection, optional TOTP, login rate limiting. Nothing about security is decided in the browser. |
| R11 | **Fast at ERP scale.** Lists of 100,000+ rows stay smooth: server paging, virtual scrolling, no N+1 (the API loads with recordset prefetch), and query budgets in CI. |
| R12 | **Accessible and responsive.** WCAG 2.2 AA, full keyboard use, usable on a tablet, readable on a phone. |

## 3. How Odoo does it

Views are XML records (`ir.ui.view`) with XPath inheritance. The OWL web client renders them, actions (`ir.actions.*`)
open them, and studio edits them (Enterprise only).

**Weaknesses:**

| #  | Weakness | Consequence |
| -- | -------- | ----------- |
| W1 | **Views are untyped XML;** XPath inheritance targets nodes by position or name. | A renamed field or a changed parent view breaks inheriting views at module upgrade, not at build time. |
| W2 | **Users cannot change a view.** Favorites save filters only; columns and layout need a developer or Studio (paid). | Every column request is a ticket. |
| W3 | **The UI evaluates security hints** (`groups=`, `attrs`) itself, with domains written in Python syntax in XML. | Duplicated logic, subtle mismatches between what is hidden and what is allowed. |
| W4 | **Real time is limited** to chatter and notifications; lists go stale. | Two users overwrite each other's edits. |
| W5 | **The look is dated and dense,** with no command palette and limited keyboard flow. | Slow data entry, training cost. |

## 4. Prior art

- **Linear, Notion, Airtable:** user-shaped views (columns, filters, grouping saved per view), a command palette,
  keyboard-first editing, optimistic updates.
- **Retool, Refine, React Admin:** CRUD generated from a schema, with overrides.
- **Prisma Studio, Supabase Studio:** a table browser over a schema. Developer tools, not business UIs.

Shutro's advantage: the model metadata (field kinds, Money, state machines, onchange, security, history) is far richer
than a database schema, so generated screens can be business screens, not table editors.

## 5. Options

### Option A: Generated screens only

Screens come from metadata; nothing is customizable beyond saved filters. Simple, but fails R2 and R3.

### Option B: Odoo-style view documents

Views as stored documents (JSON instead of XML) with inheritance by path. It is flexible, but it repeats W1: untyped
references and runtime breakage.

### Option C: Generated screens, typed code views, user views as data

1. **Generated** views for every model (R1).
2. **`defineView()`** in modules, typed against the module's generated view (RFC 0002). Field keys, sections and
   actions are checked by the compiler. Extending modules add to a view by section name, never by position.
3. **User views** (columns, filters, grouping, sort, layout) are stored as rows. Field keys are validated against
   the registry when saved, and a field that later disappears is skipped with a notice, never breaking the screen.

| Criterion | A | B | C |
| --- | --- | --- | --- |
| R1 zero-code | ✔ | ✔ | ✔ |
| R2 user flexibility | ✖ | partly (admins) | ✔ every user |
| R3 typed developer control | ✖ | ✖ | ✔ |
| Breakage at upgrade | none | likely (W1) | caught at build (code), skipped gracefully (user views) |
| Complexity | low | medium | medium |

## 6. Decision

**Option C.**

## 7. Detailed design

### 7.1 Packages

| Package | Contents |
| --- | --- |
| `@shutro/server` | HTTP server (`node:http`, no framework): auth and sessions, a metadata endpoint, a records API, an events stream (SSE), and the apps API. Exposes `createServer({ shutro, apps, auth })`, which can also mount inside Express, Fastify or Hono. |
| `@shutro/web` | The SPA, built with Vite and served by `@shutro/server` as static files. The view renderer, the component system and the themes. |
| `@shutro/ui` | The design system (tokens and components) on its own, so applications can build custom pages that look native. |

**Dependencies (each justified, per CLAUDE.md):**
- React 19: the ecosystem and component maturity a business UI needs.
- TanStack Query, Router, Table and Virtual: caching, typed routes, headless tables, virtual scrolling.
- Radix UI primitives: accessible dialogs, menus and popovers (R12).
- Tailwind CSS 4: design tokens as CSS variables, and themes.
- cmdk: the command palette.
- ECharts: charts and pivots at scale.
- The server adds none beyond Node and the workspace packages; password hashing uses `node:crypto` `scrypt`.

### 7.2 Metadata API

`GET /api/meta` returns, for the signed-in user only (security applied):

```ts
{
  apps: AppInfo[],                              // RFC 0019 §9, with icon SVGs
  menus: MenuNode[],                            // from apps and views (§7.4)
  models: Record<string, {
    label, recName, archivable, companyScoped,
    fields: Record<string, { kind, label, help, required, readonly, selection?, target?, currencyField?, translate, … }>,
    access: { read, write, create, unlink, export, import },   // this user's effective rights
    transitions: Record<string, { label, from, to, requires? }>,
    views: Record<ViewKind, ViewSpec>,          // generated, merged with defineView and the user's saved views
  }>,
  user: { id, name, lang, tz, companies, company, groups, permissions },
}
```

Fields the user may not read are absent, not merely flagged.

### 7.3 Records API

All of these run in `shutro.run({ user, company, lang, tz })`, so ACL, rules, field groups and the audit trail apply:

| Endpoint | Maps to |
| --- | --- |
| `POST /api/:model/search` `{ where, order, limit, offset, fields, groupBy? }` | `search()` + `load()`, or `aggregate()` when grouping; one batched load, no N+1 |
| `GET /api/:model/:id?fields=` | `browse().load()` |
| `POST /api/:model` / `PATCH /api/:model/:id` `{ values, expect: { updatedAt } }` | `create()` / `write()` with lost-update protection |
| `POST /api/:model/onchange` | `env.model(m).onchange()` (RFC 0009) |
| `POST /api/:model/:id/transition/:name` | the generated transition method (guards, permissions) |
| `POST /api/:model/:id/call/:method` | methods the module marked `exposed: true` (not every method) |
| `GET /api/:model/:id/trail` | `records.trail()` (RFC 0013) |
| `GET /api/:model/:id?asOf=` | `env.asOf()` (RFC 0018) |
| `POST /api/:model/export` / `import` | CSV/XLSX through `copy()`, with the export and import permissions |
| `GET /api/events` (SSE) | outbox events filtered by what the user can read (R7) |
| `/api/apps/*` | `AppManager` (RFC 0019 §7.8), administrators only |

Errors keep the typed classes and their hints: `ValidationError` carries field keys, so the form marks the fields.

### 7.4 Views in code

```ts
// modules/sale/views.ts: typed against the sale module's view
import { defineView } from './.shutro/bindings.js';

export const SaleOrderForm = defineView('sale.order', 'form', {
  header: { transitions: ['send', 'confirm', 'cancel'], statusbar: 'state' },
  title: 'name',
  sections: {
    main: { columns: 2, fields: ['partner', 'dateOrder', 'currency', 'user'] },
    lines: { list: 'lines', columns: ['product', 'name', 'quantity', 'priceUnit', 'tax', 'subtotal'], editable: 'inline' },
    totals: { fields: ['amountUntaxed', 'amountTax', 'amountTotal'], align: 'end' },
  },
  tabs: { notes: ['note'] },
});

// sale_stock adds to it by section name: a missing section or field is a compile error
export const SaleOrderFormStock = extendView(SaleOrderForm, {
  sections: { main: { add: ['warehouse'], after: 'currency' } },
});
```

Kinds: `list`, `form`, `kanban` (`groupBy` a state, stage or selection field; drag runs the transition or the write),
`calendar` (a date or date range), `pivot` and `chart` (measures and dimensions from `aggregate()`), `dashboard` (tiles
of saved views).

### 7.5 User views

`kosh_view (id, model, kind, name, owner, shared_with_roles, spec jsonb, is_default)`: columns with widths, filters,
grouping, sort, density, kanban field, and pinned to the sidebar or not. The spec is validated against the registry when
saved. Fields that are later removed or no longer readable by the user are skipped with an inline notice. Admins share
views with roles, and a role's default view applies to its members.

### 7.6 The interface

- **Shell:** an app switcher (the RFC 0019 icons), a sidebar with the app's menus and pinned views, a company
  switcher, a ⌘K command palette (go to any record, run any action, switch app), notifications, and the user menu with
  theme and language.
- **List:** sticky header, resizable and reorderable columns, inline edit (Enter / Tab), multi-select bulk edit and
  transitions, group-by with subtotals (Money per currency), filter chips with a builder, and virtual scrolling.
- **Form:** sticky header with the statusbar and allowed transitions, autosave drafts, live onchange, field errors in
  place, related lists with inline rows, and a side panel with the timeline (audit trail, comments).
- **Kanban:** columns per state or stage, card templates, drag validated by the state machine (an invalid drop
  snaps back with the reason), WIP counts.
- **Design system:** CSS-variable tokens (color, radius, spacing, motion), light and dark themes with system default,
  one accent color per app, Inter and tabular numerals for amounts, 150–200 ms transitions, `prefers-reduced-motion`
  respected.
- **Keyboard:** `⌘K` palette, `C` create, `E` edit, `/` search, `J`/`K` move, `⌘S` save, `⌘Enter` run the primary
  transition, `?` shortcut sheet.

### 7.7 Sign-in and sessions

`res.users` gains `passwordHash` (scrypt, `groups: []`: unreadable through the API), `totpSecret` (encrypted field,
RFC 0014 §7.6), `active`, `lang`, `tz`, and allowed companies with groups through `res.users.role`. Sessions are opaque
random tokens stored hashed in `kosh_session` in an HttpOnly, Secure, SameSite=Lax cookie, with a CSRF token header on
writes. Failed logins are rate-limited per user and IP. The server's `identity` loader (RFC 0014 §7.1) supplies
companies and groups to `shutro.run()`. `shutro init` sets the administrator's password (prompted, never echoed).

## 8. Type-level guarantees

- `defineView('sale.order', 'form', …)` accepts only fields, one2many keys, transitions and exposed methods that the
  module's view contains. `extendView` accepts only section names that exist.
- The server's API types are generated with the application view (`app/.shutro`), so custom pages call
  `api.model('sale.order').search(...)` with the same typed domains as the ORM.

## 9. Runtime metadata

`GET /api/meta` (§7.2) is the metadata API of CLAUDE.md layer 11. Kosh and third-party front ends use it, not the
SPA's internals.

## 10. Interactions

- **0014:** every request runs as the user; field groups remove fields from metadata and payloads; `exposed`
  methods still check permissions.
- **0018:** SSE delivers outbox events after commit; edits send `expect: { updatedAt }`, and a conflict shows a
  merge dialog.
- **0019:** the app store is a page over `AppManager`; after an install, `attach()` swaps the registry and the
  client refetches `/api/meta`.
- **0016:** pivots, charts, group subtotals and dashboard tiles are `aggregate()` calls.

## 11. Open questions (need your decision)

1. **Where does it live?** The recommendation is this monorepo (`packages/server`, `packages/web`, `packages/ui`),
   named `@shutro/*` until Kosh exists as its own project. The alternative is a separate Kosh repository, which keeps
   Shutro a pure ORM as CLAUDE.md describes it.
2. **Frontend stack:** React 19 + TanStack + Radix + Tailwind (recommended: ecosystem, accessibility, hiring), or
   SolidJS / Svelte 5 (smaller and faster, with a thinner component ecosystem).
3. **Sign-in:** built-in password + TOTP (recommended for a self-contained ERP), or delegate to an external identity
   provider (OIDC) from the start. Both can come later; this decides v1.
4. **v1 scope:** the recommendation is shell, app store, generated list / form / kanban, user views, live onchange,
   timeline, command palette, and themes. Then calendar, pivot, chart, dashboards, import/export, and `asOf` in v2.

## 12. Deferred

- A visual view editor ("studio"): user views cover most needs; a drag-and-drop editor of code views comes later.
- Reports (PDF / QWeb equivalents), email, chat and activities.
- Mobile apps (the SPA is responsive; PWA install only).
- Portal and website for customers.

## 13. Implementation plan (after approval)

Each step is one PR, done test-first. API steps are tested against PostgreSQL; UI steps get component tests and
Playwright end-to-end tests.

1. `res.users` sign-in fields, `kosh_session`, the auth endpoints, and the identity loader. Security tests: brute force,
   CSRF, session fixation.
2. `@shutro/server`: metadata API and records API (search, read, create, write, onchange, transitions, trail).
   Permission-bypass tests and query budgets.
3. `@shutro/ui`: tokens, themes, and core components (button, input, select, combobox for many2one, date, money,
   table, dialog, toast, command palette).
4. `@shutro/web`: shell, app switcher, generated list and form, live onchange, transitions, timeline.
5. Kanban, user views (save, share, default), bulk edit, and SSE live updates.
6. App store page; `shutro serve`, with `shutro init` offering to start it.
7. `defineView` / `extendView` with type tests; views for the official apps.
8. Docs: `docs/guides/web.md`, screenshots, CLAUDE.md roadmap.
