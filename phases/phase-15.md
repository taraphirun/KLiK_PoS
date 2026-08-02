# Phase 15: Delivery Booklet Registry & Lifecycle
**Module 16**

**Status:** ✅ Done (klik_pos side backend fully verified live via bench console against
hd.phirun.me, frontend build/typecheck clean; delivery-bot side import/logic-verified in its own
venv - see todo/041-044.md notes. Not yet browser-checked or run against a live Telegram bot.)

## Objective
Port the "booklet" feature from `hd-delivery-telegram`'s legacy NestJS/Next.js dashboard (a
separate, still-actively-used deploy with its own Postgres DB) into KlikPOS. A booklet is the
registry entry for a physical paper invoice book handed to a driver: a number range
(`startNumber`-`endNumber`), optionally dedicated to one VIP customer, with a lifecycle
(Active → Stalled → Ready for Review → Closed) that the original service tracked via an hourly
cron and Telegram admin alerts. None of this reached KlikPOS before this phase - the booklet
feature and the Delivery Report/reconciliation system this app already owns had never been
connected.

## Context
Investigated at the user's request ("There was a booklet feature inside of my hd delivery
telegram. Can you go and study it and the feasibility of integration?"). Key findings that shaped
the design:
- `hd-delivery-telegram` actually contains **two independent delivery-bot implementations**: a
  legacy NestJS/Next.js dashboard (Postgres via Prisma, OCR service, MinIO) where the booklet
  feature lives, and the live aiogram Python bot (`delivery-bot/`) that actually syncs to KlikPOS
  today (Module 10/14). `DELIVERY_BOT_INTEGRATION.md` claimed the NestJS dashboard was "unused,
  confirmed retired" - contradicted by the user's own screenshot of a live, real "Booklet #71 is
  STALLED!" Telegram alert firing from it. That doc line was stale and is corrected in this phase.
- The live Python bot has drivers **type** the invoice number as plain text - no OCR of the
  photographed page, unlike what the booklet's gap/VIP-matching logic seems to have originally
  been designed around. Gap detection was kept anyway per the user's explicit call ("a real missed
  page and a typo'd number both deserve a flag either way").
- `driver_sync.py` (Phase 10 addendum) already established the integration's precedent for
  KlikPOS-owned state reaching the bot: **the bot polls KlikPOS**, never the reverse - no inbound
  HTTP surface exists on the bot at all. The user initially asked for a klik_pos-to-bot webhook for
  the stall/ready alerts, but switched to the poll pattern once this precedent was pointed out.

## Decisions (made with the user, 2026-08-02)
- **Scope**: full port - a first-class `Delivery Booklet` DocType + lifecycle scheduler in
  KlikPOS, not just a read-only display or a narrow "VIP auto-assign only" slice.
- **Data migration**: none. Not a production environment yet, so existing NestJS-side booklets are
  not carried over - start fresh.
- **Cutover**: hard cutover once this is live - KlikPOS becomes the only place booklets are
  managed (avoids the drift risk of two systems tracking the same lifecycle independently, a
  pattern this project has repeatedly guarded against elsewhere - see e.g. `DELIVERY_STATUS_RANK`
  in `delivery.py`). Retiring/decommissioning the NestJS dashboard itself is not part of this
  phase's scope (same "deliberately deferred" posture as Todo 036 for the rest of that stack).
- **Permissions**: same as the rest of the reconciliation feature - System Manager (doctype
  fixture) + `Delivery Bot` role (Custom DocPerm, matching Delivery Report's existing live setup,
  not exported as a fixture).
- **Alert direction**: KlikPOS computes status only (hourly scheduler, no Telegram integration of
  its own); the bot polls `list_booklets` (default 300s) and sends the Telegram broadcast/DM
  itself on an observed transition - mirrors `driver_sync.py`'s poll pattern exactly, deliberately
  chosen over a new klik_pos → bot webhook once the existing precedent was surfaced.
- **Gap detection**: kept, scoped to the interior range between a booklet's lowest and highest
  *reported* number (not its full start-end range, most of which is legitimately just not written
  yet) - mirrors the original NestJS dashboard's deliberate definition.

## Todos
- [x] [041.md](../todo/041.md): `Delivery Booklet` + `Delivery Booklet Settings` DocTypes,
  `klik_pos/api/booklet.py` CRUD/candidate/resolve/gap endpoints, ingestion-time booklet matching
  in `submit_delivery_report`, Booklets management page (`klik_spa`).
- [x] [042.md](../todo/042.md): Hourly lifecycle scheduler
  (`check_booklet_lifecycle`) - Active/Stalled/Ready for Review computation, no Telegram involved.
- [x] [043.md](../todo/043.md): Bot-side booklet status poll (`delivery-bot/booklet_sync.py`) +
  Telegram alerts, wired into `bot.py`'s background task set.
- [x] [044.md](../todo/044.md): VIP booklet auto-customer-assign hint + reconciliation page
  surfacing (booklet badge, out-of-range resolve action, Create Invoice modal prefill).

## Non-goals
- Not a migration of existing NestJS-side booklet data - starts empty (see Decisions).
- Not a decommissioning of the NestJS dashboard itself - out of scope, same posture as Todo 036.
- Not OCR-based invoice number extraction - the live bot's manual-entry flow is unchanged; gap
  detection works against whatever text the driver typed, typos included.
- Not a klik_pos → bot webhook - deliberately the opposite direction (see Decisions).
