# Phase 8: Custom Print Format & Status Indicators
**Module 1**

**Status:** ✅ Done

## Objective
Create a comprehensive print format for POS invoices displaying custom fields, payment breakdown, and status indicators.

## Scope note (2026-07-30)
Checked first: a print format named **`DS POS Invoice KLiK`** (`doc_type: Sales Invoice`, Jinja
type, module `KLiK PoS`) already existed **in the site database**, built directly in the Desk UI at
some point, and already covered most of the spec — payment breakdown (`Payment Details` section)
and status indicators (color-coded PAID/PARTLY PAID/UNPAID, driven by ERPNext's own native
`doc.status`). It was never exported to the repo though, so it existed only in this one site's DB —
a fresh site/migration would silently lose it. Genuinely missing: `custom_description` (the Khmer
roofing-sheet line note from Module 9) wasn't shown anywhere, and there was no customer credit info.

Actual work done:
- Exported the existing print format into git via `bench export-doc` so it's finally tracked
  (`klik_pos/klik_pos/print_format/ds_pos_invoice_klik/ds_pos_invoice_klik.json`).
- Added `item.custom_description` under each line item (same file).
- Added a customer credit info block (Credit Limit / Credit Used / Available), shown only when the
  customer has a credit limit set. Backed by a new `get_customer_credit_summary()` jinja method
  (`klik_pos/klik_pos/utils.py`), registered via `hooks.py`'s previously-unused `jinja.methods`
  scaffold. It reuses the same `_get_customer_credit_info()` source as the Phase 4 credit-limit
  check, so the printed numbers always agree with what's enforced on submit.
- Verified rendering via `bench console` (`frappe.get_print`) against real invoices: a walk-in
  customer (no credit limit — section correctly hidden), a credit customer with `credit_limit=100`
  (section renders with correct figures), and an in-memory item with `custom_description` set
  (renders correctly, doesn't error when blank).

## Known follow-up (not done, flagged for the user)
This print format is not currently wired as the *default* anywhere — the `Phirun` POS Profile's
`print_format` field is empty, so nothing currently forces its use at print time. Left alone
pending the user's decision (setting a live profile's print default is an operational choice, not
a code fix).

## Todos
- [x] [018.md](../todo/018.md): Create backend custom print format JSON
