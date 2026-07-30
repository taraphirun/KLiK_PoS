# Known Bugs Backlog

Bugs discovered incidentally while working through `implementation_plan.md` that are out of
scope for the todo that surfaced them. Not part of the phased todo numbering — pick these up
whenever, independent of phase order.

---

## BUG-001: `custom_delivery_date` is set on Sales Invoice but the field doesn't exist

**Status:** ⬜ Not started
**Found:** 2026-07-30, while doing Todo 020 (Sales Invoice reconciled delivery fields) — checking
for `custom_delivery_*` field-name collisions per that todo's Risks section.

### Description
`klik_pos/api/sales_invoice.py` sets `doc.custom_delivery_date = frappe.utils.nowdate()` (and
copies it between rebuilt docs) in at least four places:
- line ~1913
- line ~2043 (`invoice_doc.custom_delivery_date = rebuilt_doc.custom_delivery_date`)
- line ~3749
- line ~3996 (`invoice_doc.custom_delivery_date = rebuilt_doc.custom_delivery_date`)

But `custom_delivery_date` is **not a real field** — confirmed via `bench console`:
- `frappe.db.has_column("Sales Invoice", "custom_delivery_date")` → `False`
- `frappe.db.exists("Custom Field", "Sales Invoice-custom_delivery_date")` → `None`

It's also not defined in `klik_pos/klik_pos/custom/sales_invoice.json` or anywhere in
`setup/install.py`. It's not a standard ERPNext Sales Invoice field either (checked
`erpnext/accounts/doctype/sales_invoice/sales_invoice.json` — no `delivery_date` field there).

### Why it doesn't error (and why it's easy to miss)
Assigning `doc.custom_delivery_date = ...` on a Frappe `Document` just sets an arbitrary Python
attribute — Frappe doesn't validate that against the doctype's field list at assignment time. It
silently never gets persisted on `insert()`/`save()` (not a DB column, so there's nothing to write
it to) and is silently dropped from serialization. No exception, no log — the value just
disappears after the request ends.

### Likely intent
Probably meant to track "date the invoice's items were delivered" alongside the existing
`custom_delivery_personnel` fields, but the corresponding Custom Field was apparently never
created (or was removed at some point without removing the code that sets it).

### Impact
Currently zero functional impact — nothing reads `custom_delivery_date` back anywhere (grepped;
only write sites exist), so this looks like dead/vestigial code rather than a live data-loss bug.
Worth confirming that before fixing, in case there's a reason it's write-only (e.g. a webhook or
downstream consumer expecting it in a response payload rather than the DB row).

### Suggested fix (when picked up)
Either:
1. Add a real `custom_delivery_date` (Date) Custom Field via the same
   `create_custom_field` + `after_install()` + patch pattern used elsewhere in `setup/install.py`
   (see `ensure_delivery_reconciliation_fields` for the current template), if the intent is still
   wanted — decide whether this should now instead be `custom_delivered_at` (Datetime, added in
   Todo 020) to avoid a second near-duplicate field, or
2. Remove the four dead assignments in `sales_invoice.py` if nothing actually needs them.

### Related
[Todo 020](todo/020.md) / [Phase 9](phases/phase-09.md) — the reconciled `custom_delivered_at`
field added there may make this field redundant once resolved either way.
