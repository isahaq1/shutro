# RFC 0016: Aggregates and amount helpers

- **Status:** Implemented
- **Related:** 0004 (recordsets), 0005 §7.4 (domains), 0006 (money), 0014 (security), feedback #9, #10, #12, #13, #14

## 1. Summary

`env.model(M).aggregate({ where, groupBy, measures, order, limit })` returns grouped totals in one `GROUP BY`
statement, with every guarantee of `search`. `records.sum(key)` totals a loaded numeric field. `browse(ids)` is a
full recordset (write, unlink, methods) without a load. Prepared FX rates convert by currency id. Child onchange
handlers run inside the parent draft.

## 2. Problem

Reports dropped to `env.sql`, which skips ACL, field groups and record rules (feedback #13); every total compute
re-implemented a fold (feedback #12).

## 3. How Odoo does it

`read_group(domain, fields, groupby, lazy=True)` with `field:agg` specs and `date:month` granularity. Weaknesses:
untyped results (`__count`, `field_count`, `__domain` keys), monetary sums across currencies unless the caller groups
by `currency_id`, record rules applied but field groups only partly, `lazy` grouping that surprises callers.

## 4. Decision

- **Groups:** stored char, selection, state, boolean, integer, date and many2one fields; `date` / `datetime` with
  `:day | :week | :month | :quarter | :year`. Datetimes are bucketed in `env.tz`. Translated fields are refused.
- **Measures:** named; `'count'` or `{ sum | avg | min | max: field }` over integer, float, decimal and monetary
  fields. `sum` is `coalesce(sum(x), 0)`; `avg` / `min` / `max` may be `null`.
- **Money:** each monetary measure is also grouped by its currency field, so a row's total is one `Money` in one
  currency; several currencies give several rows.
- **Security:** read ACL; field groups on every grouped, measured, filtered field; record rules and company scope;
  relation paths with the targets' rules (RFC 0014 §7.8). Everything pending is flushed first.
- **Types:** `AggregateRow<S, M, G, Ms>` has the group keys as given (`'dateOrder:month'`: string, many2one:
  `Id<Target> | null`) and the measures (`count`: number, monetary `sum`: `Money`, decimal `sum`: `Decimal`).
- **No `lazy`:** every listed group is in the `GROUP BY`; rows are flat.

## 5. Deferred

Grouping through relation paths (`'partner.country'`), `count_distinct`, `HAVING`, pivot shapes, and
translated-field grouping.
