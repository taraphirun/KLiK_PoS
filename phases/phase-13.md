# Phase 13: Offline-First Bot Repoint & Legacy Stack Retirement
**Module 14**

**Status:** 🔷 In progress (Todos 033–035 done and verified end-to-end against the real KlikPOS
site; Todo 036 — actual cutover/decommission — intentionally not started, see notes)

## Objective
Make the Telegram bot an **offline-first, store-and-forward** client of KlikPOS, then retire the
old NestJS + Postgres + Redis/BullMQ + MinIO + ocr-service stack. After this phase, KlikPOS
(Frappe) is the single system of record; the bot is a thin driver-facing data-entry channel that
keeps working when the ERPNext server is down.

## Why offline-first
Drivers work in the field with unreliable connectivity, and the ERPNext server may be down for
maintenance. The bot must **never block a driver**: every delivery is written to a local store
immediately and synced to KlikPOS when reachable. The bot UI is reduced to a per-delivery
**Synced / Not Synced** indicator.

## Architecture
```
Driver ──▶ aiogram FSM ──▶ local SQLite (source of truth WHILE offline)
                               │  each row: sync_status = Not Synced | Synced | Failed
                               ▼
                        sync worker (background loop)
                               │  POST unsynced rows → KlikPOS submit_delivery_report (Todo 021)
                               │  idempotent on bot_delivery_id; upload photos/voice → Frappe File
                               ▼
                     on 2xx: mark row Synced (store returned Delivery Report name)
```
- SQLite replaces Postgres for the bot's own durability going forward - **as of Todos 033–035,
  this is additive, not yet a replacement**: the bot still also dual-writes to Postgres
  (`delivery_bot.delivery_logs` + `public.Invoice`) and still uses Redis (FSM state + photo-album
  batching, unrelated to the sync queue) and MinIO (for that legacy Postgres path's photo storage)
  exactly as before. Retiring those is Todo 036's job, deliberately deferred (see below) - this
  phase's actual sequencing turned out to be "add the new path fully, verify it, *then* remove the
  old one," not "replace in place."
- KlikPOS is authoritative once synced; the local SQLite row is a durable outbox, not a second
  system of record.

## Todos
- [x] [033.md](../todo/033.md): Bot local SQLite store + FSM writes (offline capture)
- [x] [034.md](../todo/034.md): Sync worker (store-and-forward, idempotent, retry, sync status)
- [x] [035.md](../todo/035.md): Media buffering + upload to Frappe File on sync
- [ ] [036.md](../todo/036.md): Cutover + retire NestJS/Postgres/Redis/MinIO/ocr-service

## Notes
- Work in Todos 033–036 lives in the **bot repo** (`hd-delivery-telegram`), not this repo; the
  KlikPOS-side contract is the Phase 9 ingestion/file APIs (plus two new endpoints added for
  Todo 035 - `upload_delivery_file`, `attach_delivery_media`). These todos are tracked here so the
  consolidation plan is complete in one place.
- Driver identity (Phase 10) and delivery ingestion (Phase 9) must be live before cutover.

## 2026-07-31 addendum: Todo 036 deliberately not attempted this pass
Scope for this pass was explicitly limited to Todos 033–035 (decided with the user) - Todo 036
(stopping/removing NestJS, Postgres, Redis, MinIO, ocr-service from `docker-compose.yml`, plus the
monitored parallel-run and historical-data-backfill steps it requires) is a genuinely different
kind of work: operationally risky, needs a monitoring window before it's safe, and that todo's own
Risks section already flags data loss as the primary concern. Not something to do in the same
sitting as building the thing being cut over to. The user separately confirmed they no longer use
the OCR service or any AI-related functions - relevant context for whenever Todo 036 is picked up,
but doesn't change this phase's current scope.
