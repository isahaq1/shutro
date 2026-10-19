/**
 * The client of `@shutro/server`: same-origin fetch with the session cookie and the CSRF token, typed errors that keep
 * the server's message, hint and field keys.
 */
import type { AppInfo, InstallPlan, UninstallPlan } from '@shutro/migrate';
import type { FieldMeta, Meta, ModelMeta, Ref } from '@shutro/server';

export type { AppInfo, FieldMeta, Meta, ModelMeta, Ref };

/** An API error: what went wrong, how to fix it, and which fields to mark. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string;
  readonly fields: readonly string[];
  constructor(
    status: number,
    body: { code?: string; message?: string; hint?: string; fields?: string[] },
  ) {
    super(body.message ?? `Request failed (${status}).`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? 'UNKNOWN';
    this.hint = body.hint ?? '';
    this.fields = body.fields ?? [];
  }
}

let csrf = '';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf === '' ? {} : { 'x-csrf-token': csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, json as ConstructorParameters<typeof ApiError>[1]);
  return json as T;
}

/** A row as the API returns it: plain values, `{ id, name }` for many2one, `{ amount, currency }` for money. */
export type Row = Readonly<Record<string, unknown>> & { readonly id: number };

/** A search domain: field → value, or an operator object. */
export type Where = Readonly<Record<string, unknown>>;

/** One audit row of a record's history (RFC 0013). */
export interface TrailEntry {
  readonly id: number;
  readonly at: string;
  readonly uid: number;
  readonly su: boolean;
  readonly reason: string | null;
  readonly action: string;
  /** The changed field of a `write` row. */
  readonly field: string | null;
  readonly old: unknown;
  readonly new: unknown;
}

const enc = encodeURIComponent;

export const api = {
  async session(): Promise<{ csrf: string; user: number; company: number }> {
    const s = await request<{ csrf: string; user: number; company: number }>(
      'GET',
      '/api/auth/session',
    );
    csrf = s.csrf;
    return s;
  },
  async login(login: string, password: string): Promise<void> {
    const r = await request<{ csrf: string }>('POST', '/api/auth/login', { login, password });
    csrf = r.csrf;
  },
  async logout(): Promise<void> {
    await request('POST', '/api/auth/logout');
    csrf = '';
  },
  switchCompany: (company: number) =>
    request<{ company: number }>('POST', '/api/auth/company', { company }),
  meta: () => request<Meta>('GET', '/api/meta'),
  search: (
    model: string,
    q: {
      where?: Where;
      order?: readonly string[];
      limit?: number;
      offset?: number;
      fields?: readonly string[];
    },
  ) => request<{ rows: Row[]; total: number }>('POST', `/api/records/${enc(model)}/search`, q),
  group: (model: string, by: string, where?: Where) =>
    request<{ groups: Record<string, unknown>[] }>('POST', `/api/records/${enc(model)}/group`, {
      by,
      ...(where === undefined ? {} : { where }),
    }),
  names: (model: string, q: string) =>
    request<{ names: Ref[] }>('GET', `/api/records/${enc(model)}/names?q=${enc(q)}`).then(
      (r) => r.names,
    ),
  read: (model: string, id: number, fields?: readonly string[]) =>
    request<{ row: Row; transitions: string[] }>(
      'GET',
      `/api/records/${enc(model)}/${id}${fields === undefined ? '' : `?fields=${enc(fields.join(','))}`}`,
    ),
  create: (model: string, values: Record<string, unknown>) =>
    request<{ id: number }>('POST', `/api/records/${enc(model)}`, { values }),
  write: (model: string, id: number, values: Record<string, unknown>, updatedAt?: unknown) =>
    request<{ ok: true }>('PATCH', `/api/records/${enc(model)}/${id}`, {
      values,
      ...(updatedAt === undefined ? {} : { expect: { updatedAt } }),
    }),
  remove: (model: string, id: number) =>
    request<void>('DELETE', `/api/records/${enc(model)}/${id}`),
  onchange: (
    model: string,
    values: Record<string, unknown>,
    changed: readonly string[],
    id?: number,
  ) =>
    request<{ values: Record<string, unknown>; warnings: string[] }>(
      'POST',
      `/api/records/${enc(model)}/onchange`,
      {
        values,
        changed,
        ...(id === undefined ? {} : { id }),
      },
    ),
  transition: (model: string, id: number, name: string) =>
    request<{ ok: true }>('POST', `/api/records/${enc(model)}/${id}/transition/${enc(name)}`),
  trail: (model: string, id: number) =>
    request<{ entries: TrailEntry[] }>('GET', `/api/records/${enc(model)}/${id}/trail`).then(
      (r) => r.entries,
    ),
  apps: () => request<{ apps: AppInfo[] }>('GET', '/api/apps').then((r) => r.apps),
  planInstall: (apps: readonly string[]) =>
    request<InstallPlan>('POST', '/api/apps/plan', { operation: 'install', apps }),
  planUninstall: (apps: readonly string[], purge = false) =>
    request<UninstallPlan>('POST', '/api/apps/plan', {
      operation: 'uninstall',
      apps,
      cascade: true,
      purge,
    }),
  install: (apps: readonly string[]) =>
    request<{ ms: number; warnings: string[] }>('POST', '/api/apps/install', { apps }),
  uninstall: (apps: readonly string[], purge = false) =>
    request<{ ms: number; warnings: string[] }>('POST', '/api/apps/uninstall', {
      apps,
      cascade: true,
      purge,
    }),
};
