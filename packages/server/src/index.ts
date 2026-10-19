/**
 * @packageDocumentation
 * `@shutro/server`: the HTTP API of the web client (RFC 0020): sign-in and sessions, the metadata API, the records
 * API, live change events, and the app store.
 *
 * @example
 * ```ts
 * const apps = createAppManager({ driver, modules: officialApps });
 * const shutro = createShutro({ driver, registry: await apps.registry(), catalog: apps.catalog });
 * const server = createServer({ shutro, driver, apps, staticDir: webDist });
 * await server.listen(8069);
 * ```
 */
export {
  ensureAuthTables,
  hashPassword,
  LOCKOUT,
  type Membership,
  MIN_PASSWORD,
  resolveSession,
  SESSION_DAYS,
  type Session,
  setMembership,
  setPassword,
  signIn,
  signOut,
  verifyPassword,
} from './auth.js';
export { type DynamicEnv, type DynamicModel, type DynamicRecords, dynamic } from './dynamic.js';
export { HttpError } from './errors.js';
export { SECURITY_HEADERS, toHttp } from './http.js';
export {
  buildMeta,
  type FieldMeta,
  generateViews,
  type MenuMeta,
  type Meta,
  type ModelMeta,
  type TransitionMeta,
  type ViewsMeta,
} from './meta.js';
export type { Ref } from './records.js';
export { CHANGES_CHANNEL, createServer, type ServerOptions, type ShutroServer } from './server.js';
