# Spike 0001 — Type cost of loaded-shape recordsets

- **Status:** Complete (2026-10-14). **Outcome: keep the full design; the fallback is not needed.**
- **Answers:** RFC 0004 §11 Q1 (type-system budget). Resolution recorded there: use the fallback if the full design fails.
- **Code:** removed after the decision; it is in the history at [`ffc594d:spikes/recordset-types`](https://github.com/isahaq1/shutro/tree/ffc594d/spikes/recordset-types)

## Question

RFC 0004 tracks the **loaded shape** `L` in `RecordSet<M, L>`, so that reading a field that wasn't loaded is a compile
error, including through nested relations (`o.lines[i].product.name`). Is that affordable for TypeScript 7 on an
ERP-sized schema, or do we fall back to tracking only top-level loads?

## Variants measured

| Variant | What the types track | Corresponds to |
| ------- | -------------------- | -------------- |
| `none` | Nothing. Every field is always accessible (runtime-checked only). | Baseline: the cost of the schema and the API without any load tracking |
| `flat` | Loaded fields of the recordset itself. Records reached through a loaded relation are fully accessible (runtime-checked). | RFC 0004 §11 Q1 fallback |
| `full` | Loaded fields at every level (depth ≤ 4), merged across successive `load()` calls. | RFC 0004 §7.2 design |

All three share the same generated schema interfaces (shaped like RFC 0002 §7.7) and the same usage code.

## Workload

- `N` ∈ {100, 300, 700} models. Each has 16 scalar fields (string / number / boolean / Decimal / CalendarDate, random
  `required`), 5 many2one, 2 one2many and 1 many2many, with random targets, so there are many cycles.
  Generated with a seeded PRNG, so the workload is reproducible.
- `U = N` usage functions, 25 per file. Each one searches, loads a 3-level nested spec, and reads typed values at every level,
  assigning them to explicitly typed locals. That way the run also checks that the types are *correct* at scale.
- A `U = 0` run per variant isolates the schema cost from the per-function cost.

## Success criteria (fixed before measuring)

The `full` variant passes at **N = 300** if all of the following hold:

| # | Criterion | Threshold |
| - | --------- | --------- |
| C1 | Whole-project check time, single-threaded | ≤ 10 s |
| C2 | Memory | ≤ 1.5 GB |
| C3 | Marginal check cost per usage function, `(t(U=N) − t(U=0)) / U` | ≤ 10 ms (≈ 250 ms per 25-function file, an editor-latency proxy) |
| C4 | No "excessively deep" / "infinite" instantiation errors at N = 700 | none |
| C5 | Correctness type tests (`typetests.ts`) pass | all |

If `full` fails C1–C4 but `flat` passes, we adopt the fallback.

## Results

### Default models (16 scalars + 5 many2one + 3 x2many)

<!-- results:start -->
Node v25.2.1, TypeScript 7.0.2, win32/x64, median of 3 single-threaded runs.

| N | Variant | Total (s) | Check (s) | Memory (MB) | Types | Instantiations | Per usage fn (ms) | Errors |
| -: | ------- | --------: | --------: | ----------: | ----: | -------------: | ----------------: | -----: |
| 100 | none | 0.15 | 0.05 | 49 | 6252 | 61357 | 0.47 | 0 |
| 100 | flat | 0.18 | 0.07 | 53 | 9820 | 82535 | 0.80 | 0 |
| 100 | full | 0.27 | 0.16 | 65 | 23228 | 221666 | 1.68 | 0 |
| 300 | none | 0.32 | 0.19 | 79 | 17489 | 183987 | 0.66 | 0 |
| 300 | flat | 0.38 | 0.24 | 90 | 27849 | 246769 | 0.88 | 0 |
| 300 | full | 0.62 | 0.50 | 130 | 68221 | 665062 | 1.65 | 0 |
| 700 | none | 0.63 | 0.48 | 138 | 39962 | 428900 | 0.68 | 0 |
| 700 | flat | 0.79 | 0.62 | 163 | 63875 | 574449 | 0.90 | 0 |
| 700 | full | 1.45 | 1.29 | 253 | 157590 | 1548622 | 1.85 | 0 |

| # | Criterion (full, N = 300) | Measured | Result |
| - | ------------------------- | -------: | ------ |
| C1 | Check time ≤ 10 s (single-threaded total) | 0.62 s | ✅ pass |
| C2 | Memory ≤ 1.5 GB | 130 MB | ✅ pass |
| C3 | Per usage function ≤ 10 ms | 1.65 ms | ✅ pass |
| C4 | No deep-instantiation errors at N = 700 | 0 errors | ✅ pass |
| C5 | Type tests pass | see `pnpm typecheck` | ✅ pass |

Reference: full, N = 300 with default (multi-threaded) checkers: total 0.21 s, check 0.18 s.
<!-- results:end -->

### Wide models: stress test (80 scalars + 15 many2one + 3 x2many, Odoo `sale.order`-sized)

<!-- wide:start -->
Node v25.2.1, TypeScript 7.0.2, win32/x64, median of 3 single-threaded runs. Models: 80 scalars + 15 many2one + 3 x2many each.

| N | Variant | Total (s) | Check (s) | Memory (MB) | Types | Instantiations | Per usage fn (ms) | Errors |
| -: | ------- | --------: | --------: | ----------: | ----: | -------------: | ----------------: | -----: |
| 100 | none | 0.22 | 0.12 | 65 | 6422 | 164479 | 1.01 | 0 |
| 100 | flat | 0.28 | 0.16 | 74 | 9979 | 185550 | 1.51 | 0 |
| 100 | full | 0.41 | 0.29 | 98 | 23732 | 331722 | 2.75 | 0 |
| 300 | none | 0.55 | 0.40 | 128 | 17690 | 495577 | 1.17 | 0 |
| 300 | flat | 0.65 | 0.50 | 153 | 28048 | 558159 | 1.50 | 0 |
| 300 | full | 1.16 | 1.02 | 224 | 68389 | 993806 | 3.17 | 0 |
| 700 | none | 1.32 | 1.09 | 255 | 40198 | 1145399 | 1.35 | 0 |
| 700 | flat | 1.71 | 1.48 | 319 | 64116 | 1290496 | 1.85 | 0 |
| 700 | full | 2.88 | 2.65 | 472 | 157927 | 2311224 | 3.59 | 0 |

| # | Criterion (full, N = 300) | Measured | Result |
| - | ------------------------- | -------: | ------ |
| C1 | Check time ≤ 10 s (single-threaded total) | 1.16 s | ✅ pass |
| C2 | Memory ≤ 1.5 GB | 224 MB | ✅ pass |
| C3 | Per usage function ≤ 10 ms | 3.17 ms | ✅ pass |
| C4 | No deep-instantiation errors at N = 700 | 0 errors | ✅ pass |
| C5 | Type tests pass | see `pnpm typecheck` | ✅ pass |

Reference: full, N = 300 with default (multi-threaded) checkers: total 0.47 s, check 0.41 s.
<!-- wide:end -->

### TypeScript 5.9 (editors and tools still on the JS language service)

Single runs (TS 5.9 has no `--singleThreaded`; it's always single-threaded), N = 300, same generated workloads.

| Models | Variant | Total (s) | Per usage fn (ms) |
| ------ | ------- | --------: | ----------------: |
| default | none | 1.26 | 2.73 |
| default | flat | 1.44 | 3.33 |
| default | full | 2.31 | 6.17 |
| wide | none | 1.88 | 3.70 |
| wide | flat | 2.23 | 5.13 |
| wide | full | 3.40 | 9.00 |

## Conclusion

**The `full` variant (RFC 0004 §7.2) passes C1–C5 with a wide margin on TypeScript 7**, so we keep it. The fallback is not needed.

- **Cost:** compared with no load tracking, `full` costs about 2–2.5× in check time and about 3.5× in instantiations. In absolute
  terms it's small: 0.62 s for a 300-model project (1.16 s with Odoo-sized models), and 1.7–3.6 ms per usage function.
  The per-function cost stays flat from N = 100 to N = 700, so it scales linearly with code size, not with schema size.
- **TypeScript 5.9 margin:** C3 passes on TS 5.9 too (6.2 ms default, 9.0 ms wide), but only just for wide models. If editor latency is
  reported on TS 5.x language services, the first lever is to cap nested shapes at depth 3 instead of 4.
- **Memory:** at most 472 MB (wide, N = 700), well under C2.

### Lessons carried into the implementation (`packages/core`)

1. **"No relations loaded" must be a type with no keys** (`Record<never, never>`). An index signature makes `keyof` = `string`, so every relation
   looks loaded. The type tests caught this on the first run.
2. **Loaded-shape parameters are unconstrained and read through `infer` helpers** (`SOf<L>`, `ROf<L>`). A `L extends Loaded`
   constraint can't be proven for mapped/conditional `Merge` results in generic code (TS2344).
3. **A nested object spec loads the relation's default columns as well** (`lines: { product: true }` loads the line defaults plus
   products), because the runtime query selects them anyway. Only the array form narrows. RFC 0004 §7.1 is amended accordingly,
   and the `'*'` key is dropped as redundant.
4. **The generator emits `defaults` as a precomputed union per model**, rather than deriving it with mapped types at use sites.

### Limitations

- Editor latency was approximated by per-function check cost. It wasn't measured through a language server.
- The workload is synthetic. The `examples/erp-demo` integration tests (Phase 6) will add query-count *and* type-check-time
  budgets to CI, so a regression would surface there.
