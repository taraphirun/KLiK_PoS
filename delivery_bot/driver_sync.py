"""Driver identity sync between the bot and KlikPOS's Delivery Driver (Phase 10 addendum,
2026-08-01; Postgres retired at cutover, Todo 036, 2026-08-03).

Phase 10 (klik_pos/phases/phase-10.md) decided KlikPOS/Frappe is the driver system of record:
drivers are created/approved/suspended in KlikPOS, the bot only contributes Telegram identity.
KlikPOS is now also the bot's ONLY store for driver identity/status - there is no local Driver
table anymore. Three things are wired up here:

- push_driver_to_klikpos(): called right after a new /register signup (and again from the bot's
  own Telegram approve/reject buttons) - creates/updates the KlikPOS Delivery Driver record via
  sync_driver_from_bot (klik_pos/api/driver.py, Todo 026). Best-effort: a failure here is logged,
  never raised.
- find_driver_by_telegram_id(): on-demand read-only lookup (Todo 036) - used by bot.py's
  /start, /register, and location-trigger handlers to check a driver's current KlikPOS status
  without implicitly creating a Pending record (unlike sync_driver_from_bot, which is
  create-or-update). Reuses list_drivers rather than adding a new KlikPOS endpoint - driver counts
  are low-volume (list_drivers's own docstring), so pulling the full list and filtering client-side
  is cheap enough for an occasional on-demand check.
- poll_klikpos_status(): background loop - the mechanism that makes an approval made *from*
  KlikPOS's own /drivers page actually reach the bot: pulls current statuses down via
  list_drivers, updates the in-memory allowed_drivers set (and local_store's driver_status table,
  which exists purely so a status change is only acted on/notified once), and DMs the driver so
  they know to (re)try /start.

Deliberately stateless with respect to bot.py's globals (allowed_drivers) - takes it as a
parameter rather than importing bot.py, to avoid a circular import (bot.py imports this module).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from aiogram import Bot

import klikpos_client
import local_store

logger = logging.getLogger("driver-sync")

DRIVER_POLL_INTERVAL_SECONDS = int(os.getenv("DRIVER_POLL_INTERVAL_SECONDS", "60"))


async def push_driver_to_klikpos(
    client: httpx.AsyncClient,
    *,
    bot_driver_id: str | None,
    driver_name: str,
    telegram_user_id: str,
    telegram_username: str | None,
    chat_id: str | None,
    phone_number: str | None = None,
) -> str | None:
    """Create/update the KlikPOS Delivery Driver record for this bot driver. Returns the KlikPOS
    docname on success, None on failure (logged, never raised). phone_number is only ever applied
    by KlikPOS on first creation (see sync_driver_from_bot's own precedence comment) - passing it
    on a later call for an existing driver is harmless, just ignored."""
    if not klikpos_client.is_configured():
        return None

    try:
        response = await client.post(
            klikpos_client.method_url("klik_pos.api.driver.sync_driver_from_bot"),
            headers=klikpos_client.headers(),
            json={
                "payload": {
                    "bot_driver_id": bot_driver_id,
                    "driver_name": driver_name,
                    "telegram_user_id": telegram_user_id,
                    "telegram_username": telegram_username,
                    "chat_id": chat_id,
                    "phone_number": phone_number,
                }
            },
            timeout=15,
        )
        response.raise_for_status()
        body = response.json().get("message", {})
        if not body.get("success"):
            logger.warning("sync_driver_from_bot failed for %s: %s", telegram_user_id, body.get("message"))
            return None
        return body["driver"]
    except Exception:
        logger.exception("Failed to push driver %s to KlikPOS", telegram_user_id)
        return None


async def push_status_to_klikpos(client: httpx.AsyncClient, klikpos_driver: str, status: str) -> None:
    """Push a status change made via the bot's own Telegram approve/reject buttons to KlikPOS
    immediately, rather than waiting for KlikPOS's own /drivers page to be the only way to see it.
    Best-effort - KlikPOS is still authoritative (Phase 10), this is just keeping it current."""
    if not klikpos_client.is_configured():
        return

    try:
        response = await client.post(
            klikpos_client.method_url("klik_pos.api.driver.set_driver_status"),
            headers=klikpos_client.headers(),
            json={"driver": klikpos_driver, "status": status},
            timeout=15,
        )
        response.raise_for_status()
    except Exception:
        logger.exception("Failed to push status %s for %s to KlikPOS", status, klikpos_driver)


async def find_driver_by_telegram_id(client: httpx.AsyncClient, telegram_user_id: str) -> dict[str, Any] | None:
    """Read-only lookup of a driver's current KlikPOS record by Telegram ID - unlike
    push_driver_to_klikpos (create-or-update via sync_driver_from_bot), this never creates
    anything. Used where the bot needs to check "is this person a known driver, and what's their
    status" without that check itself counting as a registration attempt."""
    if not klikpos_client.is_configured():
        return None

    try:
        response = await client.get(
            klikpos_client.method_url("klik_pos.api.driver.list_drivers"),
            headers=klikpos_client.headers(),
            params={"limit": 200},
            timeout=15,
        )
        response.raise_for_status()
        body = response.json().get("message", {})
    except Exception:
        logger.exception("Failed to look up driver %s in KlikPOS", telegram_user_id)
        return None

    if not body.get("success"):
        return None

    for row in body.get("data", []):
        if row.get("telegram_user_id") == telegram_user_id:
            return row
    return None


async def poll_klikpos_status(bot: Bot, allowed_drivers: set[int]) -> None:
    """Pull KlikPOS driver statuses down into the bot's local state. This is the primary way an
    approval/rejection/suspension made in KlikPOS's own /drivers page reaches the bot."""
    if not klikpos_client.is_configured():
        return

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                klikpos_client.method_url("klik_pos.api.driver.list_drivers"),
                headers=klikpos_client.headers(),
                params={"limit": 200},
                timeout=15,
            )
            response.raise_for_status()
            body = response.json().get("message", {})
    except Exception:
        logger.exception("Failed to poll KlikPOS driver statuses")
        return

    if not body.get("success"):
        return

    for row in body.get("data", []):
        await _sync_one_driver_down(bot, allowed_drivers, row)


async def _sync_one_driver_down(bot: Bot, allowed_drivers: set[int], row: dict[str, Any]) -> None:
    telegram_user_id = row.get("telegram_user_id")
    status = row.get("status")  # KlikPOS's own values: Active / Pending / Rejected
    if not telegram_user_id or not status:
        return

    last_status = await local_store.get_driver_last_status(telegram_user_id)
    if last_status == status:
        return
    await local_store.set_driver_last_status(telegram_user_id, status)

    logger.info("Driver %s status changed %s -> %s via KlikPOS", telegram_user_id, last_status, status)

    try:
        tg_id = int(telegram_user_id)
    except (TypeError, ValueError):
        return

    if status == "Active":
        allowed_drivers.add(tg_id)
        # A brand-new driver's very first observed status is "Active" with no prior last_status
        # (e.g. one approved in KlikPOS before ever messaging the bot) - nothing to notify them
        # about transitioning *from*, so only DM on a genuine Pending -> Active transition.
        if last_status is not None:
            try:
                await bot.send_message(tg_id, "🎉 Your registration has been approved! Send /start to begin using the bot.")
            except Exception:
                logger.warning("Failed to notify approved driver %d", tg_id)
    else:
        allowed_drivers.discard(tg_id)
        if status == "Rejected" and last_status is not None:
            try:
                await bot.send_message(tg_id, "❌ Your registration was not approved. Contact an administrator for details.")
            except Exception:
                logger.warning("Failed to notify rejected driver %d", tg_id)
