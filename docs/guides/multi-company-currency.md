# Multi-company and multi-currency

## Companies

Every environment carries a current company and the allowed companies ([RFC 0003](../rfcs/0003-environment-and-transaction-context.md)):

```ts
await shutro.run({ user, company: 1, companies: [1, 2] }, async (env) => {
  env.companyId;                       // 1
  env.companyIds;                      // [1, 2]
  const sg = env.withCompany(2);       // must be allowed (CompanyNotAllowedError otherwise, unless su)
});
```

A `companyScoped` model gets a `company` field (required or optional) that defaults to `env.companyId` on `create()`.
`search()` only returns records of the allowed companies; optional scopes also return **shared** records
(`company IS NULL`).

### Cross-company links

```ts
export const SaleOrder = defineModel('sale.order', {
  companyScoped: { required: true },
  fields: { partner: f.many2one('res.partner', { required: true, checkCompany: true }) },
});
```

`checkCompany` on a many2one (the model and the target must both be companyScoped) synthesizes a `companyConsistency`
constraint: at the flush point, every record whose `company` or checked field changed must reference a **shared**
target or a target of its **own company**; otherwise `CrossCompanyError` lists the offending records with both
companies. A superuser can relax it with `withFlags({ checkCompany: false })`, which also disables the search filter.

## Currencies

Monetary fields carry a currency; arithmetic across currencies is a runtime error ([RFC 0006](../rfcs/0006-money-decimals-and-currency.md)).
Conversion is explicit and **dated**:

```ts
const conv = await env.fx.convert(usd100, bdt, { date: invoice.date });     // company = env.companyId
conv.money;      // BDT 10000.00 (rounded to BDT)
conv.rate;       // 100 — target units per source unit
conv.rateDate;   // '2026-01-01' — the rate row used (null for same-currency)

const rates = await env.fx.prepare({ date: move.date, currencies: [usd, eur], company: move.company });  // one query
for (const line of lines) rates.convert(line.amountCurrency, companyCurrency);                          // sync
```

- Rates come from a `res.currency.rate` model your base module defines with `currency`, `company` (optional),
  `date` and `rate` (units of the currency per one unit of the company currency, so the company currency's rate is 1).
- A lookup takes the latest rate **on or before** the date; a company's own rows win over shared rows (`company IS NULL`).
- No rate on or before the date is a `MissingRateError` naming the currency, date and company. There is no silent
  fallback to today's rate.
- `{ round: false }` keeps the full precision (unit prices, rates).

SQL-side conversion (`sql.fx`) for reports is not implemented yet.

## Company-dependent fields

One value per company (Odoo `company_dependent`): a product's cost, a partner's receivable account.

```ts
cost: f.decimal({ scale: 2, companyDependent: true, default: '0' }),
incomeAccount: f.many2one('account.account', { companyDependent: true }),
```

- The column is a JSONB map `{ "<companyId>": value }`. Reads, writes, filters and sorts use the current company's
  value; companies without one read the `default`. Write another company's value through `env.withCompany(c)`.
- Not required, computed, translated, encrypted or numbered. Kinds: char, text, html, integer, float, decimal,
  boolean, date, selection, many2one. A company-dependent many2one has no database foreign key; the ORM checks the
  written ids. Grouping by one in `aggregate()` is not supported.
