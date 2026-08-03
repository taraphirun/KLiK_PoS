"""KlikPOS -> bot booklet lifecycle poll (Module 16, klik_pos/phases/phase-16.md).

Ports booklet-lifecycle.service.ts's Telegram alerting (the legacy NestJS dashboard's own
Postgres-backed booklet cron) onto the same "KlikPOS -> bot is poll-only" pattern already
established by driver_sync.py's poll_klikpos_status - decided with the user specifically to avoid
adding the bot's first-ever inbound HTTP surface just for this. KlikPOS itself only computes
status (klik_pos.api.booklet.check_booklet_lifecycle, an hourly scheduler job with no Telegram
integration of its own); this module is what turns an observed status change into a Telegram
alert, exactly mirroring the original service's notifyAdmins (broadcast to the reporting chat +
DM every admin).

Deliberately stateless with respect to bot.py's globals, same reasoning as driver_sync.py: takes
bot/admin ids/reporting chat config as parameters rather than importing bot.py, to avoid a
circular import (bot.py imports this module).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from aiogram import Bot

import klikpos_client
import local_store

logger = logging.getLogger("booklet-sync")

BOOKLET_POLL_INTERVAL_SECONDS = int(os.getenv("BOOKLET_POLL_INTERVAL_SECONDS", "300"))

# Only these transitions are alert-worthy (mirrors booklet-lifecycle.service.ts's
# shouldNotifyStall/shouldNotifyReady - Active and Closed are never alerted on).
ALERT_STATUSES = {"Stalled", "Ready for Review"}

_STATUS_LABELS = {"Stalled": "STALLED", "Ready for Review": "READY FOR REVIEW"}


async def poll_klikpos_booklets(
    bot: Bot,
    admin_telegram_ids: set[int],
    reporting_chat_id: str | None,
    reporting_topic_id: int | None,
) -> None:
    """One poll pass: pull every booklet's current status from KlikPOS, alert on any transition
    into Stalled/Ready for Review this module hasn't already alerted on. Best-effort - a KlikPOS-
    or Telegram-side failure is logged, never raised, same as driver_sync.py's poll."""
    if not klikpos_client.is_configured():
        return

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                klikpos_client.method_url("klik_pos.api.booklet.list_booklets"),
                headers=klikpos_client.headers(),
                timeout=15,
            )
            response.raise_for_status()
            body = response.json().get("message", {})
    except Exception:
        logger.exception("Failed to poll KlikPOS booklet statuses")
        return

    if not body.get("success"):
        return

    for row in body.get("data", []):
        await _check_one_booklet(bot, admin_telegram_ids, reporting_chat_id, reporting_topic_id, row)


async def _check_one_booklet(
    bot: Bot,
    admin_telegram_ids: set[int],
    reporting_chat_id: str | None,
    reporting_topic_id: int | None,
    row: dict[str, Any],
) -> None:
    name = row.get("name")
    status = row.get("status")
    if not name or not status:
        return

    last_status = await local_store.get_booklet_last_status(name)
    await local_store.set_booklet_last_status(name, status)

    if status not in ALERT_STATUSES or last_status == status:
        # Active/Closed never alert; an unchanged Stalled/Ready for Review was already alerted on
        # a prior pass (booklet-lifecycle.service.ts only notifies on the transition, not on every
        # tick it stays in that state).
        return

    booklet_number = row.get("booklet_number", name)
    text = f"🚨 Booklet #{booklet_number} is {_STATUS_LABELS[status]}!"

    if reporting_chat_id:
        kwargs: dict[str, Any] = {}
        if reporting_topic_id:
            kwargs["message_thread_id"] = reporting_topic_id
        try:
            await bot.send_message(reporting_chat_id, text, **kwargs)
        except Exception:
            logger.warning("Failed to broadcast booklet alert for %s", name)

    for admin_id in admin_telegram_ids:
        try:
            await bot.send_message(admin_id, text)
        except Exception:
            logger.warning("Failed to DM admin %d about booklet %s", admin_id, name)
