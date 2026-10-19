/**
 * The signed-in layout (RFC 0020 §7.6): app rail, the current app's sidebar, the top bar, and the ⌘K palette.
 */
import {
  AppIcon,
  Avatar,
  BuildingIcon,
  ChevronDownIcon,
  type CommandItem,
  CommandPalette,
  cx,
  GridIcon,
  Kbd,
  LogOutIcon,
  Menu,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  Spinner,
  StoreIcon,
  SunIcon,
  ToastProvider,
  Tooltip,
} from '@shutro/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Meta } from '../api.js';
import { hueOf, plural } from '../format.js';
import {
  MetaProvider,
  type ThemePreference,
  useLiveUpdates,
  useSessionMeta,
  useTheme,
} from '../session.js';

/** The app a model belongs to in the menus. */
export function appOfModel(meta: Meta, model: string): string {
  return meta.menus.find((m) => m.models.some((x) => x.model === model))?.app ?? 'settings';
}

export function Shell() {
  const { meta, error } = useSessionMeta();
  const navigate = useNavigate();
  useLiveUpdates(meta !== null && meta !== undefined);
  useEffect(() => {
    if (meta === null) void navigate({ to: '/login' });
  }, [meta, navigate]);
  if (error !== null && error !== undefined)
    return (
      <div className="flex min-h-dvh items-center justify-center p-6 text-center text-sm text-muted">
        The server cannot be reached. Check that `shutro serve` is running, then reload.
      </div>
    );
  if (meta === undefined || meta === null)
    return (
      <div className="flex min-h-dvh items-center justify-center text-faint">
        <Spinner size={22} />
      </div>
    );
  return (
    <MetaProvider meta={meta}>
      <ToastProvider>
        <Layout meta={meta} />
      </ToastProvider>
    </MetaProvider>
  );
}

function Layout({ meta }: { readonly meta: Meta }) {
  const params = useParams({ strict: false }) as { app?: string; model?: string };
  const navigate = useNavigate();
  const client = useQueryClient();
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = useState(false);
  const current = meta.menus.find((m) => m.app === params.app);
  const company = meta.user.companies.find((c) => c.id === meta.user.company);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    client.clear();
    await navigate({ to: '/login' });
  }, [client, navigate]);

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];
    for (const menu of meta.menus) {
      for (const m of menu.models) {
        items.push({
          id: `go:${m.model}`,
          group: 'Go to',
          label: plural(m.label),
          hint: menu.label,
          icon: <AppIcon svg={menu.icon} glyph={menu.glyph} hue={hueOf(menu.app)} size={20} />,
          keywords: [m.model, menu.label],
          run: () =>
            void navigate({ to: '/$app/$model', params: { app: menu.app, model: m.model } }),
        });
        if (meta.models[m.model]?.access.create === true)
          items.push({
            id: `new:${m.model}`,
            group: 'Create',
            label: `New ${m.label.toLowerCase()}`,
            icon: <PlusIcon />,
            keywords: ['create', 'add'],
            run: () =>
              void navigate({ to: '/$app/$model/new', params: { app: menu.app, model: m.model } }),
          });
      }
    }
    if (meta.user.administrator)
      items.push({
        id: 'apps',
        group: 'Go to',
        label: 'App store',
        icon: <StoreIcon />,
        run: () => void navigate({ to: '/apps' }),
      });
    const themes: [ThemePreference, string, ReactNode][] = [
      ['light', 'Light theme', <SunIcon key="l" />],
      ['dark', 'Dark theme', <MoonIcon key="d" />],
      ['system', 'System theme', <MonitorIcon key="s" />],
    ];
    for (const [value, label, icon] of themes)
      items.push({
        id: `theme:${value}`,
        group: 'Preferences',
        label,
        icon,
        run: () => setTheme(value),
      });
    items.push({
      id: 'signout',
      group: 'Preferences',
      label: 'Sign out',
      icon: <LogOutIcon />,
      run: () => void signOut(),
    });
    return items;
  }, [meta, navigate, setTheme, signOut]);

  /**
   * Records matching the typed text, across the business models people look things up in: those with a workflow,
   * and contacts, products, projects and tasks.
   */
  const searchRecords = useCallback(
    async (text: string): Promise<CommandItem[]> => {
      const preferred = new Set([
        'res.partner',
        'product.product',
        'project.project',
        'project.task',
      ]);
      const targets = meta.menus
        .flatMap((menu) =>
          menu.models.map((m) => ({ app: menu.app, menu, model: m.model, label: m.label })),
        )
        .filter((t) => preferred.has(t.model) || meta.models[t.model]?.stateField != null);
      const results = await Promise.all(
        targets.slice(0, 10).map(async (t) => {
          const names = await api.names(t.model, text).catch(() => []);
          return names.slice(0, 4).map(
            (n): CommandItem => ({
              id: `rec:${t.model}:${n.id}`,
              group: 'Records',
              label: n.name,
              hint: t.label,
              icon: <AppIcon svg={t.menu.icon} glyph={t.menu.glyph} hue={hueOf(t.app)} size={20} />,
              run: () =>
                void navigate({
                  to: '/$app/$model/$id',
                  params: { app: t.app, model: t.model, id: String(n.id) },
                }),
            }),
          );
        }),
      );
      return results.flat();
    },
    [meta, navigate],
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* App rail */}
      <nav
        aria-label="Apps"
        className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-line bg-surface py-3"
      >
        <Tooltip content="Home">
          <Link
            to="/"
            className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-sunken hover:text-ink"
            aria-label="Home"
          >
            <GridIcon size={20} />
          </Link>
        </Tooltip>
        {meta.menus.map((menu) => (
          <Tooltip key={menu.app} content={menu.label}>
            <Link
              to="/$app/$model"
              params={{ app: menu.app, model: menu.models[0]?.model ?? '' }}
              aria-label={menu.label}
              className={cx(
                'relative rounded-xl p-1 transition-transform duration-150 hover:scale-105',
                params.app === menu.app && 'bg-accent-soft',
              )}
            >
              <AppIcon svg={menu.icon} glyph={menu.glyph} hue={hueOf(menu.app)} size={34} />
              {params.app === menu.app ? (
                <span className="absolute top-2 -left-3 h-6 w-1 rounded-r-full bg-accent" />
              ) : null}
            </Link>
          </Tooltip>
        ))}
        <div className="flex-1" />
        {meta.user.administrator ? (
          <Tooltip content="App store">
            <Link
              to="/apps"
              aria-label="App store"
              className="flex h-10 w-10 items-center justify-center rounded-xl text-muted hover:bg-sunken hover:text-ink"
            >
              <StoreIcon size={20} />
            </Link>
          </Tooltip>
        ) : null}
      </nav>

      {/* Current app */}
      {current !== undefined ? (
        <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/60 md:flex">
          <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
            <AppIcon svg={current.icon} glyph={current.glyph} hue={hueOf(current.app)} size={26} />
            <span className="truncate font-semibold tracking-tight text-ink">{current.label}</span>
          </div>
          <nav aria-label={current.label} className="grid gap-0.5 px-2">
            {current.models.map((m) => (
              <Link
                key={m.model}
                to="/$app/$model"
                params={{ app: current.app, model: m.model }}
                className={cx(
                  'truncate rounded-md px-2.5 py-1.5 text-sm transition-colors',
                  params.model === m.model
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted hover:bg-sunken hover:text-ink',
                )}
              >
                {plural(m.label)}
              </Link>
            ))}
          </nav>
        </aside>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/80 px-4 backdrop-blur">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex h-9 w-full max-w-md items-center gap-2.5 rounded-lg border border-line bg-sunken/60 px-3 text-sm text-faint transition-colors hover:border-line-strong hover:text-muted"
          >
            <SearchIcon />
            <span className="flex-1 text-left">Search or jump to…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <div className="flex-1" />
          {meta.user.companies.length > 1 ? (
            <Menu
              label="Switch company"
              trigger={
                <button
                  type="button"
                  className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-muted hover:bg-sunken hover:text-ink"
                >
                  <BuildingIcon /> <span className="hidden sm:inline">{company?.name}</span>{' '}
                  <ChevronDownIcon />
                </button>
              }
              items={meta.user.companies.map((c) => ({
                label: c.name,
                onSelect: () => void api.switchCompany(c.id).then(() => client.invalidateQueries()),
              }))}
            />
          ) : (
            <span className="hidden items-center gap-2 text-sm text-muted sm:flex">
              <BuildingIcon /> {company?.name}
            </span>
          )}
          <Menu
            label={
              <span>
                <span className="block text-sm font-medium text-ink">{meta.user.name}</span>
                <span className="block text-xs text-faint">{meta.user.login}</span>
              </span>
            }
            trigger={
              <button
                type="button"
                aria-label="Account"
                className="rounded-full ring-offset-2 ring-offset-canvas hover:ring-2 hover:ring-line"
              >
                <Avatar name={meta.user.name || meta.user.login} size={32} />
              </button>
            }
            items={[
              { label: 'Light', icon: <SunIcon />, onSelect: () => setTheme('light') },
              { label: 'Dark', icon: <MoonIcon />, onSelect: () => setTheme('dark') },
              {
                label: `System${theme === 'system' ? ' ✓' : ''}`,
                icon: <MonitorIcon />,
                onSelect: () => setTheme('system'),
              },
              'separator',
              {
                label: 'Sign out',
                icon: <LogOutIcon />,
                onSelect: () => void signOut(),
                danger: true,
              },
            ]}
          />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      <CommandPalette
        items={commands}
        open={palette}
        onOpenChange={setPalette}
        onSearch={searchRecords}
      />
    </div>
  );
}
