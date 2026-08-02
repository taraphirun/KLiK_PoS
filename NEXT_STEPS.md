# Next Steps

Outstanding items as of 2026-08-02, after Module 17 (Daily Booklet Page Reconciliation). Not a
phased todo list — a snapshot of what's left to verify, act on, or pick up. Update or delete items
as they're resolved; this file isn't meant to accumulate stale entries the way `bugs.md` sometimes
does.

## Needs your verification (built + tested by Claude, not yet confirmed in browser)
- [ ] Daily Reconciliation page (`/deliveries/daily-reconcile`) — checklist, Close/Reopen, link/
      unlink, confirm dialogs
- [ ] Self-pickup checkbox at POS checkout — fixed the `isDeliveryRequired` gating bug, unconfirmed
      since your last restart
- [ ] Booklets page (`/deliveries/booklets`) and reconciliation-page booklet badges/resolve action
- [ ] Live Delivery Map — blocked on setting a real Google Maps API key on the POS Profile first

## Needs an action from you (ops/deployment, not code)
- [ ] Restart `hd-delivery-telegram`'s bot process so `booklet_sync.py` actually runs against
      Telegram - only unit-tested in isolation so far
- [ ] Delete leftover $1 test invoices against "Delivery Reconciliation Demo (seed)" customer -
      stuck uncancellable because AZT stock is too tight on this site; not touched since it'd
      require a Stock Settings change
- [ ] Push this session's commits to origin - everything is local-only on `version-16.1` so far

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
