/**
 * Field types as `shutro generate` spells them (RFC 0002 §7.7), exported as the `F` namespace.
 *
 * `O` uses the builders' option vocabulary with `true` standing for presence (`{ required: true; default: true;
 * compute: 'computeAmounts'; store: true }`), so a generated field has exactly the type the builder gives the
 * declared one: the generated view and the inferred view are interchangeable.
 */
import type {
  BinaryField,
  CharField,
  DecimalField,
  FlagsOf,
  FloatField,
  IdField,
  JsonField,
  Many2manyField,
  Many2oneField,
  MonetaryField,
  One2manyField,
  QuantityField,
  ScalarField,
  SelectionField,
  StateField,
  Transition,
} from './field.js';

type NoOptions = Record<never, never>;
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/** The implicit `id` of model `M`. */
export type Id<M extends string> = IdField<M>;
/** `f.char`. */
export type Char<O = NoOptions> = CharField<FlagsOf<O>>;
/** `f.text`. */
export type Text<O = NoOptions> = ScalarField<'text', string, string, FlagsOf<O>>;
/** `f.html`. */
export type Html<O = NoOptions> = ScalarField<'html', string, string, FlagsOf<O>> & {
  readonly sanitize: boolean;
};
/** `f.boolean` (always required, always defaulted). */
export type Bool<O = NoOptions> = ScalarField<
  'boolean',
  boolean,
  boolean,
  FlagsOf<O, { required: true; hasDefault: true }>
>;
/** `f.integer`. */
export type Integer<O = NoOptions> = ScalarField<'integer', number, number, FlagsOf<O>>;
/** `f.bigint`. */
export type Bigint<O = NoOptions> = ScalarField<'bigint', number, bigint | number, FlagsOf<O>>;
/** `f.float`. */
export type Float<O = NoOptions> = FloatField<FlagsOf<O>>;
/** `f.decimal`. */
export type Decimal<O = NoOptions> = DecimalField<FlagsOf<O>>;
/** `f.monetary`; `C` is the sibling currency field. */
export type Monetary<C extends string, O = NoOptions> = MonetaryField<C, FlagsOf<O>>;
/** `f.quantity`; `U` is the sibling unit-of-measure field. */
export type Quantity<U extends string, O = NoOptions> = QuantityField<U, FlagsOf<O>>;
/** `f.selection`; `V` is the union of values (`string` for dynamic selections). */
export type Selection<V extends string, O = NoOptions> = SelectionField<V, FlagsOf<O>>;
/** `f.state`; `S` is the union of states. */
export type State<S extends string, O = NoOptions> = StateField<
  S,
  Record<string, Transition<S>>,
  FlagsOf<O>
>;
/** `f.json`. */
export type Json<V = unknown, O = NoOptions> = JsonField<V, FlagsOf<O>>;
/** `f.binary`. */
export type Binary<O = NoOptions> = BinaryField<FlagsOf<O>>;
/** `f.date`. */
export type DateOnly<O = NoOptions> = ScalarField<'date', string, string, FlagsOf<O>>;
/** `f.datetime`. */
export type Datetime<O = NoOptions> = ScalarField<'datetime', Date, Date, FlagsOf<O>>;
/** `f.many2one`. */
export type Many2one<T extends string, O = NoOptions> = Many2oneField<T, FlagsOf<O>>;
/** `f.one2many`. */
export type One2many<T extends string, O = NoOptions> = One2manyField<
  T,
  FlagsOf<O, { required: true; hasDefault: true }>
>;
/** `f.many2many`. */
export type Many2many<T extends string, O = NoOptions> = Many2manyField<
  T,
  FlagsOf<O, { required: true; hasDefault: true }>
>;

type Contributions<Mod> = Mod extends {
  readonly models: readonly (infer X)[];
  readonly extensions: readonly (infer Y)[];
}
  ? X | Y
  : never;
/**
 * The `methods` that module `Mod` (its models and extensions) declares on model `N`. Generated views intersect one
 * of these per contributing module, so method types come from the sources without a compiler API.
 */
export type Methods<Mod, N extends string> = UnionToIntersection<
  Extract<Contributions<Mod>, { readonly name: N }> extends infer C
    ? C extends { readonly methods: infer M }
      ? M
      : never
    : never
>;
