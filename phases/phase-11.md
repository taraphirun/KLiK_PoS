# Phase 11: Deliveries & Conflicts UI in KlikPOS
**Module 12**

**Status:** ❌ Dropped (2026-07-31)

## Why dropped
This phase existed for two reasons, both gone:
1. **OCR/AI disambiguation.** The original bot design used OCR/AI to read invoice numbers off
   photos, which produces genuinely ambiguous reads needing a human conflicts queue. Module 10
   settled on a fully structured Telegram flow instead (see its system boundary: "bot collects,
   KlikPOS confirms," no OCR/AI) — there's no OCR ambiguity left to resolve.
2. **The "duplicates" conflict type was wrong.** The Conflicts view below was going to flag
   "multiple Delivery Reports with the same `reported_invoice_no`" as a duplicate needing
   merge/reject. But an invoice can legitimately receive **more than one real delivery** — a
   Partial delivery now, the remainder later — so that heuristic would have flagged the normal
   partial-delivery case as an error requiring cleanup. That was caught 2026-07-31 while auditing
   Module 10 for exactly this scenario (see phase-09.md's addendum) — the reconciliation flow now
   handles multiple deliveries per invoice directly instead.

Todos 029/030 below are kept as historical record, not implemented.

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
