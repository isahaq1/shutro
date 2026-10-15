# erp-demo

Partner, product, sale and invoice modules built entirely on Shutro's public API.

```
modules/
  base/      users, companies, currencies with dated rates, base.user / base.admin groups
  partner/   res.partner — archivable, shared or per company, email constraint, tracked
  product/   uom.uom, account.tax, product.product — translated names, numbered codes
  sale/      sale.order / sale.order.line — numbered SO/{year}/, computed amounts, onchange from partner and
             product, guarded workflow, salespeople see their own orders, managers see all
  invoice/   account.move / account.move.line — gapless INV/{year}/{month}/ on posting, totals in the company
             currency at the invoice date's rate; extends sale.order with invoices and createInvoices()
app/
  registry.ts   the installed modules
  types.ts      schema aliases for compute / onchange bodies (see docs/feedback.md #1, #2)
  seed.ts       demo data, including a 500-product COPY import
test/
  erp.integration.test.ts   the whole flow on PostgreSQL
```

What the scenario test covers, in order: the schema from `@shutro/migrate` (and an empty plan afterwards); a
quotation built with onchange (partner → currency, product → name, price, tax); creation with nested lines, sequence
numbering and computed totals; the confirm guard; record rules between two salespeople, a manager and an accountant;
invoicing confirmed orders from another module; posting with gapless numbering; the company-currency total at a
dated rate; the audit trail of the workflow; translated product names in a Bengali session; and the query
inspector confirming no N+1 pattern anywhere.

```
pnpm vitest run examples/erp-demo          # needs Docker for the PostgreSQL container
SHUTRO_DATABASE_URL=postgres://... pnpm exec shutro inspect sale.order --config examples/erp-demo/shutro.config.ts
```

The pain points met while building it are in [docs/feedback.md](../../docs/feedback.md).
