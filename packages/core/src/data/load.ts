/**
 * Loading module data and resolving external ids (RFC 0017 §4). Each module's data loads in one system transaction
 * (`shutro.bootstrap`), in module load order, through the ORM: computes, sequences, constraints and the audit trail
 * apply as for any create or write.
 */
import { createHash } from 'node:crypto';
import { compile, sql } from '@shutro/sql';
import { Decimal as DecimalJs } from 'decimal.js';
import { type Env, internalsOf, type ScopeInternals, type Shutro } from '../env/env.js';
import { UnknownExternalIdError } from '../errors.js';
import type { Id } from '../model/id.js';
import { type DataRecord, fullId, isRef } from './data.js';

/** The external-id table (RFC 0017 §4). */
export const EXTERNAL_ID_TABLE = 'shutro_external_id';

const DDL = [
  `CREATE TABLE IF NOT EXISTS "${EXTERNAL_ID_TABLE}" ("module" text NOT NULL, "name" text NOT NULL, "model" text NOT NULL, "res_id" bigint NOT NULL, "noupdate" boolean NOT NULL DEFAULT false, "checksum" text, "updated_at" timestamp with time zone NOT NULL DEFAULT now(), PRIMARY KEY ("module", "name"))`,
  `CREATE INDEX IF NOT EXISTS "${EXTERNAL_ID_TABLE}_model_res_id_idx" ON "${EXTERNAL_ID_TABLE}" ("model", "res_id")`,
];

/** Statements that create the external-id table (for migrations or tests). */
export function externalIdTableStatements(): readonly {
  readonly text: string;
  readonly params: readonly [];
}[] {
  return DDL.map((text) => ({ text, params: [] as [] }));
}

async function tableExists(internals: ScopeInternals): Promise<boolean> {
  const [row] = await internals.query<{ present: boolean }>(
    compile(sql`SELECT to_regclass(${EXTERNAL_ID_TABLE}) IS NOT NULL AS present`),
  );
  return row?.present === true;
}

interface Row {
  readonly [column: string]: unknown;
  readonly module: string;
  readonly name: string;
  readonly model: string;
  readonly res_id: number | string;
  readonly noupdate: boolean;
  readonly checksum: string | null;
}

const lookups = new WeakMap<object, Map<string, { model: string; id: number }>>();

function split(id: string): [string, string] {
  const dot = id.indexOf('.');
  return [id.slice(0, dot), id.slice(dot + 1)];
}

/** The record id of external id `id` (cached per transaction). @throws {UnknownExternalIdError} */
async function resolveExternalId(
  internals: ScopeInternals,
  id: string,
  model?: string,
): Promise<number> {
  let cache = lookups.get(internals.cache);
  if (cache === undefined) {
    cache = new Map();
    lookups.set(internals.cache, cache);
  }
  let found = cache.get(id);
  if (found === undefined) {
    const [module, name] = split(id);
    const rows =
      name === '' || !(await tableExists(internals))
        ? []
        : await internals.query<Row>(
            compile(
              sql`SELECT model, res_id FROM ${sql.id(EXTERNAL_ID_TABLE)} WHERE module = ${module} AND name = ${name}`,
            ),
          );
    const row = rows[0];
    if (row === undefined)
      throw new UnknownExternalIdError(
        `The external id '${id}' does not exist.`,
        'Check the spelling, and that the module shipping it is installed and its data loaded (shutro migrate apply).',
      );
    found = { model: row.model, id: Number(row.res_id) };
    cache.set(id, found);
  }
  if (model !== undefined && found.model !== model)
    throw new UnknownExternalIdError(
      `The external id '${id}' is a ${found.model}, not a ${model}.`,
      'Use the model of the record.',
    );
  return found.id;
}

/** `env.refId(model, id)`. */
export async function refId<M extends string>(env: Env, model: M, id: string): Promise<Id<M>> {
  return (await resolveExternalId(internalsOf(env), id, model)) as Id<M>;
}

/** A stable text of declared values for checksums: refs by id, Decimals as strings, sorted keys. */
function stable(value: unknown): unknown {
  if (isRef(value)) return { $ref: value.id };
  if (DecimalJs.isDecimal(value)) return { $decimal: (value as DecimalJs).toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  return value;
}

function checksumOf(record: DataRecord): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(record.values)))
    .digest('hex')
    .slice(0, 32);
}

async function resolveValues(internals: ScopeInternals, value: unknown): Promise<unknown> {
  if (isRef(value)) return resolveExternalId(internals, value.id, value.model);
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolveValues(internals, v)));
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveValues(internals, v);
    return out;
  }
  return value;
}

/** Values for an update: x2many `create` commands are left out (they would add children at every load). */
function forUpdate(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'create' in v) {
      const { create: _create, ...rest } = v as Record<string, unknown>;
      if (Object.keys(rest).length > 0) out[k] = rest;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** What {@link loadData} did for one module. */
export interface DataLoadResult {
  readonly module: string;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: number;
  /** `noupdate` records that already exist: left to the users. */
  readonly kept: readonly string[];
  readonly deleted: readonly string[];
  /** Ids no longer declared whose record could not be deleted (still referenced): kept, with the reason. */
  readonly retained: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Loads the data of every installed module (RFC 0017 §4), idempotently: new ids are created, changed records
 * updated, unchanged ones skipped (checksums), `noupdate` records left alone once they exist, and ids no longer
 * declared deleted with their records. Run by `shutro migrate apply` after the schema.
 */
export async function loadData(
  shutro: Shutro,
  options: { readonly company?: number; readonly modules?: readonly string[] } = {},
): Promise<DataLoadResult[]> {
  const results: DataLoadResult[] = [];
  const registry = shutro.registry;
  if (registry === undefined)
    throw new UnknownExternalIdError(
      'loadData() needs a Shutro instance with a registry.',
      'Pass registry to createShutro.',
    );
  for (const module of registry.modules) {
    if (options.modules !== undefined && !options.modules.includes(module.name)) continue;
    // Modules without data still run: ids a previous version declared are deleted.
    const result = await shutro.bootstrap(
      {
        reason: `data: ${module.name}`,
        ...(options.company === undefined ? {} : { company: options.company }),
      },
      async (env) => loadModule(env as Env, module.name, module.data),
    );
    if (
      result.created.length +
        result.updated.length +
        result.deleted.length +
        result.unchanged +
        result.kept.length +
        result.retained.length >
      0
    )
      results.push(result);
  }
  return results;
}

async function loadModule(
  scoped: Env,
  module: string,
  data: readonly DataRecord[],
): Promise<DataLoadResult> {
  const internals = internalsOf(scoped);
  // Model names come from the data at runtime: an environment untyped over them.
  const env = scoped as unknown as Env<Record<string, unknown>>;
  for (const statement of DDL) await internals.query({ text: statement, params: [] });
  const rows = await internals.query<Row>(
    compile(
      sql`SELECT module, name, model, res_id, noupdate, checksum FROM ${sql.id(EXTERNAL_ID_TABLE)} WHERE module = ${module}`,
    ),
  );
  const existing = new Map(rows.map((r) => [r.name, r]));
  const out = {
    module,
    created: [] as string[],
    updated: [] as string[],
    unchanged: 0,
    kept: [] as string[],
    deleted: [] as string[],
    retained: [] as { id: string; reason: string }[],
  };
  const declared = new Set<string>();

  for (const rec of data) {
    const id = fullId(module, rec);
    const key = rec.kind === 'override' ? id : rec.name; // overrides are bookkept under the overriding module
    declared.add(key);
    const row = existing.get(key);
    const checksum = checksumOf(rec);
    const model = internals.registry.get(rec.model).model;
    const target =
      rec.kind === 'override'
        ? await resolveExternalId(internals, id, rec.model)
        : row === undefined
          ? undefined
          : Number(row.res_id);
    const alive =
      target !== undefined &&
      (
        await internals.query<{ id: number }>(
          compile(
            sql`SELECT ${sql.id('id')} FROM ${sql.id(model.table)} WHERE ${sql.id('id')} = ${target}`,
          ),
        )
      ).length > 0;
    // A noupdate record belongs to the users once created: kept as they left it, even deleted.
    if (rec.noupdate && row !== undefined) {
      out.kept.push(id);
      continue;
    }
    const values = (await resolveValues(internals, rec.values)) as Record<string, unknown>;
    if (rec.kind === 'record' && !alive) {
      const created = await env.model(rec.model).create([values as never]);
      const resId = created.ids[0] as number;
      await internals.query(
        compile(
          sql`INSERT INTO ${sql.id(EXTERNAL_ID_TABLE)} (module, name, model, res_id, noupdate, checksum) VALUES (${module}, ${rec.name}, ${rec.model}, ${resId}, ${rec.noupdate}, ${checksum})
              ON CONFLICT (module, name) DO UPDATE SET res_id = EXCLUDED.res_id, model = EXCLUDED.model, noupdate = EXCLUDED.noupdate, checksum = EXCLUDED.checksum, updated_at = now()`,
        ),
      );
      lookups.get(internals.cache)?.set(id, { model: rec.model, id: resId });
      out.created.push(id);
      continue;
    }
    if (rec.kind === 'override' && !alive)
      throw new UnknownExternalIdError(
        `'${id}' (overridden by ${module}) has no record.`,
        'Load the owning module first.',
      );
    if (row?.checksum === checksum) {
      out.unchanged++;
      continue;
    }
    await env
      .model(rec.model)
      .browse([target as number])
      .write(forUpdate(values) as never);
    await internals.query(
      compile(
        sql`INSERT INTO ${sql.id(EXTERNAL_ID_TABLE)} (module, name, model, res_id, noupdate, checksum) VALUES (${module}, ${key}, ${rec.model}, ${target as number}, ${false}, ${checksum})
            ON CONFLICT (module, name) DO UPDATE SET checksum = EXCLUDED.checksum, updated_at = now()`,
      ),
    );
    out.updated.push(id);
  }

  // Ids this module no longer declares: delete their records (overrides only lose their bookkeeping).
  for (const [name, row] of existing) {
    if (declared.has(name)) continue;
    const id = name.includes('.') ? name : `${module}.${name}`;
    if (row.noupdate) continue;
    const forget = compile(
      sql`DELETE FROM ${sql.id(EXTERNAL_ID_TABLE)} WHERE module = ${module} AND name = ${name}`,
    );
    if (name.includes('.')) {
      await internals.query(forget);
      continue;
    }
    const table = internals.registry.has(row.model)
      ? internals.registry.get(row.model).model.table
      : undefined;
    const present =
      table !== undefined &&
      (
        await internals.query<{ id: number }>(
          compile(
            sql`SELECT ${sql.id('id')} FROM ${sql.id(table)} WHERE ${sql.id('id')} = ${Number(row.res_id)}`,
          ),
        )
      ).length > 0;
    if (!present) {
      await internals.query(forget); // the record is already gone (or its model uninstalled)
      continue;
    }
    try {
      await env.transaction(async (e) => {
        await e
          .model(row.model)
          .browse([Number(row.res_id)])
          .unlink();
      });
      await internals.query(forget);
      out.deleted.push(id);
    } catch (error) {
      out.retained.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  await env.flush();
  return out;
}
