/**
 * The id of a record of model `M`: a `number` branded per model, so a product id can't be passed where a partner
 * id is expected (RFC 0001 W6, Q2). Backed by PostgreSQL `bigint`; the driver rejects values above
 * `Number.MAX_SAFE_INTEGER`.
 */
export type Id<M extends string> = number & { readonly __model: M };

/** Brands a plain number as an id. Use only at trusted boundaries (driver rows, validated input). */
export function asId<M extends string>(value: number, _model: M): Id<M> {
  return value as Id<M>;
}

/**
 * Typed writes to a one2many or many2many field (RFC 0001 §7.6), replacing Odoo's command tuples. `C` and `W` are
 * the target model's create and write faces once a schema view binds them; unbound, any record shape is accepted.
 */
export interface X2ManyCommands<
  T extends string,
  C = Readonly<Record<string, unknown>>,
  W = Readonly<Record<string, unknown>>,
> {
  /** Create new records linked to this one (the inverse field is filled in by the ORM). */
  readonly create?: readonly C[];
  /** Update linked records. */
  readonly update?: readonly { readonly id: Id<T>; readonly values: W }[];
  /** Delete linked records. */
  readonly delete?: readonly Id<T>[];
  /** Link existing records (many2many) or re-point them here (one2many). */
  readonly link?: readonly Id<T>[];
  /** Remove the link without deleting the record. */
  readonly unlink?: readonly Id<T>[];
  /** Replace the whole set. */
  readonly set?: readonly Id<T>[];
  /** Remove every link. */
  readonly clear?: true;
}
