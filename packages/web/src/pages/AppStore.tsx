/**
 * The app store (RFC 0020 R8, RFC 0019 §7.8): browse, install and uninstall apps with the exact plan first.
 */
import {
  AppIcon,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  SearchIcon,
  Skeleton,
  Spinner,
  StoreIcon,
  Switch,
  useToast,
} from '@shutro/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, type AppInfo, api } from '../api.js';
import { hueOf } from '../format.js';
import { useMeta } from '../session.js';

type Pending =
  | {
      readonly op: 'install';
      readonly app: AppInfo;
      readonly plan: Awaited<ReturnType<typeof api.planInstall>>;
    }
  | {
      readonly op: 'uninstall';
      readonly app: AppInfo;
      readonly plan: Awaited<ReturnType<typeof api.planUninstall>>;
    };

export function AppStore() {
  const meta = useMeta();
  const client = useQueryClient();
  const toast = useToast();
  const apps = useQuery({
    queryKey: ['apps'],
    queryFn: api.apps,
    enabled: meta.user.administrator,
  });
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(
    () =>
      (apps.data ?? [])
        .filter((a) => a.application)
        .filter((a) =>
          `${a.label} ${a.summary} ${a.category}`.toLowerCase().includes(filter.toLowerCase()),
        ),
    [apps.data, filter],
  );

  if (!meta.user.administrator)
    return (
      <EmptyState icon={<StoreIcon size={22} />} title="Administrators only">
        Ask an administrator to install or remove apps.
      </EmptyState>
    );

  const plan = async (app: AppInfo, op: 'install' | 'uninstall') => {
    setBusy(app.name);
    try {
      setPurge(false);
      setPending(
        op === 'install'
          ? { op, app, plan: await api.planInstall([app.name]) }
          : { op, app, plan: await api.planUninstall([app.name]) },
      );
    } catch (e) {
      const err = e instanceof ApiError ? e : undefined;
      toast({
        tone: 'danger',
        title: err?.message ?? 'No plan could be made.',
        ...(err?.hint ? { description: err.hint } : {}),
      });
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (pending === null) return;
    setBusy(pending.app.name);
    try {
      const result =
        pending.op === 'install'
          ? await api.install([pending.app.name])
          : await api.uninstall([pending.app.name], purge);
      toast({
        tone: 'success',
        title: `${pending.app.label} ${pending.op === 'install' ? 'installed' : 'uninstalled'} in ${(result.ms / 1000).toFixed(1)}s`,
        ...(result.warnings.length > 0 ? { description: result.warnings.join(' ') } : {}),
      });
      setPending(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['apps'] }),
        client.invalidateQueries({ queryKey: ['meta'] }),
      ]);
    } catch (e) {
      const err = e instanceof ApiError ? e : undefined;
      toast({
        tone: 'danger',
        title: err?.message ?? 'The change failed; nothing was changed.',
        ...(err?.hint ? { description: err.hint } : {}),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl animate-fade px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">App store</h1>
          <p className="mt-1 text-sm text-muted">
            Install and remove apps. Each change runs in one transaction: it fully works or changes
            nothing.
          </p>
        </div>
        <div className="relative w-full max-w-64">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-8.5 w-full rounded-md border border-line bg-surface pr-3 pl-8 text-sm shadow-xs focus:border-accent focus:ring-3 focus:ring-accent-soft focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps.isPending
          ? [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)
          : null}
        {list.map((app) => (
          <Card key={app.name} className="flex flex-col p-5">
            <div className="flex items-start gap-4">
              <AppIcon svg={app.icon} glyph={app.glyph} hue={hueOf(app.name)} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-semibold text-ink">{app.label}</h2>
                  {app.required ? <Badge>Required</Badge> : null}
                </div>
                <p className="mt-0.5 text-xs text-faint">
                  {app.category} · v{app.version}
                </p>
              </div>
            </div>
            <p className="mt-3 line-clamp-2 flex-1 text-sm text-muted">{app.summary}</p>
            <div className="mt-4 flex items-center justify-between gap-2">
              {app.state === 'installed' ? (
                <Badge tone={app.upgradable ? 'warning' : 'success'} dot>
                  {app.upgradable ? `Update to ${app.version}` : 'Installed'}
                </Badge>
              ) : app.state === 'quarantined' ? (
                <Badge tone="warning" dot>
                  Data kept until{' '}
                  {app.purgeAfter === null ? '?' : new Date(app.purgeAfter).toLocaleDateString()}
                </Badge>
              ) : (
                <Badge>Not installed</Badge>
              )}
              {app.state === 'installed' ? (
                app.required ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === app.name}
                    onClick={() => void plan(app, 'uninstall')}
                  >
                    Uninstall
                  </Button>
                )
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === app.name}
                  onClick={() => void plan(app, 'install')}
                >
                  {app.state === 'quarantined' ? 'Restore' : 'Install'}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        wide
        title={
          pending === null
            ? ''
            : `${pending.op === 'install' ? 'Install' : 'Uninstall'} ${pending.app.label}`
        }
        description={
          pending?.op === 'install'
            ? 'These modules are installed together, in one transaction.'
            : 'Review what is removed. Audit history is always kept.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant={pending?.op === 'uninstall' ? 'danger' : 'primary'}
              loading={busy !== null}
              onClick={() => void confirm()}
            >
              {busy !== null ? <Spinner size={14} /> : null}
              {pending?.op === 'install'
                ? 'Install'
                : purge
                  ? 'Uninstall and delete data'
                  : 'Uninstall'}
            </Button>
          </>
        }
      >
        {pending !== null ? (
          <div className="grid gap-5">
            <section>
              <h3 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">
                Modules
              </h3>
              <ul className="grid gap-1.5">
                {pending.plan.modules.map((m) => (
                  <li
                    key={m.name}
                    className="flex items-center justify-between rounded-md bg-sunken/70 px-3 py-2 text-sm"
                  >
                    <span className="font-medium text-ink">
                      {m.glyph} {m.label}
                    </span>
                    <span className="text-xs text-muted">
                      {m.reason === 'auto'
                        ? 'connects installed apps'
                        : m.reason === 'dependency'
                          ? 'needed by it'
                          : m.reason === 'dependent'
                            ? 'depends on it'
                            : m.reason}
                      {m.restore ? ' · data restored' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            {pending.op === 'uninstall' ? (
              <>
                <section>
                  <h3 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">
                    Data affected
                  </h3>
                  {pending.plan.tables.length + pending.plan.columns.length === 0 ? (
                    <p className="text-sm text-muted">No stored data.</p>
                  ) : (
                    <ul className="grid gap-1 text-sm">
                      {pending.plan.tables.map((t) => (
                        <li key={t.table} className="flex justify-between">
                          <span className="font-mono text-[13px] text-ink">{t.table}</span>
                          <span className="tabular text-muted">{t.rows.toLocaleString()} rows</span>
                        </li>
                      ))}
                      {pending.plan.columns.map((c) => (
                        <li key={`${c.table}.${c.column}`} className="flex justify-between">
                          <span className="font-mono text-[13px] text-ink">
                            {c.table}.{c.column}
                          </span>
                          <span className="tabular text-muted">
                            {c.rows.toLocaleString()} values
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <div className="flex items-start gap-3 rounded-lg border border-line p-3">
                  <Switch
                    checked={purge}
                    onCheckedChange={setPurge}
                    label="Delete the data for good"
                  />
                  <span className="text-sm">
                    <span className="font-medium text-ink">Delete the data for good</span>
                    <span className="block text-muted">
                      {purge
                        ? 'The data above is deleted and cannot be restored.'
                        : `Off: the data is kept for ${pending.plan.retentionDays} days, and installing the app again restores it.`}
                    </span>
                  </span>
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
