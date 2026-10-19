import { AppIcon, ChevronRightIcon, PlusIcon } from '@shutro/ui';
import { Link } from '@tanstack/react-router';
import { hueOf } from '../format.js';
import { useMeta } from '../session.js';

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function Home() {
  const meta = useMeta();
  const first = (meta.user.name || meta.user.login).split(' ')[0];
  const summaries = new Map(meta.apps.map((a) => [a.name, a.summary]));
  return (
    <div className="mx-auto max-w-6xl animate-fade px-6 py-10">
      <p className="text-sm font-medium text-accent">
        {new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date())}
      </p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink">
        {greeting()}, {first}.
      </h1>
      <p className="mt-2 text-muted">Pick an app, or press ⌘K to jump anywhere.</p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {meta.menus.map((menu) => (
          <Link
            key={menu.app}
            to="/$app/$model"
            params={{ app: menu.app, model: menu.models[0]?.model ?? '' }}
            className="group relative flex items-start gap-4 overflow-hidden rounded-xl border border-line bg-surface p-5 shadow-card transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop"
          >
            <span
              className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{
                background: `radial-gradient(circle, oklch(0.75 0.15 ${hueOf(menu.app)} / 0.18), transparent 70%)`,
              }}
            />
            <AppIcon svg={menu.icon} glyph={menu.glyph} hue={hueOf(menu.app)} size={48} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h2 className="font-semibold text-ink">{menu.label}</h2>
                <ChevronRightIcon className="text-faint transition-transform duration-200 group-hover:translate-x-0.5" />
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted">
                {summaries.get(menu.app) ?? menu.category}
              </p>
              <p className="mt-3 text-xs text-faint">
                {menu.models.length} screen{menu.models.length === 1 ? '' : 's'}
              </p>
            </div>
          </Link>
        ))}
        {meta.user.administrator ? (
          <Link
            to="/apps"
            className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong p-5 text-sm font-medium text-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent"
          >
            <PlusIcon /> Install more apps
          </Link>
        ) : null}
      </div>
    </div>
  );
}
