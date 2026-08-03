# Next Steps

Outstanding items as of 2026-08-03, after Module 17 (Daily Booklet Page Reconciliation) and its
2026-08-03 follow-up (Todos 053-054: full-range booklet close gate, Scheduled delivery dates,
locked-when-closed actions). Not a phased todo list — a snapshot of what's left to verify, act on,
or pick up. Update or delete items as they're resolved; this file isn't meant to accumulate stale
entries the way `bugs.md` sometimes does.

## Needs your verification (built + tested by Claude, not yet confirmed in browser)
- [ ] Live Delivery Map shop location pin(s) (Todo 055) — set "Shop Latitude"/"Shop Longitude" on
      your warehouse(s) in Desk (Stock → Warehouse), then confirm the pin(s) show up on
      `/deliveries/map`

## Needs an action from you (ops/deployment, not code)
- [ ] Delete leftover $1 test invoices against "Delivery Reconciliation Demo (seed)" customer -
      stuck uncancellable because AZT stock is too tight on this site; not touched since it'd
      require a Stock Settings change

## Known, deliberately deferred (not urgent)
- [ ] Todo 036: retire the legacy NestJS/Postgres/Redis/MinIO/OCR stack in the bot repo - needs a
      monitored parallel-run window first
- [ ] Delivery Report permission gap: only System Manager + the bot's service role can see the
      reconciliation queue - regular staff get a silently empty page. No decision made yet on
      broadening it.
- Module 12 (Deliveries & Conflicts UI) — dropped, not being built, listed here only for context

## Pre-existing bugs, still open (see `bugs.md` for full detail)
- [ ] BUG-001: `custom_delivery_date` is written on Sales Invoice but isn't a real field - silently
      dropped, appears to be dead code
- [ ] BUG-002: `custom_invoice_ref` is an `Int` (not `Data`), defaults to `0` instead of empty -
      more load-bearing now that Daily Reconciliation depends on it; related gap found this session
      (`allow_on_submit: 0` blocking post-submission edits, worked around narrowly rather than
      fixed at the field level)
