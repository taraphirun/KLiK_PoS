# Phase 16: Daily Booklet Page Reconciliation
**Module 17**

**Status:** ✅ Done (backend fully verified live via bench console against hd.phirun.me; frontend
build/typecheck clean, not yet browser-checked - see todo/045-048.md)

## Objective
Module 16 (Phase 15) built the booklet *registry* (number ranges, VIP customers, Active/Stalled/
Ready-for-Review/Closed lifecycle) but its gap detection only checks Delivery Report numbers —
wrong for how this shop will actually use it. Real end-of-day workflow (from the user, 2026-08-02):

> I need to make sure I don't skip any page... I will input the data from the delivery at the end
> of the day and make sure all invoice numbers within the min and max of today's range are taken
> care of. Some invoice papers are void, self pick-up, or my driver forgot to do report.

Three concrete facts this changes about the design:
1. **POS invoices are created before fulfillment**, not after. A Sales Invoice existing with a
   given `custom_invoice_ref` is *not* proof the page is resolved — it might be paid for but not
   yet delivered or picked up. (The user explicitly rejected "invoice exists = resolved" for this
   reason.)
2. **Self-pickup is a real, distinct outcome**, not a delivery variant — needs its own explicit
   confirmation action, separate from the bot-driven delivery-confirm flow.
3. **Void pages** (written on paper, sale cancelled/never happened) need a marker that
   permanently clears them from the checklist, independent of any Sales Invoice.

## Data model additions

- **Sales Invoice `custom_delivery_status`** (existing Select field, `klik_pos/klik_pos/custom/
  sales_invoice.json`): add `Self Pickup` as a 5th option (today: `Pending / Delivered / Partially
  Delivered / Not Delivered`).
- **New: `Delivery Booklet Void Entry`** (child table on `Delivery Booklet`): `page_number` (Int),
  `reason` (Data, optional), `voided_by` (Link User, auto), `voided_at` (Datetime, auto). Lives on
  the booklet whose range covers the number — void marking auto-resolves which booklet via the
  same range lookup `match_booklet_for_invoice` already does.

## New/changed backend (`klik_pos/api/`)

- **`booklet.py::mark_page_void(page_number, reason=None)`** / **`unmark_page_void(page_number)`**
  — resolves the covering booklet automatically; throws a clear error if no booklet is registered
  for that range yet (booklet registration is a prerequisite, same as today's matching).
- **`delivery.py::set_manual_delivery_status(invoice_name, status)`** (`status` ∈
  `{"Delivered", "Self Pickup"}`) — the "I know what happened, no bot report needed" action. Guards
  against overriding an invoice that already has a Confirmed Delivery Report (throws, pointing at
  the normal reconciliation flow instead — this is deliberately a *lower-trust* manual path, not a
  replacement for real driver confirmations). Stamps `custom_delivered_at = now`, no
  driver/GPS/report (none exists for this path).
- **`delivery.py::create_invoice_for_unreported_page(page_number, invoice_data, payment_status,
  ...)`** — for a page number with *neither* an invoice nor a Delivery Report at all (truly
  forgotten end-to-end). Mirrors the NestJS dashboard's old `resolveMissing` endpoint: creates+
  submits a Sales Invoice directly via `queue_sales_invoice` with `custom_invoice_ref` set to the
  page number, no Delivery Report involved. The payment-status shaping logic
  (Paid/Partial/Unpaid → `pay_in_full`/`amountPaid`/`isCreditSale`) currently inline in
  `create_invoice_from_delivery_report` gets extracted into a shared helper so both entry points
  use the same logic rather than duplicating it.
- **`booklet.py::get_daily_reconciliation(date=None)`** (defaults to today) — the checklist
  endpoint:
  1. Collect every number touched that date: `Sales Invoice.custom_invoice_ref` where
     `posting_date = date`, and `Delivery Report.reported_invoice_no` (parsed) where
     `date(coalesce(delivery_timestamp, creation)) = date`.
  2. `[min, max]` across those two sets is the day's range (empty date → empty checklist, not an
     error).
  3. For every integer in that range, classify:
     - **Void** — in the covering booklet's `void_entries`.
     - **Delivered** — invoice exists, `custom_delivery_status = Delivered`.
     - **Partially Delivered** — invoice exists, `custom_delivery_status = Partially Delivered`.
       Kept as its own distinct bucket rather than folded into Delivered (decided 2026-08-02,
       prompted by the user asking how partial delivery is currently handled) - a remainder may
       still be genuinely pending, not just a cosmetic difference. Counts as an **accepted
       closing state**, same as Delivered/Self-Pickup/Void (see Daily closing below) - the
       eventual remainder delivery is a follow-up confirm against the *same* invoice, not a new
       paper page, so it's invisible to this page-number-keyed checklist by design; it's already
       tracked by the existing reconciliation queue's own flagged-group clustering (Module 10),
       not re-litigated here.
     - **Self Pickup** — invoice exists, `custom_delivery_status = Self Pickup`.
     - **Pending Fulfillment** — invoice exists, `custom_delivery_status` ∈ `{Pending, Not
       Delivered}`, no Confirmed Delivery Report yet. *(Actions: Confirm Self-Pickup / Confirm
       Delivered (manual) — see above. No void option; a real submitted invoice already exists.)*
     - **Reported, No Invoice** — a Delivery Report exists, no Sales Invoice yet. *(Action: Create
       Invoice — today's Module 15 `create_invoice_from_delivery_report` flow already fits, a
       report exists to hang it off.)*
     - **Unresolved** — neither an invoice nor a report. *(Actions: Create Invoice —
       `create_invoice_for_unreported_page`, the new no-report path — or Mark Void.)*

## New frontend
- **`klik_spa/src/pages/DailyReconciliationPage.tsx`**, route `/deliveries/daily-reconcile` (own
  nav entry, not a tab on the Booklets page — different cadence: daily habit vs. occasional
  booklet setup).
- Date picker, defaults to today, can browse past dates (catching up on a day reconciled late).
- Full checklist (every number in range, not just gaps) with a status badge per row and the
  relevant action button per the classification above.

## Non-goals
- Not a rework of `get_booklet_gaps` (Todo 041/042's per-booklet interior-gap check) — that stays
  as a booklet-lifetime view; this is a date-scoped operational checklist. Whether the two should
  eventually be unified is an open question, not decided.
- Not touching ERPNext's own Sales Invoice cancel/void flow — "void" here is a booklet-page marker
  only, independent of invoice cancellation.
- Not a rework of `confirm_delivery_match`/the bot-verified reconciliation flow — the new manual
  "Confirm Delivered" path is a deliberately separate, lower-trust action for when no bot report
  exists at all.

## Decisions (made with the user, 2026-08-02)
- `set_manual_delivery_status` needs no extra audit trail beyond normal Frappe edit history
  (`track_changes` already on Sales Invoice) - no timeline comment needed.
- `create_invoice_for_unreported_page` requires a customer up front, same rule as Module 15's
  existing Create Invoice modal - no "unknown/walk-in, fix later" shortcut.

## Daily closing (added 2026-08-02, user request: "like daily account book closing")
The checklist alone never terminates - it needs an explicit sign-off, same as closing a physical
ledger for the day. Decided with the user:
- **Hard-blocked**: every number in the day's range must be Void/Delivered/Partially Delivered/
  Self-Pickup before closing is allowed - the Close action stays disabled and lists exactly which
  numbers are still blocking (Pending Fulfillment/Reported-No-Invoice/Unresolved), mirroring the
  "can't close the book with blank entries" metaphor. Partially Delivered is accepted as a closing
  state, not a blocker (see classification above) - its eventual remainder is tracked by the
  ordinary reconciliation queue, not by reopening an already-closed day.
- **Reopenable, System Manager only**: closing is a real sign-off, not something undone casually.
- **Late data after close**: flagged for re-review, not silently ignored and not blocked from
  syncing - the closing record stays as historical proof of what was known at close time, but
  visibly shows "needs re-review" until someone re-closes or reopens it.
- **Fully separate from POS Closing Shift** (Module 6, cash/till reconciliation) - different
  concern (paper-page accounting vs. cash), no gating between them.

### New DocType: `Delivery Booklet Daily Closing`
`closing_date` (Date, unique), `start_number`/`end_number` (Int, snapshot of the range at close
time), `delivered_count`/`partially_delivered_count`/`self_pickup_count`/`void_count` (Int,
snapshot summary), `status`
(Select: `Closed` / `Reopened` / `Needs Re-review`), `closed_by`/`closed_at`,
`reopened_by`/`reopened_at` (optional), `needs_review_reason` (Small Text, optional - e.g. "New
Delivery Report DR-08-0099 (invoice 47) synced after closing").

### New/changed backend
- **`booklet.py::close_daily_reconciliation(date)`** - recomputes `get_daily_reconciliation(date)`
  fresh; throws (listing the blocking numbers) if anything isn't Void/Delivered/Self-Pickup;
  otherwise upserts the closing record with a fresh snapshot.
- **`booklet.py::reopen_daily_reconciliation(date)`** - System Manager only; sets
  `status = Reopened`, stamps `reopened_by`/`reopened_at`, leaves the original `closed_by`/
  `closed_at` in place as history.
- **`get_daily_reconciliation(date)`** gains a lazy re-review check: if a `Closed` closing record
  exists for that date, recomputes the range/counts and compares against the stored snapshot; on
  drift, updates the record's `status` to `Needs Re-review` with a reason (so a list view of
  closings surfaces exactly which days need another look without opening each one), and the
  response includes `closing_status`/`closing_summary` for the frontend to render a banner.

### Frontend
- `DailyReconciliationPage.tsx` gets a "Close Day" button (disabled + blocking-numbers list until
  every row resolves), a closed-day banner (closed by/at, or "needs re-review" with the reason),
  and a Reopen action (visible only to System Manager, matching the backend guard).

## Todos
- [x] [045.md](../todo/045.md): Self Pickup delivery status + void page marker (data model)
- [x] [046.md](../todo/046.md): Manual delivery confirm + no-report invoice backfill
- [x] [047.md](../todo/047.md): Daily reconciliation checklist + closing
- [x] [048.md](../todo/048.md): Daily reconciliation page (frontend)
- [x] [049.md](../todo/049.md): Self-pickup checkbox at POS checkout (follow-up, 2026-08-02) - lets
  staff mark Self Pickup immediately at time of sale instead of always requiring a later Daily
  Reconciliation confirm, for the common "customer takes it right now" case
- [x] [050.md](../todo/050.md): Show invoices without a physical reference in Daily
  Reconciliation (follow-up, 2026-08-02) - purely informational, never affects Close Day (which
  stays scoped to the physical booklet's min-max range only)
- [x] [051.md](../todo/051.md): Link/unlink unreferenced invoices to Unresolved pages + confirm
  dialogs on every manual action (follow-up, 2026-08-02)
