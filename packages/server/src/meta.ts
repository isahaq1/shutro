/**
 * The metadata API (RFC 0020 §7.2, CLAUDE.md layer 11): for the signed-in user, every model they may read, with the
 * fields they may read, their effective rights, transitions, and generated views. Fields the user may not read are
 * absent, not flagged.
 */
import type { FieldDescription, Perm, Registry, RegistryModelDescription } from '@shutro/core';
import type { AppInfo } from '@shutro/migrate';
import type { DynamicEnv } from './dynamic.js';

/** A field as the client renders it. */
export interface FieldMeta {
  readonly kind: string;
  readonly label: string;
  readonly help: string | null;
  readonly required: boolean;
  /** Not writable by this user (declared readonly, computed without inverse, numbered, or field groups). */
  readonly readonly: boolean;
  readonly computed: boolean;
  readonly store: boolean;
  readonly translate: boolean;
  readonly selection?: readonly (readonly [string, string])[];
  readonly target?: string;
  readonly inverseField?: string;
  readonly currencyField?: string;
  readonly size?: number;
  readonly scale?: number;
  readonly onchange: boolean;
}

/** A transition button. */
export interface TransitionMeta {
  readonly label: string;
  readonly from: readonly string[];
  readonly to: string;
}

/** Generated views (RFC 0020 §7.4); `defineView` will refine them. */
export interface ViewsMeta {
  readonly list: { readonly columns: readonly string[] };
  readonly form: {
    readonly title: string;
    readonly statusbar: string | null;
    readonly main: readonly string[];
    readonly lines: readonly { readonly field: string; readonly columns: readonly string[] }[];
    readonly notes: readonly string[];
    /** Counters computed from relations, shown as smart buttons (`3 Invoices`). */
    readonly smart: readonly string[];
    /** Read-only amounts, shown as a totals block. */
    readonly totals: readonly string[];
  };
  /** Kanban columns come from a state field, or a many2one to a model with a `sequence` field (stages). */
  readonly kanban: { readonly groupBy: string; readonly card: readonly string[] } | null;
  readonly search: readonly string[];
}

/** A model as the client sees it. */
export interface ModelMeta {
  readonly name: string;
  readonly label: string;
  readonly module: string;
  readonly recName: string;
  readonly archivable: boolean;
  readonly companyScoped: boolean;
  readonly order: readonly string[];
  readonly fields: Readonly<Record<string, FieldMeta>>;
  readonly access: Readonly<Record<Perm, boolean>>;
  readonly stateField: string | null;
  readonly transitions: Readonly<Record<string, TransitionMeta>>;
  readonly views: ViewsMeta;
}

/** A menu entry: an app and its models. */
export interface MenuMeta {
  readonly app: string;
  readonly label: string;
  readonly icon: string | undefined;
  readonly glyph: string | undefined;
  readonly category: string;
  readonly models: readonly { readonly model: string; readonly label: string }[];
}

/** `GET /api/meta`. */
export interface Meta {
  readonly user: {
    readonly id: number;
    readonly name: string;
    readonly login: string;
    readonly lang: string;
    readonly tz: string;
    readonly company: number;
    readonly companies: readonly { readonly id: number; readonly name: string }[];
    readonly groups: readonly string[];
    readonly administrator: boolean;
  };
  readonly menus: readonly MenuMeta[];
  readonly models: Readonly<Record<string, ModelMeta>>;
  readonly apps: readonly AppInfo[];
}

/** Bookkeeping fields every model has: shown in the timeline, not in generated views. */
const BOOKKEEPING = new Set([
  'id',
  'displayName',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'active',
]);
const PERMS: readonly Perm[] = ['read', 'write', 'create', 'unlink', 'export', 'import'];
const LIST_KINDS = new Set([
  'char',
  'integer',
  'decimal',
  'monetary',
  'quantity',
  'date',
  'datetime',
  'boolean',
  'selection',
  'state',
  'many2one',
]);

function fieldMeta(
  model: RegistryModelDescription,
  key: string,
  f: FieldDescription,
  env: DynamicEnv,
): FieldMeta {
  const x = f as Readonly<Record<string, unknown>>;
  const selection = Array.isArray(x['selection'])
    ? (x['selection'] as readonly (readonly [string, string])[])
    : undefined;
  const writable =
    !f.readonly &&
    !(f.computed && x['inverse'] === undefined) &&
    env.access.canField(model.name, key, 'write');
  return {
    kind: f.kind,
    label: f.label,
    help: f.help,
    required: f.required,
    readonly: !writable || f.sequence !== null || BOOKKEEPING.has(key),
    computed: f.computed,
    store: f.store,
    translate: f.translate,
    ...(selection === undefined ? {} : { selection }),
    ...(typeof x['target'] === 'string' ? { target: x['target'] } : {}),
    ...(typeof x['inverseField'] === 'string' ? { inverseField: x['inverseField'] } : {}),
    ...(typeof x['currencyField'] === 'string' ? { currencyField: x['currencyField'] } : {}),
    ...(typeof x['size'] === 'number' ? { size: x['size'] } : {}),
    ...(typeof x['scale'] === 'number' ? { scale: x['scale'] } : {}),
    onchange: model.onchange.includes(key),
  };
}

/** Generated views from field kinds: the recName first, the state last, amounts and dates in between. */
export function generateViews(
  model: { readonly recName: string; readonly companyScoped: boolean },
  fields: Readonly<Record<string, FieldMeta>>,
  models: (name: string) => { readonly fields: Readonly<Record<string, FieldMeta>> } | undefined,
): ViewsMeta {
  const keys = Object.keys(fields).filter((k) => !BOOKKEEPING.has(k));
  const stateField = keys.find((k) => fields[k]?.kind === 'state') ?? null;
  /** Counters computed from relations (`invoiceCount`): smart buttons, not columns. */
  const isCounter = (k: string): boolean =>
    fields[k]?.kind === 'integer' && fields[k]?.computed === true;
  /** Who did it (`user`) and where (`company`) matter less than with whom (`partner`). */
  const isContext = (k: string): boolean => {
    const target = fields[k]?.target;
    return target === 'res.users' || target === 'res.company' || target === 'res.currency';
  };
  const visible = (k: string): boolean => {
    const f = fields[k];
    return (
      f !== undefined && LIST_KINDS.has(f.kind) && f.target !== 'res.currency' && !isCounter(k)
    );
  };
  const monetary = keys.filter((k) => fields[k]?.kind === 'monetary');
  /** The amount a list shows: the total when there is one, else the first amount. */
  const headline = monetary.find((k) => /total/i.test(k)) ?? monetary[0];
  const rank = (k: string): number => {
    const f = fields[k];
    if (k === model.recName) return 0;
    if (f?.kind === 'many2one') return isContext(k) ? 6 : 1;
    if (f?.kind === 'date' || f?.kind === 'datetime') return 2;
    if (k === headline) return 4;
    if (f?.kind === 'monetary') return 8;
    if (f?.kind === 'state') return 9;
    return f?.required === true ? 3 : 5;
  };
  const columns = keys
    .filter(visible)
    .filter((k) => k !== 'company' || !model.companyScoped)
    .filter((k) => fields[k]?.kind !== 'monetary' || k === headline)
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 6);
  if (stateField !== null && !columns.includes(stateField)) columns.push(stateField);

  const lines = keys
    .filter((k) => fields[k]?.kind === 'one2many')
    .map((k) => {
      const f = fields[k] as FieldMeta;
      const child = f.target === undefined ? undefined : models(f.target);
      const childColumns =
        child === undefined
          ? []
          : Object.keys(child.fields)
              .filter((c) => c !== f.inverseField && !BOOKKEEPING.has(c))
              .filter((c) => {
                const cf = child.fields[c];
                return (
                  cf !== undefined &&
                  LIST_KINDS.has(cf.kind) &&
                  cf.target !== 'res.currency' &&
                  !(cf.kind === 'integer' && cf.computed)
                );
              })
              .slice(0, 7);
      return { field: k, columns: childColumns };
    });
  const notes = keys.filter((k) => fields[k]?.kind === 'text' || fields[k]?.kind === 'html');
  const smart = keys.filter(isCounter);
  const totals = monetary.filter((k) => fields[k]?.readonly === true);
  const main = keys.filter(
    (k) =>
      k !== model.recName &&
      k !== stateField &&
      fields[k]?.kind !== 'one2many' &&
      fields[k]?.kind !== 'many2many' &&
      fields[k]?.kind !== 'binary' &&
      !notes.includes(k) &&
      !smart.includes(k) &&
      !totals.includes(k),
  );
  // Editable fields first, then what the system fills in.
  main.sort((a, b) => Number(fields[a]?.readonly === true) - Number(fields[b]?.readonly === true));

  const stage = keys.find((k) => {
    const f = fields[k];
    if (f?.kind !== 'many2one' || f.target === undefined) return false;
    return models(f.target)?.fields['sequence'] !== undefined;
  });
  const groupBy = stateField ?? stage ?? null;
  const card = [
    ...keys.filter(
      (k) => fields[k]?.kind === 'many2one' && !isContext(k) && k !== groupBy && k !== 'parent',
    ),
    ...(headline === undefined ? [] : [headline]),
    ...keys.filter((k) => fields[k]?.kind === 'date'),
  ].slice(0, 3);
  return {
    list: { columns },
    form: { title: model.recName, statusbar: stateField, main, lines, notes, smart, totals },
    kanban: groupBy === null ? null : { groupBy, card },
    search: keys
      .filter((k) => fields[k]?.kind === 'char' || fields[k]?.kind === 'many2one')
      .slice(0, 6),
  };
}

const humanize = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Builds the metadata of everything `env` may read. */
export function buildMeta(
  registry: Registry,
  env: DynamicEnv,
  extra: {
    readonly user: { readonly name: string; readonly login: string };
    readonly companies: readonly { readonly id: number; readonly name: string }[];
    readonly apps: readonly AppInfo[];
  },
): Meta {
  const readable = [...registry.models.keys()].filter((m) => env.access.can(m, 'read'));
  const partial = new Map<
    string,
    { description: RegistryModelDescription; fields: Record<string, FieldMeta> }
  >();
  for (const name of readable) {
    const description = registry.describe(name);
    const fields: Record<string, FieldMeta> = {};
    for (const [key, f] of Object.entries(description.fields)) {
      if (!env.access.canField(name, key, 'read')) continue;
      const target = (f as Readonly<Record<string, unknown>>)['target'];
      // A relation to a model the user cannot read is not shown at all.
      if (typeof target === 'string' && !readable.includes(target) && key !== 'company') continue;
      fields[key] = fieldMeta(description, key, f, env);
    }
    partial.set(name, { description, fields });
  }
  const models: Record<string, ModelMeta> = {};
  for (const [name, { description, fields }] of partial) {
    const state = Object.entries(fields).find(([, f]) => f.kind === 'state');
    const transitions: Record<string, TransitionMeta> = {};
    if (state !== undefined) {
      const raw = description.fields[state[0]] as Readonly<Record<string, unknown>>;
      const declared = (raw['transitions'] ?? {}) as Readonly<
        Record<string, { readonly from: readonly string[]; readonly to: string }>
      >;
      for (const [t, spec] of Object.entries(declared))
        transitions[t] = { label: humanize(t), from: spec.from, to: spec.to };
    }
    const meta = {
      recName: description.recName,
      companyScoped: description.companyScoped !== null,
    };
    models[name] = {
      name,
      label: description.label,
      module: description.origin.module,
      recName: fields[description.recName] === undefined ? 'id' : description.recName,
      archivable: description.archivable,
      companyScoped: meta.companyScoped,
      order: description.order.map(String),
      fields,
      access: Object.fromEntries(PERMS.map((p) => [p, env.access.can(name, p)])) as Record<
        Perm,
        boolean
      >,
      stateField: state?.[0] ?? null,
      transitions,
      views: generateViews(meta, fields, (m) => partial.get(m)),
    };
  }
  // Lines (a one2many target whose inverse is required) live inside their parent's form, not in the menus.
  const children = new Set<string>();
  for (const model of Object.values(models))
    for (const f of Object.values(model.fields))
      if (f.kind === 'one2many' && f.target !== undefined && f.inverseField !== undefined) {
        const inverse = models[f.target]?.fields[f.inverseField];
        if (inverse?.required === true && f.target !== model.name) children.add(f.target);
      }
  const menus: MenuMeta[] = [];
  const byModule = new Map<string, string[]>();
  for (const model of Object.values(models))
    byModule.set(model.module, [...(byModule.get(model.module) ?? []), model.name]);
  // Each model shows under its module's app; technical modules' models go to the Settings app.
  const appOf = (module: string): AppInfo | undefined => {
    const app = extra.apps.find((a) => a.name === module);
    if (app?.application === true) return app;
    return extra.apps.find((a) => a.name === 'settings') ?? app;
  };
  for (const [module, names] of byModule) {
    const app = appOf(module);
    if (app === undefined) continue;
    let menu = menus.find((m) => m.app === app.name);
    if (menu === undefined) {
      menu = {
        app: app.name,
        label: app.label,
        icon: app.icon,
        glyph: app.glyph,
        category: app.category,
        models: [],
      };
      menus.push(menu);
    }
    (menu.models as { model: string; label: string }[]).push(
      ...names
        .filter((n) => models[n]?.views.list.columns.length !== 0 && !children.has(n))
        .map((n) => ({ model: n, label: models[n]?.label ?? n })),
    );
  }
  // An app is in the user's menu when they can work in it (create or write somewhere); read-only lookups such as
  // the chart of accounts for salespeople stay reachable through pickers without cluttering the menu.
  const visible = menus.filter(
    (m) =>
      env.administrator ||
      m.models.some(
        (x) => models[x.model]?.access.create === true || models[x.model]?.access.write === true,
      ),
  );
  visible.sort((a, b) =>
    a.app === 'settings' ? 1 : b.app === 'settings' ? -1 : a.label.localeCompare(b.label),
  );
  return {
    user: {
      id: env.uid,
      name: extra.user.name,
      login: extra.user.login,
      lang: env.lang,
      tz: env.tz,
      company: env.companyId,
      companies: extra.companies,
      groups: [...env.groups].sort(),
      administrator: env.administrator,
    },
    menus: visible,
    models,
    apps: env.administrator ? extra.apps : extra.apps.filter((a) => a.state === 'installed'),
  };
}
