# Phase 13: Offline-First Bot Repoint & Legacy Stack Retirement
**Module 14**

**Status:** ⬜ Not started

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
- SQLite replaces Postgres for the bot's own durability. No Redis/BullMQ (a simple worker loop
  + SQLite queue suffices at this scale). No MinIO (photos/voice buffer locally, upload to Frappe
  File on sync).
- KlikPOS is authoritative once synced; the local SQLite row is a durable outbox, not a second
  system of record.

## Todos
- [ ] [033.md](../todo/033.md): Bot local SQLite store + FSM writes (offline capture)
- [ ] [034.md](../todo/034.md): Sync worker (store-and-forward, idempotent, retry, sync status)
- [ ] [035.md](../todo/035.md): Media buffering + upload to Frappe File on sync
- [ ] [036.md](../todo/036.md): Cutover + retire NestJS/Postgres/Redis/MinIO/ocr-service

## Notes
- Work in Todos 033–036 lives in the **bot repo** (`hd-delivery-telegram`), not this repo; the
  KlikPOS-side contract is the Phase 9 ingestion/file APIs. These todos are tracked here so the
  consolidation plan is complete in one place.
- Driver identity (Phase 10) and delivery ingestion (Phase 9) must be live before cutover.
