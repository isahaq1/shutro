/**
 * Related fields: a field that mirrors a field of a related record through many2one steps (`'partner.country.code'`),
 * built on the compute engine, so stored related fields get dependency tracking, batching and audit like any
 * stored compute. With `writable: true`, writing the field writes the related record.
 *
 * ```ts
 * partnerEmail: f.char({ ...related('partner.email') }),                      // read-only, computed on load
 * currency: f.many2one('res.currency', { store: true, ...related('order.currency') }),
 * ```
 */
import { InvalidFieldError } from '../errors.js';
import type { ComputeFn, InverseFn } from './field.js';

const RELATED = Symbol.for('shutro.related');
const PATH = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/;

type Rec = Record<string, unknown> & { write(values: Record<string, unknown>): Promise<void> };

/** The path a compute function mirrors, when it is a {@link related} compute. */
export function relatedPath(fn: unknown): string | undefined {
  return typeof fn === 'function' ? (fn as { [RELATED]?: string })[RELATED] : undefined;
}

function idOf(value: unknown): unknown {
  // The last step of a many2one path is a record: store its id.
  if (typeof value === 'object' && value !== null && 'ids' in value && 'modelName' in value)
    return (value as { ids: readonly number[] }).ids[0] ?? null;
  return value;
}

/** Field options mirroring `path`; spread them into the field. @throws {InvalidFieldError} for a malformed path. */
export function related(
  path: string,
  options: { readonly writable: true },
): {
  readonly depends: readonly [string];
  readonly compute: ComputeFn;
  readonly inverse: InverseFn;
};
export function related(
  path: string,
  options?: { readonly writable?: false },
): { readonly depends: readonly [string]; readonly compute: ComputeFn };
export function related(
  path: string,
  options: { readonly writable?: boolean } = {},
): {
  readonly depends: readonly [string];
  readonly compute: ComputeFn;
  readonly inverse?: InverseFn;
} {
  if (!PATH.test(path))
    throw new InvalidFieldError(
      `${JSON.stringify(path)} is not a related path.`,
      "Use many2one steps then a field: related('partner.email'), related('order.partner.country').",
    );
  const steps = path.split('.');
  const last = steps.at(-1) as string;
  const parent = (record: Rec): Rec | null => {
    let current: unknown = record;
    for (const step of steps.slice(0, -1)) {
      current = (current as Record<string, unknown> | null)?.[step] ?? null;
      if (current === null) return null;
    }
    return current as Rec;
  };
  const compute = (records: Iterable<Rec>, keys: readonly string[]): void => {
    for (const r of records) {
      const from = parent(r);
      const value = from === null ? null : idOf(from[last]);
      for (const key of keys) r[key] = value;
    }
  };
  Object.defineProperty(compute, RELATED, { value: path });
  const inverse = async (records: Iterable<Rec>, key: string): Promise<void> => {
    for (const r of records) {
      const target = parent(r);
      if (target === null)
        throw new InvalidFieldError(
          `Cannot write '${key}': the related record along '${path}' is empty.`,
          `Set ${steps.slice(0, -1).join('.')} first.`,
        );
      await target.write({ [last]: idOf(r[key]) });
    }
  };
  return Object.freeze({
    depends: Object.freeze([path]) as readonly [string],
    compute: compute as unknown as ComputeFn,
    ...(options.writable === true ? { inverse: inverse as unknown as InverseFn } : {}),
  });
}
