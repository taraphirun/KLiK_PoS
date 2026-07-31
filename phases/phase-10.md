# Phase 10: Driver Management & Free-Text → Link Migration
**Module 11**

**Status:** ✅ Done (backend fully verified; frontend build/typecheck clean, not yet browser-checked
— see Todo 027)

## Objective
Introduce a first-class `Delivery Driver` master in KlikPOS (Frappe) so drivers can be created,
approved, and suspended from the KlikPOS UI, and migrate the free-text `delivery_driver` fields
(Phase 9, Todos 019–020) to proper `Link` references. This is the prerequisite the earlier Design
Notes flagged for turning driver into a Link.

**Naming note (2026-07-30):** ERPNext core already owns the doctype name `Driver`
(`erpnext/setup/doctype/driver`, fleet/employee-oriented). The Frappe doctype here is named
`Delivery Driver` to avoid the collision — the bot's own Postgres `Driver` table below is a
separate system and is unaffected.

## Context — this integrates with an existing system
The delivery bot project (`/home/phirun/dev/hd-delivery-telegram`) already owns driver identity
in its own PostgreSQL `Driver` table:

| Bot field (Prisma) | Meaning |
|---|---|
| `id` (uuid) | driver primary key |
| `name` | display name |
| `phoneNumber` (unique) | contact |
| `telegramUserId` (unique) | Telegram identity |
| `telegramUsername` (unique) | Telegram handle |
| `chatId` | Telegram chat for bot messaging |
| `status` | `ACTIVE` / `PENDING` / `REJECTED` |

Telegram identity (`telegramUserId`, `chatId`) is inherently bot-side. Therefore the two systems
must stay in sync; they cannot each independently own the driver record.

## Source-of-truth: Frappe is master (DECIDED)
**Frappe/KlikPOS is the driver system of record.** Drivers are created/approved/suspended in
KlikPOS; the bot syncs driver records FROM Frappe and attaches Telegram identity
(`telegram_user_id` / `chat_id`) back to Frappe when a driver first messages the bot. There is no
mirror mode — the bot never owns the driver record, only contributes Telegram identity to it.

Precedence rule for the two-way sync (Todo 026): **Frappe wins on status and profile fields; the
bot wins only on the Telegram-identity fields it uniquely knows.**

## Todos
- [x] [025.md](../todo/025.md): `Delivery Driver` DocType (mirrors the bot's driver model)
- [x] [026.md](../todo/026.md): Delivery Driver management API + bot sync bridge
- [x] [027.md](../todo/027.md): Frontend Delivery Driver management page (KlikPOS side menu)
- [x] [028.md](../todo/028.md): Migrate `delivery_driver` free-text → `Link(Delivery Driver)` +
  backfill

## Relationship to the broader UI-integration question
This phase ports the driver screen natively into KlikPOS because driver identity must Link to Sales
Invoices and Delivery Reports. Per the updated consolidation plan (Modules 12–14), the remaining
delivery screens (deliveries list, conflicts, live map) are **also ported natively**, and the bot's
`Customer`/`Address` are not ported (native to ERPNext) and `Booklet` is dropped (legacy). Keep the
`Delivery Driver` sync API generic enough that the bot can reconcile drivers regardless of which UI
created them.
