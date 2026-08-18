# klik_pos performance audit — findings

**Date:** 2026-08-18
**Method:** static review of the hot read paths + `EXPLAIN`/index inspection on
`hd.phirun.me`.
**Headline:** nothing is a problem at the current data volume (**176 Sales Invoices**). The
items below are forward-looking — they bite as the invoice table grows, not today.

---

## 1. Frontend auto-loads up to 10 pages serially on every filter — Medium (UX/load)

**Location:** `klik_spa/src/hooks/useSalesInvoices.ts:207-221`.

When `total_count <= 1000`, the hook fires up to **10 sequential** `get_sales_invoices`
requests (100 invoices each), one awaiting the next, and re-runs the whole sweep whenever the
debounced search term changes. Each request re-runs the count query and the batched sub-fetches
(items, payments, cashier names). At a few hundred invoices this is a visible multi-second
spinner on the Invoice History / Dashboard pages; at the 1000-row ceiling it is 10 serialized
round-trips per keystroke-settled search.

**Fix direction:** paginate on demand (load-more / infinite scroll) instead of pre-loading all
pages, or parallelize the page fetches, or push the filtering the client is trying to satisfy
into the server query so the client doesn't need the whole set in memory.

## 2. POS filter columns are unindexed — Low now, Medium past ~5-10k invoices

**Location:** `klik_pos/api/sales_invoice.py:661-705` (`get_sales_invoices` WHERE/ORDER BY).

The non-admin query filters on `custom_pos_opening_entry` and `pos_profile` and orders by
`modified`. `EXPLAIN` on the current DB shows `type=ALL` (full scan) + `Using filesort`, and
none of `custom_pos_opening_entry`, `pos_profile`, `outstanding_amount`, or `modified` are
indexed. At 176 rows this is instant and irrelevant. It becomes the dominant cost once the
table reaches several thousand invoices.

**Fix direction:** when volume warrants, add indexes on `custom_pos_opening_entry` and
`pos_profile` (and rely on Frappe's default `modified` index — confirm it exists). Do this as a
migration/patch, not by hand-editing core.

## 3. Very large single modules — maintainability, not runtime

`klik_pos/api/sales_invoice.py` (134K) and `delivery.py` (83K) are large enough to slow human
review and raise merge/drift risk against upstream. No runtime penalty; noted because the
accounting audit had to reason across a 4000-line file, which is itself a correctness risk.

---

## Positive notes (checked, fine)

- `get_sales_invoices` post-query enrichment is **batched** (`_batch_fetch_cashier_names` /
  `_batch_fetch_payment_methods` / `_batch_fetch_items` use `IN (...)` clauses) — no N+1.
- The count and main queries are parameterized and paginated (`LIMIT/OFFSET`).

## What changed in the repo

Nothing. Report only.
