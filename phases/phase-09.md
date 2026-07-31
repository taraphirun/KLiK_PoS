# Phase 9: Delivery Tracking & Payment Reconciliation (Telegram Delivery Bot)
**Module 10**

**Status:** ✅ Done (backend fully verified; frontend not yet checked in a live browser this session — see Todo 024 notes)

## Objective
Capture delivery outcomes reported by a Telegram delivery bot and reconcile them against
real Sales Invoices. Driver-reported data is **untrusted**, so it lands in a dedicated staging
DocType, is auto-matched to an invoice with a confidence score, and only writes back to the
invoice after a human confirms the match. On confirmation, if the driver reported payment was
collected at the delivery location, the system can mark the invoice paid automatically by
posting a Payment Entry.

This module does **not** use Sales Orders or Delivery Notes. Reporting needs are met by
switching the report's document type to Sales Invoice; delivery state lives in custom fields
owned by this reconciliation flow. It builds directly on Phase 1 (Module 6): unpaid/partial
invoices go out for delivery, the driver collects cash, and reconciliation posts the payment.

## System boundary — bot collects, KlikPOS confirms (decided)
The delivery bot (`/home/phirun/dev/hd-delivery-telegram`) collects delivery data through a
**structured Telegram (aiogram FSM) flow** — the driver enters the invoice number, picks
completion status and payment status (Paid/Unpaid/Partial), shares GPS via Telegram location, and
optionally attaches photos/voice. There is **no OCR/AI** in the current path (the older
Document AI / GenAI / ocr-service code is legacy and unused). Data is therefore already
structured but **driver-entered, so it can still be wrong** — which is exactly what KlikPOS
confirms.

| Job | Owner | Detail |
|---|---|---|
| **Collection** | **Bot** | aiogram FSM: invoice no, completion status, payment status, GPS, photos/voice. Driver self-registration. |
| **Matching + confirm + payment** | **KlikPOS (this module)** | Take the bot's structured record, match to a Sales Invoice, human confirm/re-match, mark paid. |

Consequences:
- **KlikPOS needs no OCR/AI.** Auto-match (Todo 022) is **structured-to-structured**
  (driver-entered invoice no / amount → Sales Invoice).
- **One-way data flow**: bot pushes → KlikPOS ingests → payment posts locally in Frappe. KlikPOS
  never exposes its invoice list to the bot.
- Because the collection is a thin structured flow (not a heavy AI pipeline), the bot's data layer
  is a candidate to move into Frappe entirely — see the full-consolidation note in
  `implementation_plan.md` (Module 11 discussion).

## Data captured from the bot (per delivery)
Exact fields from the bot's `delivery_logs` record (`hd-delivery-telegram/delivery-bot/bot.py`):
- `bot_delivery_id` (UUID) — idempotency key
- Invoice number (driver-typed — may be wrong)
- Completion status: **Full / Partial** ("All Delivered" / "Missing Product")
- Payment status: **Paid / Unpaid / Partial**
- GPS latitude/longitude (Telegram location share)
- Driver name + Telegram user id
- Delivery timestamp
- Photo file(s) and optional voice note (uploaded to Frappe File on sync)

## Architecture
```
Telegram Bot ──POST──▶ [Ingestion API] ──▶ [Delivery Report] (staging DocType)
                                                   │
                                            [Auto-match + confidence]
                                                   │
                              ┌────────────────────┴───────────────────┐
                        (high confidence)                        (low / no match)
                              │                                         │
                     suggested match                          flagged Unmatched
                              │                                         │
                              └──────────▶ [Reconciliation UI] ◀────────┘
                                                   │ human confirms / re-matches / rejects
                                                   ▼
                                   stamp delivery data onto Sales Invoice
                                   + (optional) post Payment Entry to mark paid
```

## Todos
- [x] [019.md](../todo/019.md): New `Delivery Report` staging DocType (bot data + reconciliation state)
- [x] [020.md](../todo/020.md): Custom fields on Sales Invoice for reconciled delivery data
- [x] [021.md](../todo/021.md): Bot ingestion API endpoint + payload validation
- [x] [022.md](../todo/022.md): Auto-match logic (exact → normalized → fuzzy invoice no) with confidence scoring — attribute/customer/amount matching dropped, see todo notes
- [x] [023.md](../todo/023.md): Reconciliation API (confirm / reject / re-match) + mark-as-paid automation
- [x] [024.md](../todo/024.md): Frontend reconciliation page

## Key design decisions
- **Staging over direct write**: bot data never touches a Sales Invoice until confirmed. This
  keeps the accounting ledger clean when driver input is wrong.
- **Reuse `create_payment_entry(sales_invoice, mode_of_payment, amount_paid)`** (already in
  `klik_pos/api/sales_invoice.py`) for the mark-as-paid step — do not hand-roll a new Payment
  Entry builder.
- **Auto-match is a suggestion, not an action**: a match only mutates the invoice after human
  confirmation, except optionally for high-confidence matches gated behind a POS Profile flag.
- **Idempotency**: re-sending the same bot report (same invoice + driver + timestamp) must not
  create duplicate Delivery Reports or double-post payments.

## Addendum (2026-07-31): multiple deliveries per invoice

Raised by the user while reviewing what was originally planned as Module 12 (now **dropped**, see
`phases/phase-11.md`): a single invoice can legitimately receive **more than one confirmed
Delivery Report** - a Partial delivery now, the remainder later. Module 12's planned "duplicate
`reported_invoice_no`" conflict view would have flagged that normal case as an error. This
addendum makes the existing reconciliation flow (Todo 023/024) handle it correctly instead of
building a separate conflicts screen for it.

**What was already safe:** payment posting (`create_payment_entry` in `confirm_delivery_match`)
always checks the invoice's *live* `outstanding_amount`, so a second confirm against a
partially-paid invoice can't over-allocate or double-charge - no change needed there.

**What was fixed** (`klik_pos/api/delivery.py`):
- `confirm_delivery_match` previously overwrote `custom_delivery_status` /
  `custom_delivery_driver` / `custom_delivered_at` / GPS / `custom_delivery_report` unconditionally
  on every confirm. Since the reconciliation queue sorts newest-bot-submission-first, staff could
  naturally confirm a later "Full" delivery before an earlier "Partial" one for the same invoice -
  which would silently regress the invoice back to "Partially Delivered" with stale driver/GPS
  data. Fixed with two guards, both decided with the user: `DELIVERY_STATUS_RANK` makes
  `custom_delivery_status` monotonic (never regress), and `_is_newer_or_first_delivery` only lets
  the snapshot fields move forward by `delivery_timestamp`, not by confirm order.
- `get_delivery_reports` now computes a `group_key` per row (`matched_invoice`, else
  `reported_invoice_no`) and, via one extra aggregate query, a cross-status `group_total_count` /
  `group_flagged` (flagged = more than one report for that invoice across ANY status, or contains
  a Partial delivery). Rows are sorted so flagged groups float to the top and stay adjacent -
  directly surfacing exactly the multi-delivery situations that need a human's attention, instead
  of a separate conflicts view.

**Frontend** (`DeliveryReconciliationPage.tsx`): reports are now rendered via `groupReports()` +
`GroupCluster` instead of a flat list - a flagged group renders as a bordered cluster with an
"Invoice X · N delivery reports" header; an unflagged singleton renders exactly as before (no
visual change). If a group has members outside the current status tab (e.g. an already-Confirmed
first delivery while viewing the Pending queue), a "show more" link fetches them on demand via the
same `get_delivery_reports` call across all statuses, reusing the existing endpoint rather than
adding a new one.

Verified via `bench execute` against real invoices: simulated a Partial delivery (confirmed,
posted a partial payment) followed by a Full delivery for the remainder (confirmed, posted the
rest), then confirmed a third, older-timestamped Partial report *after* the Full one to prove the
regression guards hold; separately verified `get_delivery_reports` groups/flags/sorts correctly
against a mix of a 3-report flagged group and an unrelated single-report control. All test data
cleaned up afterward. `npx tsc --noEmit` and `yarn build` both clean.
