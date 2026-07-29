# Phase 11: Deliveries & Conflicts UI in KlikPOS
**Module 12**

**Status:** ⬜ Not started

## Objective
Port the bot frontend's delivery-facing screens into the KlikPOS SPA so deliveries are viewed and
resolved in one place, reading from the Frappe `Delivery Report` doctype (Phase 9) instead of the
bot's Postgres/NestJS backend. This is step 2 of the strangler-fig consolidation (after the
doctypes exist).

## Scope
- **Deliveries list**: browse/search/filter Delivery Reports (by driver, status, date, sync/recon
  state), drill into a single report, see photos/voice/GPS.
- **Conflicts view**: surface problem cases that need a human — duplicate `reported_invoice_no`
  submissions, and low-confidence / unmatched auto-matches (the KlikPOS-native equivalent of the
  bot's `conflicts/duplicates` + `low-confidence` pages). Actions route into the Phase 9
  reconciliation endpoints (confirm / reject / re-match).

Out of scope: live map (Phase 12), the bot repoint + offline sync (Phase 13).

## Todos
- [ ] [029.md](../todo/029.md): Deliveries list API + KlikPOS deliveries page
- [ ] [030.md](../todo/030.md): Conflicts/duplicates view (native, over Frappe Delivery Reports)

## Notes
- Port markup/logic from the bot's Next.js screens; do **not** copy verbatim — Tailwind v4 →
  KlikPOS Tailwind v3, Next App Router → Vite/react-router, React 19 → KlikPOS React.
- Reuse the Phase 9 reconciliation service (`klik_spa/src/services/delivery.ts`) rather than a new
  API client.
- The reconciliation page from Phase 9 (Todo 024) and this deliveries list should share
  components where sensible (report card, status badges).
