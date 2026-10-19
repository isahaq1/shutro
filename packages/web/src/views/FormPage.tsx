/**
 * The form (RFC 0020 §7.6): status bar and the allowed transitions, live onchange, editable lines, field errors in
 * place, lost-update protection, ⌘S to save, ⌘↵ for the primary step, and the record's history beside it.
 */
import {
  AlertIcon,
  Avatar,
  Button,
  Card,
  ChevronRightIcon,
  cx,
  Dialog,
  EmptyState,
  FieldRow,
  HistoryIcon,
  Kbd,
  Menu,
  MoreIcon,
  PlusIcon,
  SaveIcon,
  Skeleton,
  Statusbar,
  Tabs,
  TrashIcon,
  useToast,
  XIcon,
} from '@shutro/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type FieldMeta,
  type ModelMeta,
  type Row,
  type TrailEntry,
} from '../api.js';
import { display, numeric, plural, relative } from '../format.js';
import { invalidateModel, useMeta, useModel } from '../session.js';
import { FieldInput, FieldValue, toInput } from './fields.js';

/** An editable line of a one2many. */
interface Line {
  readonly key: string;
  readonly id: number | undefined;
  values: Record<string, unknown>;
  dirty: boolean;
  deleted: boolean;
}

let lineKeys = 0;

export function FormPage() {
  const params = useParams({ strict: false }) as { app: string; model: string; id?: string };
  const model = useModel(params.model);
  if (model === undefined)
    return (
      <EmptyState title="Not available">
        This screen does not exist, or your role cannot see it.
      </EmptyState>
    );
  return (
    <Form
      key={`${params.model}:${params.id ?? 'new'}`}
      app={params.app}
      model={model}
      id={params.id === undefined ? undefined : Number(params.id)}
    />
  );
}

function Form({
  app,
  model,
  id,
}: {
  readonly app: string;
  readonly model: ModelMeta;
  readonly id: number | undefined;
}) {
  const meta = useMeta();
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const isNew = id === undefined;
  const form = model.views.form;

  const record = useQuery({
    queryKey: ['records', model.name, 'one', id],
    enabled: !isNew,
    queryFn: () => api.read(model.name, id ?? 0),
  });
  const defaults = useQuery({
    queryKey: ['records', model.name, 'defaults'],
    enabled: isNew,
    queryFn: () => api.onchange(model.name, {}, []),
    staleTime: 0,
  });

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [lines, setLines] = useState<Record<string, Line[]>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<string | undefined>(undefined);
  const tabsRef = useRef<HTMLDivElement>(null);
  const pending = useRef(0);

  useEffect(() => {
    if (isNew && defaults.data !== undefined) setDraft((d) => ({ ...defaults.data.values, ...d }));
  }, [isNew, defaults.data]);

  const base: Row | undefined = record.data?.row;
  const values: Record<string, unknown> = useMemo(
    () => ({ ...(base ?? {}), ...draft }),
    [base, draft],
  );
  const linesDirty = Object.values(lines).some((ls) =>
    ls.some((l) => l.dirty || l.deleted || l.id === undefined),
  );
  const dirty = Object.keys(draft).length > 0 || linesDirty;
  const editable = isNew ? model.access.create : model.access.write;
  const invalid = new Set(error?.fields ?? []);

  /** Live onchange: the server fills what follows from the change. */
  const change = useCallback(
    (key: string, value: unknown) => {
      setDraft((d) => ({ ...d, [key]: value }));
      setError(null);
      if (model.fields[key]?.onchange !== true) return;
      const ticket = ++pending.current;
      const inputs = Object.fromEntries(
        Object.entries({ ...(base ?? {}), ...draft, [key]: value }).map(([k, v]) => [
          k,
          toInput(model.fields[k], v),
        ]),
      );
      void api
        .onchange(model.name, inputs, [key], id)
        .then((r) => {
          if (ticket === pending.current) setDraft((d) => ({ ...d, ...r.values }));
          for (const w of r.warnings) toast({ tone: 'info', title: w });
        })
        .catch(() => {});
    },
    [model, base, draft, id, toast],
  );

  const changedValues = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      const f = model.fields[k];
      if (f === undefined || f.readonly || f.kind === 'one2many') continue;
      out[k] = toInput(f, v);
    }
    for (const { field, columns } of form.lines) {
      const list = lines[field];
      const target = model.fields[field]?.target;
      const child = target === undefined ? undefined : meta.models[target];
      if (list === undefined || child === undefined) continue;
      const clean = (v: Record<string, unknown>) =>
        Object.fromEntries(
          columns
            .filter(
              (c) =>
                child.fields[c] !== undefined && !child.fields[c]?.readonly && v[c] !== undefined,
            )
            .map((c) => [c, toInput(child.fields[c], v[c])]),
        );
      const create = list
        .filter((l) => l.id === undefined && !l.deleted)
        .map((l) => clean(l.values));
      const update = list
        .filter((l) => l.id !== undefined && l.dirty && !l.deleted)
        .map((l) => ({ id: l.id, values: clean(l.values) }));
      const remove = list.filter((l) => l.id !== undefined && l.deleted).map((l) => l.id);
      if (create.length + update.length + remove.length > 0)
        out[field] = {
          ...(create.length > 0 ? { create } : {}),
          ...(update.length > 0 ? { update } : {}),
          ...(remove.length > 0 ? { delete: remove } : {}),
        };
    }
    return out;
  };

  const save = async (): Promise<number | undefined> => {
    if (!dirty && !isNew) return id;
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const created = await api.create(model.name, changedValues());
        invalidateModel(client, model.name);
        toast({ tone: 'success', title: `${model.label} created` });
        await navigate({
          to: '/$app/$model/$id',
          params: { app, model: model.name, id: String(created.id) },
          replace: true,
        });
        return created.id;
      }
      await api.write(model.name, id, changedValues(), base?.['updatedAt']);
      setDraft({});
      setLines({});
      invalidateModel(client, model.name);
      toast({ tone: 'success', title: 'Saved' });
      return id;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_RECORD') setConflict(true);
      else setError(e instanceof ApiError ? e : new ApiError(0, { message: String(e) }));
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft({});
    setLines({});
    setError(null);
    if (isNew) void navigate({ to: '/$app/$model', params: { app, model: model.name } });
  };

  const run = async (name: string) => {
    const saved = await save();
    if (saved === undefined) return;
    try {
      await api.transition(model.name, saved, name);
      invalidateModel(client, model.name);
      toast({ tone: 'success', title: `${model.transitions[name]?.label ?? name}: done` });
    } catch (e) {
      const err = e instanceof ApiError ? e : undefined;
      toast({
        tone: 'danger',
        title: err?.message ?? 'That step failed.',
        ...(err?.hint ? { description: err.hint } : {}),
      });
    }
  };

  const transitions = (record.data?.transitions ?? []).filter(
    (t) => model.transitions[t] !== undefined,
  );
  const primary = transitions.find((t) => !['cancel', 'redraft', 'unlock'].includes(t));

  // Keyboard: ⌘S saves, ⌘↵ runs the primary step.
  const keys = useRef({ save, run, primary, dirty });
  keys.current = { save, run, primary, dirty };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void keys.current.save();
      } else if (e.key === 'Enter' && keys.current.primary !== undefined) {
        e.preventDefault();
        void keys.current.run(keys.current.primary);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!isNew && record.isPending)
    return (
      <div className="mx-auto grid max-w-5xl gap-4 p-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!isNew && record.error !== null)
    return (
      <EmptyState icon={<AlertIcon size={22} />} title="This record is not available">
        It was deleted, or it is outside what your role can see.
      </EmptyState>
    );

  const title = values[form.title];
  const stateField = form.statusbar === null ? undefined : model.fields[form.statusbar];
  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1">
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-line bg-canvas/90 px-6 py-3 backdrop-blur">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
            <Link to="/$app/$model" params={{ app, model: model.name }} className="hover:text-ink">
              {model.label}
            </Link>
            <ChevronRightIcon size={14} className="text-faint" />
            <span className="truncate font-medium text-ink">
              {isNew
                ? 'New'
                : display(title, model.fields[form.title], meta.user.lang, meta.user.tz) ||
                  `#${id}`}
            </span>
          </nav>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {dirty || isNew ? (
              <>
                <Button
                  variant="primary"
                  onClick={() => void save()}
                  loading={saving}
                  disabled={!editable}
                >
                  <SaveIcon /> Save{' '}
                  <Kbd className="ml-1 border-white/20 bg-white/15 text-current">⌘S</Kbd>
                </Button>
                <Button variant="ghost" onClick={discard}>
                  Discard
                </Button>
              </>
            ) : null}
            {transitions.map((t) => (
              <Button
                key={t}
                variant={t === primary && !dirty ? 'primary' : 'secondary'}
                onClick={() => void run(t)}
              >
                {model.transitions[t]?.label}
              </Button>
            ))}
            <div className="flex-1" />
            {stateField !== undefined && stateField.selection !== undefined ? (
              <Statusbar
                states={stateField.selection.filter(
                  ([k]) => k !== 'cancel' || values[form.statusbar ?? ''] === 'cancel',
                )}
                current={String(values[form.statusbar ?? ''] ?? '')}
              />
            ) : null}
            {!isNew && model.access.unlink ? (
              <Menu
                trigger={
                  <Button variant="ghost" size="icon" aria-label="More">
                    <MoreIcon />
                  </Button>
                }
                items={[
                  {
                    label: 'Delete',
                    icon: <TrashIcon />,
                    danger: true,
                    onSelect: () => setConfirmDelete(true),
                  },
                ]}
              />
            ) : null}
          </div>
        </div>

        <div className="mx-auto max-w-5xl animate-fade p-6">
          {conflict ? (
            <div
              role="alert"
              className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft p-4 text-sm"
            >
              <AlertIcon className="mt-0.5 shrink-0 text-warning" />
              <div className="flex-1">
                <p className="font-medium text-ink">
                  Someone else saved this record while you were editing.
                </p>
                <p className="mt-0.5 text-muted">
                  Your changes are still here. Reload to see theirs, then apply yours again.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setConflict(false);
                  void record.refetch();
                }}
              >
                Reload
              </Button>
            </div>
          ) : null}
          {error !== null ? (
            <div
              role="alert"
              className="mb-4 flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm"
            >
              <AlertIcon className="mt-0.5 shrink-0 text-danger" />
              <div className="flex-1">
                <p className="font-medium text-danger">{error.message}</p>
                {error.hint !== '' ? <p className="mt-0.5 text-muted">{error.hint}</p> : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setError(null)}
                className="text-faint hover:text-ink"
              >
                <XIcon />
              </button>
            </div>
          ) : null}

          {!isNew && form.smart.length > 0 ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {form.smart.map((key) => {
                const f = model.fields[key];
                const stem = key.replace(/Count$/, '');
                const related = form.lines.find((l) => l.field.startsWith(stem));
                const label = plural((f?.label ?? key).replace(/ count$/i, ''));
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={related === undefined}
                    onClick={() => {
                      if (related === undefined) return;
                      setTab(related.field);
                      tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm shadow-xs transition-colors enabled:hover:border-accent enabled:hover:text-accent disabled:cursor-default"
                  >
                    <span className="tabular text-base font-semibold text-ink">
                      {String(values[key] ?? 0)}
                    </span>
                    <span className="text-muted">{label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <Card className="p-6">
            {model.fields[form.title] !== undefined && form.title !== 'id' ? (
              model.fields[form.title]?.readonly === true || !editable ? (
                <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink">
                  {isNew ? (
                    <span className="text-faint">New {model.label.toLowerCase()}</span>
                  ) : (
                    display(title, model.fields[form.title], meta.user.lang, meta.user.tz)
                  )}
                </h1>
              ) : (
                <input
                  aria-label={model.fields[form.title]?.label}
                  aria-invalid={invalid.has(form.title)}
                  value={typeof title === 'string' ? title : ''}
                  onChange={(e) => change(form.title, e.target.value)}
                  placeholder={`${model.fields[form.title]?.label ?? 'Name'}…`}
                  className="mb-6 w-full border-b border-transparent bg-transparent pb-1 text-2xl font-semibold tracking-tight text-ink placeholder:text-faint hover:border-line focus:border-accent focus:outline-none aria-[invalid=true]:border-danger"
                />
              )
            ) : null}
            <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
              {form.main.map((key) => {
                const f = model.fields[key] as FieldMeta;
                const readOnly = f.readonly || !editable;
                return (
                  <FieldRow
                    key={key}
                    label={f.label}
                    htmlFor={`field-${key}`}
                    required={f.required && !readOnly}
                    help={f.help ?? undefined}
                    error={invalid.has(key) ? 'Check this field.' : undefined}
                  >
                    {readOnly ? (
                      <div
                        className={cx(
                          'flex min-h-8.5 items-center text-sm',
                          numeric(f) && 'tabular',
                        )}
                      >
                        <FieldValue value={values[key]} field={f} />
                      </div>
                    ) : (
                      <FieldInput
                        name={key}
                        field={f}
                        value={values[key] ?? null}
                        onChange={(v) => change(key, v)}
                        invalid={invalid.has(key)}
                        disabled={saving}
                      />
                    )}
                  </FieldRow>
                );
              })}
            </div>
            {form.totals.length > 0 ? (
              <dl className="mt-6 ml-auto grid w-full max-w-xs gap-1.5 border-t border-line pt-4 text-sm">
                {form.totals.map((key, i) => {
                  const last = i === form.totals.length - 1;
                  return (
                    <div
                      key={key}
                      className={cx(
                        'flex items-baseline justify-between gap-4',
                        last && 'mt-1 border-t border-line pt-2',
                      )}
                    >
                      <dt className={cx(last ? 'font-medium text-ink' : 'text-muted')}>
                        {model.fields[key]?.label}
                      </dt>
                      <dd
                        className={cx(
                          'tabular',
                          last ? 'text-lg font-semibold text-ink' : 'text-ink',
                        )}
                      >
                        <FieldValue value={values[key]} field={model.fields[key]} />
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : null}
          </Card>

          {form.lines.length + form.notes.length > 0 ? (
            <Card className="mt-6 p-6" ref={tabsRef}>
              <Tabs
                value={tab ?? form.lines[0]?.field ?? '__notes'}
                onValueChange={setTab}
                tabs={[
                  ...form.lines.map(({ field, columns }) => ({
                    value: field,
                    label: model.fields[field]?.label ?? field,
                    content: (
                      <Lines
                        parent={model}
                        field={field}
                        columns={columns}
                        id={id}
                        lines={lines[field]}
                        editable={editable}
                        onChange={(next) => setLines((all) => ({ ...all, [field]: next }))}
                      />
                    ),
                  })),
                  ...(form.notes.length > 0
                    ? [
                        {
                          value: '__notes',
                          label: 'Notes',
                          content: (
                            <div className="grid gap-5">
                              {form.notes.map((key) => {
                                const f = model.fields[key] as FieldMeta;
                                return (
                                  <FieldRow key={key} label={f.label} htmlFor={`field-${key}`}>
                                    <FieldInput
                                      name={key}
                                      field={f}
                                      value={values[key] ?? null}
                                      onChange={(v) => change(key, v)}
                                      invalid={invalid.has(key)}
                                      disabled={!editable || f.readonly}
                                    />
                                  </FieldRow>
                                );
                              })}
                            </div>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </Card>
          ) : null}
        </div>
      </div>

      {!isNew && id !== undefined ? <Timeline model={model} id={id} /> : null}

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete this ${model.label.toLowerCase()}?`}
        description="The deletion is recorded in the audit trail."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                void api
                  .remove(model.name, id ?? 0)
                  .then(() => {
                    invalidateModel(client, model.name);
                    toast({ tone: 'success', title: 'Deleted' });
                    return navigate({ to: '/$app/$model', params: { app, model: model.name } });
                  })
                  .catch((e: unknown) => {
                    setConfirmDelete(false);
                    setError(e instanceof ApiError ? e : new ApiError(0, { message: String(e) }));
                  })
              }
            >
              <TrashIcon /> Delete
            </Button>
          </>
        }
      />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ lines

function Lines({
  parent,
  field,
  columns,
  id,
  lines,
  editable,
  onChange,
}: {
  readonly parent: ModelMeta;
  readonly field: string;
  readonly columns: readonly string[];
  readonly id: number | undefined;
  readonly lines: Line[] | undefined;
  readonly editable: boolean;
  readonly onChange: (lines: Line[]) => void;
}) {
  const meta = useMeta();
  const f = parent.fields[field];
  const child = f?.target === undefined ? undefined : meta.models[f.target];
  const inverse = f?.inverseField;
  const loaded = useQuery({
    queryKey: ['records', f?.target ?? '-', 'lines', inverse, id],
    enabled: id !== undefined && child !== undefined && inverse !== undefined,
    queryFn: () =>
      api.search(f?.target ?? '', {
        where: { [inverse ?? 'id']: id },
        fields: columns.filter((c) => child?.fields[c] !== undefined),
        limit: 500,
      }),
  });
  const current: Line[] =
    lines ??
    (loaded.data?.rows ?? []).map((r) => ({
      key: `l${r.id}`,
      id: r.id,
      values: { ...r },
      dirty: false,
      deleted: false,
    }));
  if (child === undefined) return <p className="text-sm text-muted">You cannot see these lines.</p>;
  const shown = columns.filter((c) => child.fields[c] !== undefined);
  const update = (key: string, column: string, value: unknown) => {
    const next = current.map((l) =>
      l.key === key ? { ...l, values: { ...l.values, [column]: value }, dirty: true } : l,
    );
    onChange(next);
    if (child.fields[column]?.onchange === true) {
      const line = next.find((l) => l.key === key);
      if (line === undefined) return;
      const inputs = Object.fromEntries(
        Object.entries(line.values).map(([k, v]) => [k, toInput(child.fields[k], v)]),
      );
      void api.onchange(child.name, inputs, [column]).then((r) => {
        onChange(
          next.map((l) => (l.key === key ? { ...l, values: { ...l.values, ...r.values } } : l)),
        );
      });
    }
  };
  const visible = current.filter((l) => !l.deleted);
  return (
    <div className="-mx-6 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-medium tracking-wide text-faint uppercase">
            {shown.map((c) => (
              <th
                key={c}
                className={cx(
                  'px-3 py-2 font-medium first:pl-6',
                  numeric(child.fields[c]) ? 'text-right' : 'text-left',
                )}
              >
                {child.fields[c]?.label}
              </th>
            ))}
            <th className="w-10 pr-6" />
          </tr>
        </thead>
        <tbody>
          {visible.map((line) => (
            <tr key={line.key} className="group border-b border-line/70">
              {shown.map((c) => {
                const cf = child.fields[c] as FieldMeta;
                const readOnly = !editable || cf.readonly;
                return (
                  <td
                    key={c}
                    className={cx(
                      'px-3 py-1.5 align-middle first:pl-6',
                      numeric(cf) && 'text-right',
                    )}
                  >
                    {readOnly ? (
                      <FieldValue value={line.values[c]} field={cf} />
                    ) : (
                      <FieldInput
                        name={`${line.key}-${c}`}
                        field={cf}
                        value={line.values[c] ?? null}
                        onChange={(v) => update(line.key, c, v)}
                        invalid={false}
                        disabled={false}
                      />
                    )}
                  </td>
                );
              })}
              <td className="pr-6 text-right">
                {editable ? (
                  <button
                    type="button"
                    aria-label="Remove line"
                    onClick={() =>
                      onChange(
                        current
                          .map((l) => (l.key === line.key ? { ...l, deleted: true } : l))
                          .filter((l) => l.id !== undefined || !l.deleted),
                      )
                    }
                    className="rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger focus:opacity-100"
                  >
                    <TrashIcon size={14} />
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {visible.length === 0 ? (
        <p className="px-6 py-6 text-center text-sm text-faint">No lines yet.</p>
      ) : null}
      {editable ? (
        <div className="px-6 pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange([
                ...current,
                { key: `n${++lineKeys}`, id: undefined, values: {}, dirty: true, deleted: false },
              ])
            }
          >
            <PlusIcon /> Add a line
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ timeline

function Timeline({ model, id }: { readonly model: ModelMeta; readonly id: number }) {
  const meta = useMeta();
  const trail = useQuery({
    queryKey: ['records', model.name, 'trail', id],
    queryFn: () => api.trail(model.name, id),
  });
  const describe = (e: TrailEntry): string => {
    const f = e.field === null ? undefined : model.fields[e.field];
    if (e.action === 'create') return 'created this record';
    if (e.action === 'unlink') return 'deleted this record';
    if (e.action === 'transition')
      return `moved it to ${display(e.new, model.fields[model.stateField ?? ''], meta.user.lang, meta.user.tz) || String(e.new)}`;
    if (f !== undefined)
      return `changed ${f.label}: ${display(e.old, f, meta.user.lang, meta.user.tz) || '—'} → ${display(e.new, f, meta.user.lang, meta.user.tz) || '—'}`;
    return e.action;
  };
  return (
    <aside
      aria-label="History"
      className="hidden w-80 shrink-0 border-l border-line bg-surface/50 xl:block"
    >
      <div className="sticky top-0 flex items-center gap-2 border-b border-line px-5 py-4 text-sm font-semibold text-ink">
        <HistoryIcon className="text-muted" /> History
      </div>
      <ol className="grid gap-4 p-5">
        {trail.isPending ? <Skeleton className="h-20" /> : null}
        {(trail.data ?? []).map((e) => (
          <li key={e.id} className="flex animate-fade gap-3">
            <Avatar name={e.uid === 0 ? 'System' : `User ${e.uid}`} size={26} />
            <div className="min-w-0 text-[13px]">
              <p className="text-ink">
                <span className="font-medium">
                  {e.uid === 0 ? 'System' : e.uid === meta.user.id ? 'You' : `User #${e.uid}`}
                </span>{' '}
                {describe(e)}
              </p>
              <p className="mt-0.5 text-xs text-faint">
                {relative(e.at, meta.user.lang)}
                {e.reason !== null ? ` · ${e.reason}` : ''}
              </p>
            </div>
          </li>
        ))}
        {trail.data?.length === 0 ? (
          <p className="text-sm text-faint">No tracked changes yet.</p>
        ) : null}
      </ol>
    </aside>
  );
}
