/**
 * The signed-in session: metadata, theme, and live updates. Everything below the shell reads `useMeta()`.
 */
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { ApiError, api, type Meta, type ModelMeta } from './api.js';

// ------------------------------------------------------------------------------------------------ theme

export type ThemePreference = 'system' | 'light' | 'dark';

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem('shutro.theme');
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme: ThemePreference): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): [ThemePreference, (theme: ThemePreference) => void] {
  const [theme, setTheme] = useState<ThemePreference>(readPreference);
  useEffect(() => applyTheme(theme), [theme]);
  const choose = useCallback((next: ThemePreference) => {
    try {
      localStorage.setItem('shutro.theme', next);
    } catch {
      // Private windows: the choice lasts for this page only.
    }
    setTheme(next);
  }, []);
  return [theme, choose];
}

// ------------------------------------------------------------------------------------------------ meta

const MetaContext = createContext<Meta | undefined>(undefined);

/** The metadata of the signed-in user (inside the shell). */
export function useMeta(): Meta {
  const meta = useContext(MetaContext);
  if (meta === undefined) throw new Error('useMeta() outside the signed-in shell');
  return meta;
}

/** A model's metadata, or `undefined` when the user cannot see it. */
export function useModel(name: string): ModelMeta | undefined {
  return useMeta().models[name];
}

/** Loads the session and the metadata; `undefined` while loading, `null` when signed out. */
export function useSessionMeta(): { meta: Meta | null | undefined; error: unknown } {
  const query = useQuery({
    queryKey: ['meta'],
    queryFn: async () => {
      try {
        await api.session();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
      return api.meta();
    },
    staleTime: 60_000,
  });
  return { meta: query.data, error: query.error };
}

export function MetaProvider({
  meta,
  children,
}: {
  readonly meta: Meta;
  readonly children: ReactNode;
}) {
  return <MetaContext.Provider value={meta}>{children}</MetaContext.Provider>;
}

// ------------------------------------------------------------------------------------------------ live updates

/** Keeps open lists and records fresh: the server announces committed changes, matching queries refetch. */
export function useLiveUpdates(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    source.addEventListener('change', (event) => {
      try {
        const change = JSON.parse((event as MessageEvent<string>).data) as { model?: string };
        if (typeof change.model === 'string') invalidateModel(client, change.model);
      } catch {
        // A malformed event changes nothing.
      }
    });
    return () => source.close();
  }, [enabled, client]);
}

/** Refetches every query of a model (lists, groups, records). */
export function invalidateModel(client: QueryClient, model: string): void {
  void client.invalidateQueries({ queryKey: ['records', model] });
}
