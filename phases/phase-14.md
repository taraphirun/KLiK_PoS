# Phase 14: Backfill Invoice Creation from Reconciliation
**Module 15**

**Status:** ✅ Done (backend verified live against the real KlikPOS site; frontend build/typecheck
clean, not yet browser-checked — see todo/038.md notes)

## Objective
During the paper → ERPNext transition, a delivery can be reported (by driver/bot, or written up
by staff from a paper slip) for an invoice that was never entered into KlikPOS at all — there is
no Sales Invoice to match against, so `Delivery Report.reconciliation_status` stays `Unmatched`
forever and `confirm_delivery_match` has nothing to confirm against (it hard-throws if
`matched_invoice` doesn't exist). Let staff create the missing Sales Invoice directly from the
Reconciliation page, in a fast table/form entry, instead of switching to the full POS screen.

## Context — why this needs its own phase, not just a UI button
`Delivery Report` carries no customer and no line items (only `reported_invoice_no` free text,
driver, GPS, photos, `amount_collected` — see Module 10). The paper invoice's customer and items
only exist on the physical slip, so the reconciliation UI has to collect them, not just display
them. This intersects the existing POS checkout engine
(`klik_pos/api/sales_invoice.py::queue_sales_invoice` → `build_sales_invoice_doc`) which already
owns tax calc, stock reservation, batch/serial, and payment posting — the design goal is to reuse
that path for backfilled invoices too, not fork a second invoice-creation implementation.

## Decisions (made with the user, 2026-08-01)
- **Posting date**: defaults to the Delivery Report's `delivery_timestamp` (so stock ledger and
  financial reports reflect when the delivery actually happened during the transition window),
  editable by staff before submit. Requires a new optional `posting_date` passthrough in the
  invoice-creation call chain — today `_set_posting_fields` hard-codes `nowdate()`. Normal POS
  checkout never sends this field, so its behavior is unchanged.
- **Stock impact**: backfilled invoices deduct stock normally, same as any Sales Invoice — no
  bypass. (If pre-transition opening stock later turns out to be inaccurate because of this,
  that's a separate stock-reconciliation problem, not something this feature should silently
  paper over.)
- **Customer**: reuse the existing `CustomerSearchSection` + `AddCustomerModal` as-is — it already
  supports "create as new customer?" inline (gated by the POS Profile's
  `custom_allow_to_create_and_edit_customers` flag), covering paper customers not yet in ERPNext
  without any new backend work.
- **POS session requirement**: creating a backfill invoice still requires an active POS Opening
  Entry, same as normal checkout. This means the reconciliation page inherits the existing
  POS-Profile-bound pricing/tax/warehouse resolution (`_get_active_pos_profile`) unchanged — no
  new session-less invoice-creation code path.

## Todos
- [x] [038.md](../todo/038.md): `posting_date` passthrough + `create_invoice_from_delivery_report`
  backend endpoint + reconciliation-page quick-create modal
- [x] [039.md](../todo/039.md): Payment status (Paid/Partial/Unpaid) + due date on backfill
  invoice creation - avoids tripping the credit-limit check on every backfill
- [x] [040.md](../todo/040.md): Delivery photo viewer (thumbnail strip + zoomable lightbox) - the
  gap that made 038 hard to use in practice ("how do I know what to enter without seeing the
  photo")

## Non-goals
- Not a general-purpose "create invoice anywhere" screen — scoped to the reconciliation page's
  Unmatched-row action only.
- Not a bypass of stock/tax/payment validation — reuses `queue_sales_invoice` unchanged apart from
  the new optional `posting_date`.
- Does not change `match_delivery_report`'s auto-match logic — this only adds an escape hatch for
  when auto-match (correctly) finds nothing because the invoice never existed.
