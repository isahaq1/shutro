# RFC 0006 — Money, decimals & currency

- **Status:** Accepted (2026-10-14)
- **Author:** Shutro core
- **Created:** 2026-10-14
- **Depends on:** 0001, 0003, 0004, 0005
- **Related:** account/tax engine (examples), sequence and audit (Phase 3)

---

## 1. Summary

- Every business number that isn't a count is a **`Decimal`** (an isolated decimal.js constructor) in code and
  **`numeric`** in PostgreSQL.
- Monetary values are **`Money`**: an immutable `{ amount: Decimal, currency }` value object. Arithmetic between two `Money`
  values requires the same currency, and that's **always checked at runtime**. Conversion is a separate, explicit, **dated** operation
  (`env.fx.convert(money, to, { date })`).
- Quantities are **`Quantity`**: `{ value: Decimal, uom }`, with explicit unit-of-measure conversion.
- The types keep `Money`, `Quantity`, `Decimal` and `number` apart. The compiler rejects `money.plus(decimal)`,
  `quantity.plus(money)` and any `number` input that isn't an integer.
- Rounding is defined by the currency (or the named precision): half-up by default, half-even and cash rounding as options.
  Comparisons are done at currency precision (`isZero`, `equals`), and allocation keeps every cent.

---

## 2. Problem & ERP requirements

| #   | Requirement |
| --- | ----------- |
| R1  | **Exact arithmetic.** `0.1 + 0.2 = 0.3`, and so does every sum of journal items. |
| R2  | **Currency precision and rounding:** BDT/USD/EUR 2 decimals, JPY 0, KWD/BHD 3. Methods: half-up, half-even (banker's), and cash rounding (CHF 0.05, BDT cash to whole taka). |
| R3  | **Unit prices and rates need more precision than the currency** (price 0.0035 USD per unit, FX rate 0.0083333333). |
| R4  | **No accidental cross-currency arithmetic or aggregation** (`CLAUDE.md` coding rule). Conversion is always explicit and **dated**. |
| R5  | **Multi-currency accounting:** transaction currency vs company currency on every journal item, dated rates per company, exchange-difference entries. |
| R6  | **Tax rounding policies:** per line vs global (Odoo's `round_per_line` / `round_globally`), with deterministic allocation of rounding differences. |
| R7  | **Allocation without losing cents:** installments, cost splits, landed costs, discount distribution. |
| R8  | **Quantities with UoM:** dozen ↔ unit, kg ↔ g, with UoM rounding (you can't sell 0.3 of a "unit" when the UoM rounding is 1). |
| R9  | **Named, configurable precisions** for prices, discounts and weights (Odoo's `decimal.precision`). |
| R10 | **Lossless I/O:** DB ↔ driver ↔ JSON never pass through binary floating point. |

---

## 3. How Odoo does it

```python
amount_total = fields.Monetary(currency_field='currency_id')          # numeric column, Python float in memory
price_unit   = fields.Float(digits='Product Price')                   # named precision, runtime-configurable

if float_is_zero(move.amount_residual, precision_rounding=move.currency_id.rounding): ...
if float_compare(a, b, precision_digits=2) == 0: ...
amount = currency.round(amount)
company_amount = currency._convert(amount, company.currency_id, company, invoice_date)

# res.currency: rounding (e.g. 0.01), decimal_places; res.currency.rate: name (date), rate, company_id
# account.tax._compute_taxes(...) handles round_per_line / round_globally
```

### Weaknesses

| #  | Weakness | Consequence |
| -- | -------- | ----------- |
| W1 | **Python `float` in memory** for every Monetary and Float field, even though the column is `numeric`. | Drift (`0.1 + 0.2`) everywhere. Developers have to remember `float_round`, `float_compare` and `float_is_zero`. Accounting code is full of defensive rounding. |
| W2 | **Nothing stops mixing currencies:** `order.amount_total + invoice.amount_total` works in any currencies, and `read_group` sums across currencies. | Silent nonsense totals in reports and dashboards. |
| W3 | **`_convert` takes a date, but it's easy to pass `fields.Date.today()`** instead of the document date. | Wrong valuations and exchange differences. |
| W4 | **Monetary columns have no scale.** Rounding to currency precision happens in some code paths but not in others (SQL writes, imports). | Values like `100.004999` stored and displayed differently in different places. |
| W5 | **Client (JS) and server (Python) round differently** in some widgets. | Totals in the UI differ by 0.01 from the posted invoice. |
| W6 | **Allocation is ad hoc** (each module distributes rounding differences its own way). | Inconsistent installment and cost splits. |

What's worth keeping: currency-linked monetary fields, named precisions, dated per-company rates, explicit tax rounding policies,
and the `rounding` attribute on currencies (it expresses cash rounding better than "decimal places").

---

## 4. Prior art

| Library or ORM | Approach | Lessons |
| -------------- | -------- | ------- |
| **Prisma** | `Decimal` columns ↔ `Prisma.Decimal` (decimal.js). No money or currency concept. | ✅ decimal.js is a proven choice for exact DB numerics in JS. ❌ Currency is left to the user. |
| **Drizzle** | `numeric` → `string` by default (or `mode: 'number'`, which is lossy, or `'bigint'`). | ✅ Strings are lossless. ❌ No arithmetic type. Users convert manually. |
| **Kysely** | Whatever the driver returns (`pg` returns `numeric` as string). | ❌ Nothing ORM-level. |
| **MikroORM** | `DecimalType` maps to `string` (default) or `number`. | ❌ No money concept. |
| **dinero.js** (library) | Immutable money as **integer minor units** plus currency and scale. Currency mismatch throws. Allocation (`allocate`) with remainder distribution. | ✅ **Currency-checked arithmetic and allocation are the right primitives.** ⚠️ Integer minor units are awkward for unit prices and rates with more precision than the currency (R3), and for PostgreSQL `numeric` interop. |
| **TC39 `Decimal` proposal** | A native decimal type is in progress, but not yet available in Node LTS. | ✅ Hiding the implementation behind Shutro's own `Decimal` type keeps a future switch possible. |

No mainstream TS ORM treats currency as a first-class concept. That's an opportunity for Shutro to differentiate.

---

## 5. Options

### Option A — Integer minor units (dinero / Stripe style)

Money is stored as `bigint` cents in the database and in code.

### Option B — `numeric` + `Decimal`, with `Money` / `Quantity` value objects

Exact decimals at any scale. Rounding is applied explicitly by currency or precision rules at defined points (write, display, posting).

### Option C — Strings in code, arithmetic in SQL

Values stay strings in TS, and computations are pushed to PostgreSQL `numeric`.

### Trade-offs

| Criterion | A: minor units | B: Decimal + Money | C: strings + SQL |
| --------- | -------------- | ------------------ | ---------------- |
| Exact | ✅ | ✅ | ✅ |
| Unit prices and rates with extra precision (R3) | ❌ needs per-field scale juggling | ✅ | ✅ |
| Arithmetic in compute code | ✅ | ✅ | ❌ round-trips to the DB |
| Matches PostgreSQL `numeric` and `CLAUDE.md` (decimal.js) | ❌ | ✅ | ⚠️ |
| Currency-checked operations | ✅ | ✅ | ❌ |
| Performance | ✅ fastest | ⚠️ decimal.js is roughly 10–50× slower than float. Fine for ERP batch sizes, and benchmarked in Phase 1. | ❌ |
| Readability of stored data for SQL/BI users | ⚠️ "12345" means 123.45 | ✅ | ✅ |

---

## 6. Decision

**Option B.**

1. **`Decimal`** is an isolated decimal.js constructor created with `Decimal.clone({ precision: 64, rounding: ROUND_HALF_UP })`.
   *(Amended 2026-10-14: originally 40. [Spike 0002](../spikes/0002-driver-benchmark.md) K1 showed sums of
   42-significant-digit values rounding at 40; unconstrained `numeric` columns can hold more. RFC 0007.)*
   Shutro **never mutates the global decimal.js config** (`CLAUDE.md`: no global mutable state). The type is re-exported as
   `@shutro/core`'s `Decimal`, so the implementation can be swapped later (e.g. for a native TC39 Decimal).
2. **`Money`** is immutable, with a currency reference (id, code, rounding, decimal places, rounding method).
   Same-currency checks run at runtime **on every operation**. Different currencies throw `CurrencyMismatchError`.
3. **Static separation:** `Money`, `Quantity`, `Decimal` and integer `number` are distinct types. Static per-currency tagging is
   deferred (§11, Q1).
4. **Conversion requires a date and a company** (`env.fx`), is batched, and its results carry the rate used, for audit.
5. **Rounding points are defined:**
   - Stored monetary values are rounded to the currency on write. Rounding only happens on write, never on read.
   - Intermediate computation stays unrounded.
   - Taxes follow the company policy.
6. `numeric` is parsed into `Decimal` at the driver level (type OID 1700). JSON serializes amounts as **strings**.

---

## 7. Detailed design

### 7.1 Decimal inputs

```ts
type DecimalInput = Decimal | string | bigint | SafeInteger;   // SafeInteger: number, checked at runtime to be an integer

price.times(3);         // ✅ integer number
price.times('0.15');    // ✅
price.times(0.15);      // ❌ runtime NonIntegerNumberError: "0.15 is a binary float. Pass '0.15' (string) or a Decimal."
                        //    (also flagged at compile time when the literal is visibly fractional, via the lint rule no-float-literal-in-decimal)
```

Field faces (RFC 0001): `decimal` reads as `Decimal`, and create/write accept `Decimal | string`. `number` is rejected at the type level for
decimal, monetary and quantity fields.

### 7.2 Currencies

`res.currency` is a model owned by `base`:

| Field | Example | Meaning |
| ----- | ------- | ------- |
| `name` | `'BDT'` | ISO 4217 code |
| `symbol`, `position` | `'৳'`, `'before'` | Display |
| `decimalPlaces` | `2` | Display and storage precision |
| `rounding` | `'0.01'` (or `'0.05'` CHF cash, `'1'` BDT cash) | Smallest unit (Odoo's `rounding`) |
| `roundingMethod` | `'half-up'` \| `'half-even'` \| `'up'` \| `'down'` | Default `'half-up'` |

`Money` holds a frozen snapshot of these attributes, loaded once per transaction through the registry-level currency cache. So
arithmetic never queries the database.

### 7.3 The `Money` API

```ts
const bdt = env.currency('BDT');                       // Record<'res.currency'> from the cache (one query per transaction, at most)
const price = bdt.money('85000.00');                   // Money (BDT)

price.plus(bdt.money('1500'));                         // Money (BDT)
price.times('2');                                      // Money (BDT), unrounded: 170000.00
price.times('0.15').round();                           // Money rounded to BDT rounding (0.01, half-up)
price.dividedBy(3);                                    // Money, unrounded: 28333.333…
price.negated(); price.abs();
price.isZero();                                        // compared at currency rounding (Odoo float_is_zero)
price.equals(other);                                   // at currency rounding; equalsExactly() for raw comparison
price.compare(other);                                  // -1 | 0 | 1, at currency rounding
price.allocate(['1', '1', '1']);                       // [Money, Money, Money], summing exactly to price.round() (§7.6)
price.toDecimal();                                     // Decimal
price.toJSON();                                        // { amount: '85000.00', currency: 'BDT' }
price.format(env.lang);                                // '৳85,000.00' (locale from res.lang)

usd.money('10').plus(bdt.money('10'));                 // ❌ runtime CurrencyMismatchError:
// "Cannot add USD 10.00 and BDT 10.00. Convert one amount first: await env.fx.convert(amount, bdt, { date }),
//  and use the date of the document (invoice date / accounting date), not today."
price.plus(new Decimal('1'));                          // ❌ compile error: Decimal is not Money
```

`RecordSet.sum('amountTotal')` (RFC 0004) returns `Money`. It throws `CurrencyMismatchError` if the records' currencies differ,
and the error message suggests `groupBy('currency')`. For an empty recordset, `sum` needs a currency:
`orders.sum('amountTotal', { currency: env.company.currency })`. Otherwise the result is `Money.zeroOf(model's currency field)`
when it can be resolved, or a typed error.

**Monetary fields and records.** Reading a monetary field builds `Money` from the stored `numeric` and the record's currency
field. That's why RFC 0004 `Default<M>` always loads the currency many2one, together with currency attributes from the cache.
Assigning or writing `Money` checks that its currency equals the record's currency field. If it doesn't, the write throws.
Writing a `Decimal | string` takes the record's currency.

### 7.4 Quantities and units of measure

```ts
const unit = env.uom('uom.product_uom_unit');           // category 'Unit', ratio 1, rounding '1'
const dozen = env.uom('uom.product_uom_dozen');         // category 'Unit', ratio 12, rounding '1'
const q = Quantity.of('3', dozen);
q.to(unit);                                             // Quantity 36 units
q.plus(Quantity.of('6', unit));                         // ❌ UomMismatchError: "Convert first: q.to(unit)"
q.to(env.uom('uom.product_uom_kgm'));                   // ❌ IncompatibleUomCategoryError (Unit vs Weight)
Quantity.of('0.3', unit).round('up');                   // 1 unit: procurement rounds up to the UoM rounding
Quantity.of('0.3', unit).round();                       // 0 units: half-up by default
line.priceUnit.times(line.quantity.value);              // Quantity → Decimal is explicit (.value) for pricing
```

`f.quantity({ uom: 'uom' })` (RFC 0001) reads as `Quantity`. `Quantity × price-per-uom` stays an explicit operation,
because the price's uom must match. `product.priceFor(qty)` helpers live in the product module.

### 7.5 Named precisions

```ts
// modules/product/module.ts
precisions: {
  'product.price':    precision({ default: 2, max: 6, label: 'Product Price' }),
  'discount':         precision({ default: 2, max: 4 }),
  'stock.weight':     precision({ default: 2, max: 6 }),
  'product.uom.qty':  precision({ default: 3, max: 6 }),
}
```

- The column is created as `numeric(precision=20 + max, scale=max)`. Changing the configured value at runtime (a setting in
  the database, editable by an admin) never requires DDL.
- On write, values are rounded to the **configured** scale (`half-up`). On read, the stored value comes back unchanged.
- Raising `max` later is a migration. Lowering it is rejected if existing data would be truncated.

### 7.6 Allocation (no lost cents)

`Money.allocate(ratios)` uses the **largest remainder method** at the currency's rounding unit:

1. Compute each share = `total × ratioᵢ / Σratios`, then round each share **down** to the rounding unit.
2. Distribute the remaining units one by one to the shares with the largest remainders. Ties go to the earliest index,
   so the result is deterministic.
3. **Invariant** (property-tested): `Σ shares == total.round()` exactly, and each share is within one unit of its exact value.

Example: 1000.00 BDT over three installments → `[333.34, 333.33, 333.33]`.

### 7.7 Multi-currency and conversion

```ts
// account.move post: compute company-currency amounts for each line on the invoice's accounting date
const rates = await env.fx.prepare({ company: move.company, date: move.date, currencies: [move.currency] });   // 1 query
for (const line of move.lines) {
  const conv = rates.convert(line.amountCurrency, move.company.currency);       // sync after prepare
  await line.write({ debit: conv.amount.isPositive() ? conv.amount : '0', credit: conv.amount.isNegative() ? conv.amount.abs() : '0' });
  // conv.rate, conv.rateDate are available for audit/exchange-difference entries
}

await env.fx.convert(usd.money('120'), bdt, { date: invoice.invoiceDate });     // one-off, async
await env.fx.convert(usd.money('120'), bdt);                                     // ❌ compile error: `date` is required
```

- Rates live in `res.currency.rate`: `(company | null, currency, date, rate numeric(28, 14))`. `rate` is units of the currency per
  one unit of the company currency, as in Odoo, so the company currency's rate is 1. Company-specific rates take precedence
  over global ones (`company IS NULL`).
- Lookup takes the **latest rate on or before the date**:
  `SELECT DISTINCT ON (currency_id) … WHERE date <= $date ORDER BY currency_id, company_id NULLS LAST, date DESC`.
  It's batched for many currencies and dates with `unnest` + `LATERAL`.
- **No rate found** throws `MissingRateError`, naming the currency, date and company and explaining how to add a rate. There's
  no silent fallback to 1.
- Formula: `amount × rate(to) / rate(from)`, computed unrounded, then rounded once to the target currency (`.round()` is applied
  by `convert` unless `{ round: false }`).
- **SQL-side conversion** for reports: `sql.fx(amountExpr, fromCurrencyExpr, toCurrencyId, dateExpr, companyId)` expands to a
  `LATERAL` rate lookup, so domain and builder aggregates can convert inside PostgreSQL. RFC 0005's monetary aggregation then
  groups by the *target* currency.

### 7.8 Tax rounding (illustrating R6)

Invoice with three lines of 10.03 BDT each and 15% VAT:

| Policy | Calculation | Tax |
| ------ | ----------- | --- |
| Per line | `round(10.03 × 0.15) = round(1.5045) = 1.50`, × 3 | **4.50** |
| Global | `round(30.09 × 0.15) = round(4.5135)` | **4.51** |

- The company setting `taxRounding: 'perLine' | 'global'` selects the policy.
- With `global`, the tax engine computes unrounded line taxes, rounds the total once, and assigns the difference to lines
  using `allocate` (§7.6), weighted by line tax. That way `Σ line.taxAmount == move.amountTax` holds exactly, for both policies.
- That equality is property-tested with fast-check over random lines, prices, discounts and tax rates.

### 7.9 Storage, driver and serialization

| Layer | Representation |
| ----- | -------------- |
| PostgreSQL | `numeric(p, s)` for decimal and quantity with named precision. `numeric` (unconstrained scale) for monetary, because the currency varies per row, and the ORM rounds on write (fixes W4). An optional `CHECK (scale(amount) <= 3)` guard can be enabled per model. |
| Driver | `numeric` (OID 1700) is parsed into `Decimal` with Shutro's constructor. Parameters are sent as strings with the `::numeric` type. Never `parseFloat`. |
| Aggregates | `sum` / `avg` on `numeric` columns are exact in PostgreSQL. `avg` returns `Decimal` unrounded, so the caller rounds explicitly. |
| JSON (API / Kosh) | `{ "amount": "85000.00", "currency": "BDT" }`, and quantities as `{ "value": "3", "uom": "Dozens" }`. Decimal strings keep exact trailing zeros. |
| UI formatting | `money.format(lang)` uses `res.lang` separators. The Kosh client gets the same rounding rules from the metadata API (fixes W5). |

### 7.10 Performance notes

- decimal.js allocates objects, so hot loops (e.g. recomputing 1M stock valuation lines) should use SQL-side aggregation
  (RFC 0005) or batch APIs. A Phase 1 benchmark compares decimal.js with big.js for Shutro's operations, but `CLAUDE.md`
  fixes decimal.js unless an RFC changes that.
- Currency attributes come from the transaction cache, so `Money` construction doesn't touch the database.

---

## 8. Type-level guarantees

```ts
price.plus(new Decimal(1));                 // ❌ Decimal not assignable to Money
qty.plus(price);                            // ❌ Money not assignable to Quantity
order.write({ amountUntaxed: 100.5 });      // ❌ (also computed) number not assignable
line.write({ priceUnit: 0.1 });             // ❌ number not assignable to Decimal | string
env.fx.convert(m, bdt);                     // ❌ missing 'date'
expectTypeOf(order.amountTotal).toEqualTypeOf<Money>();
expectTypeOf(line.quantity).toEqualTypeOf<Quantity>();
expectTypeOf(line.priceUnit).toEqualTypeOf<Decimal>();
```

Runtime guarantees (always checked): same-currency arithmetic, same-UoM arithmetic, integer-only `number` inputs, rates present
for conversions, and writes matching the record's currency.

---

## 9. Runtime metadata

- `registry.describe(model).fields.amountTotal`: `{ kind: 'monetary', currencyField: 'currency' }`.
  `describePrecisions()` returns configured and max scales.
- Currencies are exposed to Kosh with `decimalPlaces`, `rounding`, `roundingMethod`, `symbol` and `position`, so client-side
  formatting and rounding match the server.

---

## 10. Interactions

- **0001:** the `monetary`, `decimal` and `quantity` field faces, plus `scale: 'named.precision'`.
- **0003:** `env.fx` reads the env company. The date is always explicit. `env.today()` exists, but it's never used implicitly.
- **0004:** `sum()` returns `Money` and checks currency. `Default<M>` loads currency fields, and the currency attributes are cached per transaction.
- **0005:** monetary aggregation must group by currency. `sql.fx` handles SQL-side conversion. The driver parses `numeric` as `Decimal`.
- **Audit:** conversions used in posting record the rate and rate date on the move lines (fields owned by `account`).

---

## 11. Resolved questions

Resolved on 2026-10-14. The original questions are kept below for context.

| # | Resolution |
| - | ---------- |
| 1 | **Runtime currency checks in v1.** Static currency tagging is a follow-up RFC after the runtime checks have been used in `erp-demo`. |
| 2 | **Monetary columns are unconstrained `numeric`, with ORM rounding on write.** A per-model `CHECK` is optional. |
| 3 | **The rounding method is configured per currency**, with `half-up` as the default. |

**Original questions:**

1. **Static currency tagging.** Generated types could tag `Money` with the *canonical currency field* (`Money<'sale.order:currency'>`),
   resolving `related` chains, so adding order and line amounts type-checks while adding an order amount to a journal item's
   company-currency amount is a compile error. This is powerful but complex. Should it be v1, or a follow-up after the runtime checks
   have proven themselves?
2. **Monetary column scale.** Unconstrained `numeric` plus ORM rounding (proposed) vs `numeric(20, 3)`, which fits every ISO
   currency except a few with 4 decimals (CLF, UYW). Which do you prefer?
3. **Default rounding method.** `half-up` (Odoo's default and common accounting practice) vs `half-even`. Should it be configurable per
   currency (proposed) or per company?

## 12. Deferred

- Tax engine API (`account.tax.computeAll`): account module design.
- Exchange-difference and revaluation entries: account module design.
- Cash rounding on payments (invoice cash-rounding lines): account module.
- Crypto and other high-precision assets: out of scope unless an ERP use case appears.

## Implementation notes (2026-10-15, conversion)

`env.fx` (`packages/core/src/money/fx.ts`) implements §7.6: `convert(money, to, { date, company?, round? })` and
`prepare({ date, currencies, company? })` with a synchronous `convert` / `rate`. Rates come from a `res.currency.rate`
model the application defines (fields `currency`, `company` optional, `date`, `rate`); one `DISTINCT ON` query per
prepare takes the latest rate on or before the date, company rows before shared rows. The company currency's rate is 1
when no row exists. Results are `Conversion { money, from, to, rate, rateDate }`. `MissingRateError` names the currency,
date and company. `sql.fx` (SQL-side conversion) is not implemented yet.
