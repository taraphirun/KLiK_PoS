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

## Follow-up 1: wired as the default (2026-07-30)
Flagged that the print format wasn't set as a default anywhere; user asked to set it now. Set
`Phirun` POS Profile's native `print_format` field to `DS POS Invoice KLiK` (drives the klik_spa
print/print-preview flow). Verified working in the browser (print + print preview).

## Follow-up 2: Telegram sending used a different print format entirely (2026-07-30)
User reported print/preview worked but "send to Telegram" didn't use the same template. Root
cause: `erpnext_telegram_integration`'s `send_document_to_telegram` picks its print format via its
own `get_pos_print_format()`, which reads a *different* field —
`POS Profile.custom_pos_printformat` — not the native `print_format` field klik_spa uses. That
field doesn't exist as a real column in this site (`custom_pos_printformat` — unknown column); the
telegram app references it in code but never ships a fixture/custom field for it, so it always hit
the except branch and silently fell back to Frappe's generic `Standard` print format.

Fixed on the klik_pos side (since klik_pos already owns other custom fields on POS Profile):
- Added `ensure_pos_print_format_field()` in `klik_pos/setup/install.py` (Link field to Print
  Format, `insert_after: print_format`), wired into `after_install()` for fresh installs, plus a
  new patch (`patches/v16_0/add_pos_print_format_field.py`) for this and future existing sites.
- Ran `bench migrate` to create the field on this site, then set `Phirun`'s
  `custom_pos_printformat` to `DS POS Invoice KLiK`.
- Verified via `bench console`: `get_pos_print_format()` now resolves to `DS POS Invoice KLiK`
  (was silently `Standard` before), and `generate_invoice_pdf()` produces a real PDF using it.

## Todos
- [x] [018.md](../todo/018.md): Create backend custom print format JSON
