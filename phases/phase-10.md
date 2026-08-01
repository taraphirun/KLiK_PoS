# Phase 10: Driver Management & Free-Text → Link Migration
**Module 11**

**Status:** ✅ Done (backend fully verified; frontend build/typecheck clean, not yet browser-checked
— see Todo 027). Bot-side wiring for the two-way sync (Todo 026's design) completed 2026-08-01 —
see addendum below.

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

## Addendum (2026-08-01): bot-side wiring for the two-way sync

Todo 026 built `sync_driver_from_bot`/`set_driver_status`/`list_drivers` on the KlikPOS side, but
the bot never actually called them - a driver approved via the bot's own Telegram buttons never
reached KlikPOS, and an approval made from KlikPOS's `/drivers` page never reached the bot. Fixed
in `hd-delivery-telegram/delivery-bot`:

- **Push** (`driver_sync.push_driver_to_klikpos`): called right after a `/register` signup, and
  again from the bot's own Telegram approve/reject buttons (`cb_reg_approve`/`cb_reg_reject`) -
  creates/updates the KlikPOS `Delivery Driver` record and pushes any status change immediately.
  Best-effort throughout: a KlikPOS-side failure is logged, never raised, so the bot's own
  registration/approval flow keeps working standalone exactly as before regardless of KlikPOS's
  reachability.
- **Poll** (`driver_sync.poll_klikpos_status`, background loop, default 60s interval): the
  mechanism that makes this phase's "Frappe is master" decision actually true for the bot -
  fetches current KlikPOS driver statuses via `list_drivers`, and for any driver whose status
  differs from the bot's local Postgres `Driver.status`, pulls it down (updates local Postgres +
  the in-memory `allowed_drivers` set) and DMs the driver so they know to (re)try `/start`. This
  is what makes an approval made *from* KlikPOS's `/drivers` page actually unblock the driver in
  the bot - previously nothing propagated that decision back at all.
- Matching is by `telegram_user_id` for the poll direction (the field the poll needs to act on
  locally anyway) and `bot_driver_id` (the bot's own Postgres `Driver.id` UUID) for the push
  direction, both handled by `sync_driver_from_bot`'s existing bot_driver_id-then-telegram_user_id
  match order (Todo 026) - no KlikPOS-side changes were needed for any of this, only the bot side.

Verified end-to-end against the real KlikPOS site (not just logic-tested): registered a driver
locally → pushed to KlikPOS as `Pending` → approved *from the KlikPOS side* (`set_driver_status`
called directly, bypassing the bot entirely, simulating admin action in `/drivers`) → poll picked
it up → local Postgres status flipped to `ACTIVE`, driver added to `allowed_drivers`, notification
DM sent. Repeated for the reject/suspend path (`REJECTED`, removed from `allowed_drivers`,
different notification text). All test data cleaned up on both sides after each run.
