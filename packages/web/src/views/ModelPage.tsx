/**
 * A model's collection page: header (title, count, search, view switch, New), then the list or the kanban.
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  KanbanIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  Skeleton,
  useToast,
} from '@shutro/ui';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type ModelMeta, type Row, type Where } from '../api.js';
import { numeric, plural } from '../format.js';
import { invalidateModel, useModel } from '../session.js';
import { FieldValue } from './fields.js';

const PAGE = 80;

export function ModelPage() {
  const { app, model: name } = useParams({ strict: false }) as { app: string; model: string };
  const model = useModel(name);
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // The chosen view per model: switching models starts each one on its own choice (list by default).
  const [views, setViews] = useState<Readonly<Record<string, 'list' | 'kanban'>>>({});
  const view = views[name] ?? 'list';
  const setView = (v: 'list' | 'kanban') => setViews((all) => ({ ...all, [name]: v }));
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 220);
    return () => clearTimeout(t);
  }, [text]);
  if (model === undefined)
    return (
      <EmptyState title="Not available">
        This screen does not exist, or your role cannot see it.
      </EmptyState>
    );
  const where: Where | undefined =
    query === '' || model.recName === 'id'
      ? undefined
      : { [model.recName]: { ilike: `%${query}%` } };
  const canKanban = model.views.kanban !== null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface/40 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{plural(model.label)}</h1>
        <Count model={model} where={where} />
        <div className="flex-1" />
        <div className="relative w-full max-w-64">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Search ${plural(model.label).toLowerCase()}…`}
            aria-label="Search"
            className="h-8.5 w-full rounded-md border border-line bg-surface pr-3 pl-8 text-sm shadow-xs placeholder:text-faint focus:border-accent focus:ring-3 focus:ring-accent-soft focus:outline-none"
          />
        </div>
        {canKanban ? (
          <fieldset
            className="flex rounded-md border border-line bg-surface p-0.5 shadow-xs"
            aria-label="View"
          >
            {(
              [
                ['list', <ListIcon key="l" />, 'List'],
                ['kanban', <KanbanIcon key="k" />, 'Board'],
              ] as const
            ).map(([v, icon, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cx(
                  'flex h-7 items-center gap-1.5 rounded px-2.5 text-[13px] font-medium',
                  view === v ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink',
                )}
              >
                {icon}
                {label}
              </button>
            ))}
          </fieldset>
        ) : null}
        {model.access.create ? (
          <Button
            variant="primary"
            onClick={() => void navigate({ to: '/$app/$model/new', params: { app, model: name } })}
          >
            <PlusIcon /> New
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {view === 'kanban' && canKanban ? (
          <Kanban model={model} app={app} where={where} />
        ) : (
          <List model={model} app={app} where={where} />
        )}
      </div>
    </div>
  );
}

function Count({ model, where }: { readonly model: ModelMeta; readonly where: Where | undefined }) {
  const { data } = useQuery({
    queryKey: ['records', model.name, 'count', where],
    queryFn: () =>
      api.search(model.name, { ...(where === undefined ? {} : { where }), limit: 1, fields: [] }),
  });
  return data === undefined ? null : <Badge>{data.total.toLocaleString()}</Badge>;
}

// ------------------------------------------------------------------------------------------------ list

function List({
  model,
  app,
  where,
}: {
  readonly model: ModelMeta;
  readonly app: string;
  readonly where: Where | undefined;
}) {
  const navigate = useNavigate();
  const columns = model.views.list.columns.filter((c) => model.fields[c] !== undefined);
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const order = sort === null ? undefined : [`${sort.key} ${sort.desc ? 'desc' : 'asc'}`];
  const query = useInfiniteQuery({
    queryKey: ['records', model.name, 'list', where, order, columns],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.search(model.name, {
        ...(where === undefined ? {} : { where }),
        ...(order === undefined ? {} : { order }),
        fields: columns,
        limit: PAGE,
        offset: pageParam,
      }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 44,
    overscan: 12,
  });
  const items = virtual.getVirtualItems();
  const last = items.at(-1);
  useEffect(() => {
    if (
      last !== undefined &&
      last.index >= rows.length - 10 &&
      query.hasNextPage &&
      !query.isFetchingNextPage
    )
      void query.fetchNextPage();
  }, [last, rows.length, query]);

  const template = columns
    .map((c) =>
      model.fields[c]?.kind === 'monetary'
        ? 'minmax(170px,0.9fr)'
        : numeric(model.fields[c])
          ? 'minmax(110px,0.7fr)'
          : 'minmax(140px,1fr)',
    )
    .join(' ');
  if (query.isPending)
    return (
      <div className="grid gap-2 p-6">
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  if (rows.length === 0)
    return (
      <EmptyState
        icon={<ListIcon size={22} />}
        title={where === undefined ? `No ${model.label.toLowerCase()} yet` : 'Nothing matches'}
      >
        {where === undefined && model.access.create
          ? 'Create the first one with New.'
          : 'Try another search.'}
      </EmptyState>
    );
  // A virtualized grid: rows are absolutely positioned, which <table> rows cannot be, so the table semantics come
  // from ARIA roles on divs (the documented pattern for virtual lists).
  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized rows need positioned divs (see above)
    <div
      ref={parent}
      className="h-full overflow-auto"
      role="table"
      aria-label={model.label}
      aria-rowcount={rows.length}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: virtualized grid (see above) */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: the header row holds focusable sort buttons */}
      <div
        role="row"
        className="sticky top-0 z-10 grid border-b border-line bg-canvas/95 px-6 backdrop-blur"
        style={{ gridTemplateColumns: template }}
      >
        {columns.map((c) => {
          const f = model.fields[c];
          const active = sort?.key === c;
          return (
            // biome-ignore lint/a11y/useSemanticElements: virtualized grid; the header cell is the sort button
            <button
              key={c}
              type="button"
              role="columnheader"
              aria-sort={active ? (sort?.desc === true ? 'descending' : 'ascending') : 'none'}
              onClick={() =>
                setSort(
                  active && sort?.desc === false
                    ? { key: c, desc: true }
                    : active
                      ? null
                      : { key: c, desc: false },
                )
              }
              className={cx(
                'flex h-10 items-center gap-1 px-3 text-xs font-medium tracking-wide text-faint uppercase hover:text-ink',
                numeric(f) && 'justify-end',
              )}
            >
              {f?.label}
              {active ? (
                sort?.desc === true ? (
                  <ArrowDownIcon size={12} />
                ) : (
                  <ArrowUpIcon size={12} />
                )
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="relative" style={{ height: virtual.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index] as Row;
          return (
            // biome-ignore lint/a11y/useSemanticElements: virtualized grid row (absolutely positioned)
            <div
              key={row.id}
              role="row"
              tabIndex={0}
              onClick={() =>
                void navigate({
                  to: '/$app/$model/$id',
                  params: { app, model: model.name, id: String(row.id) },
                })
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  void navigate({
                    to: '/$app/$model/$id',
                    params: { app, model: model.name, id: String(row.id) },
                  });
              }}
              className="absolute inset-x-0 grid cursor-pointer items-center border-b border-line/70 px-6 text-sm transition-colors hover:bg-accent-soft/40 focus-visible:bg-accent-soft/60"
              style={{
                transform: `translateY(${item.start}px)`,
                height: item.size,
                gridTemplateColumns: template,
              }}
            >
              {columns.map((c, i) => (
                // biome-ignore lint/a11y/useSemanticElements: virtualized grid cell
                <div
                  key={c}
                  role="cell"
                  className={cx(
                    'truncate px-3',
                    numeric(model.fields[c]) && 'text-right',
                    i === 0 && 'font-medium text-ink',
                  )}
                >
                  <FieldValue value={row[c]} field={model.fields[c]} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ kanban

function Kanban({
  model,
  app,
  where,
}: {
  readonly model: ModelMeta;
  readonly app: string;
  readonly where: Where | undefined;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const kanban = model.views.kanban;
  const groupBy = kanban?.groupBy ?? '';
  const groupField = model.fields[groupBy];
  const isState = groupField?.kind === 'state' || groupField?.kind === 'selection';
  const fields = [model.recName, groupBy, ...(kanban?.card ?? [])].filter(
    (f, i, a) => model.fields[f] !== undefined && a.indexOf(f) === i,
  );

  const stages = useQuery({
    queryKey: ['records', groupField?.target ?? '-', 'stages'],
    enabled: !isState && groupField?.target !== undefined,
    queryFn: () => api.search(groupField?.target ?? '', { order: ['sequence asc'], limit: 50 }),
  });
  const columns: readonly { key: string | number; label: string }[] = isState
    ? (groupField?.selection ?? []).map(([k, label]) => ({ key: k, label }))
    : (stages.data?.rows ?? []).map((s) => ({ key: s.id, label: String(s['name'] ?? `#${s.id}`) }));

  const cards = useQuery({
    queryKey: ['records', model.name, 'kanban', where, fields],
    queryFn: () =>
      api.search(model.name, { ...(where === undefined ? {} : { where }), fields, limit: 500 }),
  });
  // Optimistic moves belong to the data they were made on: a refetch (new dataUpdatedAt) drops them.
  const [optimistic, setOptimistic] = useState<{
    readonly at: number;
    readonly moves: ReadonlyMap<number, string | number>;
  }>({ at: 0, moves: new Map() });
  const moved =
    optimistic.at === cards.dataUpdatedAt ? optimistic.moves : new Map<number, string | number>();
  const setMoved = (
    fn: (m: ReadonlyMap<number, string | number>) => ReadonlyMap<number, string | number>,
  ) => setOptimistic({ at: cards.dataUpdatedAt, moves: fn(moved) });
  const keyOf = (row: Row): string | number | null => {
    const local = moved.get(row.id);
    if (local !== undefined) return local;
    const v = row[groupBy];
    return typeof v === 'object' && v !== null ? (v as { id: number }).id : (v as string | null);
  };

  const drop = async (event: DragEvent, to: string | number) => {
    event.preventDefault();
    const id = Number(event.dataTransfer.getData('text/x-record'));
    const row = cards.data?.rows.find((r) => r.id === id);
    if (row === undefined || keyOf(row) === to) return;
    const from = keyOf(row);
    setMoved((m) => new Map(m).set(id, to));
    try {
      if (groupField?.kind === 'state') {
        // Only what the state machine allows: the transition from here to there.
        const name = Object.entries(model.transitions).find(
          ([, t]) => t.to === to && t.from.includes(String(from)),
        )?.[0];
        if (name === undefined) {
          const target = columns.find((c) => c.key === to)?.label ?? String(to);
          throw new ApiError(409, {
            message: `No step leads from here to ${target}.`,
            hint: 'Open the record to see what it can do next.',
          });
        }
        await api.transition(model.name, id, name);
      } else await api.write(model.name, id, { [groupBy]: to });
      invalidateModel(client, model.name);
    } catch (error) {
      setMoved((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
      const e = error instanceof ApiError ? error : undefined;
      toast({
        tone: 'danger',
        title: e?.message ?? 'The card could not move.',
        ...(e?.hint ? { description: e.hint } : {}),
      });
    }
  };

  if (cards.isPending)
    return (
      <div className="flex gap-4 p-6">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-64 w-72" />
        ))}
      </div>
    );
  return (
    <div className="flex h-full gap-4 overflow-x-auto p-6">
      {columns.map((col) => {
        const list = (cards.data?.rows ?? []).filter((r) => keyOf(r) === col.key);
        return (
          <section
            key={String(col.key)}
            aria-label={col.label}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => void drop(e, col.key)}
            className="flex w-72 shrink-0 flex-col rounded-xl bg-sunken/70 p-2"
          >
            <header className="flex items-center justify-between px-2 pt-1 pb-2.5">
              <h2 className="text-sm font-semibold text-ink">{col.label}</h2>
              <Badge>{list.length}</Badge>
            </header>
            <div className="grid min-h-16 content-start gap-2 overflow-y-auto">
              {list.map((row) => (
                <Card
                  key={row.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/x-record', String(row.id))}
                  onClick={() =>
                    void navigate({
                      to: '/$app/$model/$id',
                      params: { app, model: model.name, id: String(row.id) },
                    })
                  }
                  className="cursor-grab animate-in p-3 transition-shadow hover:shadow-pop active:cursor-grabbing"
                >
                  <p className="truncate text-sm font-medium text-ink">
                    <FieldValue value={row[model.recName]} field={model.fields[model.recName]} />
                  </p>
                  <div className="mt-2 grid gap-1 text-[13px] text-muted">
                    {(kanban?.card ?? [])
                      .filter((f) => row[f] !== null && row[f] !== undefined && row[f] !== '')
                      .map((f) => (
                        <div
                          key={f}
                          className={cx('truncate', numeric(model.fields[f]) && 'text-ink')}
                        >
                          <FieldValue value={row[f]} field={model.fields[f]} />
                        </div>
                      ))}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
