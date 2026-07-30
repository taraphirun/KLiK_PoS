# Known Bugs & Follow-up Tasks Backlog

Bugs discovered incidentally while working through `implementation_plan.md` (out of scope for the
todo that surfaced them), plus standalone follow-up tasks that don't fit the phased todo numbering.
Pick these up whenever, independent of phase order.

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

---

## BUG-002: `custom_invoice_ref` on Sales Invoice is an Int column (not text) and defaults to 0

**Status:** ⬜ Not started
**Found:** 2026-07-30, while doing Todo 022 (Delivery Report auto-match) — writing invoice-number
matching against `custom_invoice_ref` ("physical receipt/invoice number", Module 6 spec) exposed
this the hard way: a garbage test input (`"ZZZZZZZZZZZZZZZZZZZZ"`) falsely "exact matched" a real
invoice.

### Description
`custom_invoice_ref` (label "Invoice Ref") is a **Custom Field**, `fieldtype: Int`, DB column
`int(11) NOT NULL DEFAULT 0` — confirmed via `bench console`
(`frappe.db.get_value("Custom Field", "Sales Invoice-custom_invoice_ref", ["fieldtype","label"])`
→ `{'fieldtype': 'Int', 'label': 'Invoice Ref'}`; `describe tabSales Invoice` →
`('custom_invoice_ref', 'int(11)', 'NO', '', '0', '')`). Every invoice that has never had a ref
set carries the literal value `0`, not `NULL`/empty.

It's also **DB-only** — not present in `klik_pos/klik_pos/custom/sales_invoice.json` — the same
"customization created directly on the site, never exported to the repo" gap as the Phase 8 print
format bug, so a fresh site/migration silently loses this field entirely.

### Why it's dangerous
Any code that filters/compares `custom_invoice_ref` against a string via `frappe.db.get_value`,
`frappe.db.exists`, or a dict-filter query lets MySQL's implicit type coercion convert a
non-numeric string to `0` for the comparison — which then matches **every** invoice still at the
untouched default. Concretely: `frappe.db.get_value("Sales Invoice", {"custom_invoice_ref":
"any-non-numeric-string"}, "name")` returns the first invoice with `custom_invoice_ref = 0`,
not `None` as you'd expect from "no such ref exists."

`klik_pos/api/delivery.py`'s `match_delivery_report` hit exactly this in its first draft and was
fixed there (only queries `custom_invoice_ref` when the reported value parses as a non-zero int,
see `_safe_nonzero_int`) — but this same landmine is waiting for **any other/future code** that
queries this field with a string filter without the same guard.

### Likely intent
"Invoice Ref" suggests a free-text physical receipt/invoice number a cashier types in
(`custom_invoice_ref` is read from the POS payload in `sales_invoice.py`, see Module 8's
`custom_invoice_ref` input field) — which argues it should probably be `Data`, not `Int`. Whether
receipt numbers are always numeric in this business in practice is unconfirmed.

### Suggested fix (when picked up)
1. Export the existing Custom Field to `klik_pos/klik_pos/custom/sales_invoice.json` so it
   survives a fresh install (same fix pattern as the Phase 8 print format).
2. Decide whether `Int` is actually correct (all physical receipt numbers are numeric — fine as
   is, just needs the export) or whether it should be migrated to `Data` (if letters/leading
   zeros/mixed formats are possible) — check with the user/real usage data before changing the
   type, since that's a schema migration on a field already holding live data.
3. Regardless of (2): audit any other place that filters this field by a string and add the same
   non-zero-int guard used in `match_delivery_report`.

### Related
[Todo 022](todo/022.md) / [Phase 9](phases/phase-09.md) — where this was found and worked around.

---

## TASK-001: Integrate the Telegram delivery bot with the Module 10 endpoints

**Status:** ⬜ Not started
**Added:** 2026-07-30, after Phase 9 (Module 10, Todos 019–024) was implemented and
backend-verified. User confirmed the reconciliation UI looks fine but has **not yet connected the
actual bot** (`hd-delivery-telegram`) — everything tested so far used synthetic payloads via
`bench console`/`bench execute`, not a real bot submission.

### What's already done (KlikPOS side — Phase 9, complete)
- `Delivery Report` staging DocType (Todo 019).
- Reconciled delivery fields on Sales Invoice (Todo 020).
- Ingestion endpoint `klik_pos.api.delivery.submit_delivery_report` (Todo 021).
- Invoice-number auto-match (exact/normalized/fuzzy) (Todo 022).
- Reconciliation endpoints: `confirm_delivery_match`, `reject_delivery_match`,
  `rematch_delivery_report` (Todo 023).
- Frontend queue at `/deliveries/reconcile` (Todo 024) — visually confirmed working by the user,
  but only against manually-submitted test data.

### What's still needed (bot side — not part of this repo)
- Point `hd-delivery-telegram`'s delivery-submission code at
  `POST /api/method/klik_pos.api.delivery.submit_delivery_report`, sending the exact payload
  shape `submit_delivery_report` expects: `bot_delivery_id`, `reported_invoice_no`,
  `completion_status` (`Full`/`Partial`), `payment_status` (`Paid`/`Unpaid`/`Partial`),
  `delivery_driver`, `driver_telegram_id`, `delivery_timestamp`, `gps_latitude`/`gps_longitude`.
  (`photos`/`voice_note` file upload is Phase 13 scope, not required for a first connection.)
- Create a **dedicated Frappe user + API key/secret** for the bot to authenticate as (the endpoint
  is deliberately not `allow_guest` — see Todo 021 notes) with create-permission on
  `Delivery Report` (currently System Manager only — either grant that role to the bot user or add
  a narrower role with just this permission).
- Confirm the bot's `delivery_timestamp` format parses cleanly via `frappe.utils.get_datetime`
  (ISO 8601 or `YYYY-MM-DD HH:MM:SS` both work; verify what the bot actually sends).
- End-to-end real test once wired up: submit a real delivery from the bot, confirm it lands in the
  `/deliveries/reconcile` queue with a sensible auto-match, then walk through Confirm/Reject/
  Re-match against it.

### Risks
- The bot repo (`hd-delivery-telegram`) is a separate codebase — this task is 100% bot-side wiring
  plus a one-time Frappe user/API-key setup on the KlikPOS side, no further KlikPOS code changes
  expected unless the real payload shape turns up a mismatch with what `submit_delivery_report`
  currently validates.
- If the bot's actual timestamp/GPS field names differ from what's assumed above, either adjust
  the bot's outgoing payload to match, or (if the bot's shape can't change) adapt
  `submit_delivery_report`'s field mapping — don't silently rename fields on one side without
  checking the other.

### Related
[Phase 9](phases/phase-09.md) (system boundary: "bot collects, KlikPOS confirms") / [Todo 021](todo/021.md).
