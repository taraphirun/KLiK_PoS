"""KlikPOS sync worker (Module 14 / Todo 034 + 035).

Background loop that drains the local SQLite outbox (local_store.py) into KlikPOS:
    1. POST submit_delivery_report - idempotent on bot_delivery_id (KlikPOS-side dedup).
    2. On success, upload any local media via Frappe's standard upload_file, attached to the
       Delivery Report doc that now exists (correct doctype-linked permission scoping - see
       klik_pos.api.delivery.attach_delivery_media's docstring for why upload happens AFTER the
       report exists, not before).
    3. Call attach_delivery_media to record the uploaded file URLs onto the report.
    4. Mark the outbox row Synced (or Failed, for a permanent/validation error).

Transient errors (network, timeout, 5xx) leave the row Not Synced for the next pass, with a
simple backoff computed from sync_attempts. Permanent errors (KlikPOS returns success: false -
Frappe's whitelisted methods return HTTP 200 with a success flag in the body, not a 4xx status,
see submit_delivery_report's own try/except) mark the row Failed immediately - retrying the exact
same payload against the exact same validation bug will not succeed, per Todo 034's requirement
that permanent errors are "surfaced, not retried forever". A row that's merely been transient-
failing for a very long time (SYNC_MAX_ATTEMPTS) is also flipped to Failed so the worker doesn't
hammer forever on something that looks structurally broken (e.g. a wrong API key).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

import klikpos_client
import local_store

logger = logging.getLogger("sync-worker")

SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "15"))
SYNC_BATCH_SIZE = int(os.getenv("SYNC_BATCH_SIZE", "20"))
SYNC_MAX_ATTEMPTS = int(os.getenv("SYNC_MAX_ATTEMPTS", "15"))
# Backoff: attempt 1 waits 15s, attempt 2 waits 30s, ... capped at 5 minutes between tries -
# simple exponential-ish backoff without a separate scheduler (computed from sync_attempts +
# updated_at at read time, not stored).
BACKOFF_CAP_SECONDS = 300


def _due_for_retry(row: dict[str, Any]) -> bool:
    """Simple per-row backoff: skip a row this pass if it hasn't been long enough since its last
    attempt, scaled by how many times it's already failed."""
    attempts = row["sync_attempts"]
    if attempts == 0:
        return True

    from datetime import datetime, timezone

    updated_at = datetime.fromisoformat(row["updated_at"])
    wait_seconds = min(BACKOFF_CAP_SECONDS, SYNC_INTERVAL_SECONDS * (2**attempts))
    elapsed = (datetime.now(timezone.utc) - updated_at).total_seconds()
    return elapsed >= wait_seconds


async def _upload_and_attach(client: httpx.AsyncClient, report_name: str, row: dict[str, Any]) -> None:
    """Best-effort: a media upload failure does not fail the sync (the report itself is already
    correctly created/matched in KlikPOS - that's what matters most). Local files are only pruned
    after a confirmed successful attach, per Todo 035's risk note."""
    photo_paths = json.loads(row["photo_paths"] or "[]")
    voice_path = row["voice_path"]

    photo_urls: list[str] = []
    for path in photo_paths:
        url = await _upload_one(client, report_name, path, "image/jpeg")
        if url:
            photo_urls.append(url)

    voice_url = None
    if voice_path:
        voice_url = await _upload_one(client, report_name, voice_path, "audio/ogg")

    if not photo_urls and not voice_url:
        return

    try:
        response = await client.post(
            klikpos_client.method_url("klik_pos.api.delivery.attach_delivery_media"),
            headers=klikpos_client.headers(),
            json={"report_name": report_name, "photo_urls": photo_urls, "voice_url": voice_url},
        )
        response.raise_for_status()
        body = response.json().get("message", {})
        if not body.get("success"):
            logger.warning("attach_delivery_media returned failure for %s: %s", report_name, body.get("message"))
            return
    except Exception:
        logger.exception("attach_delivery_media call failed for %s (media stays local, not pruned)", report_name)
        return

    # Only prune what we successfully attached.
    for path in photo_paths:
        _safe_remove(path)
    if voice_path and voice_url:
        _safe_remove(voice_path)


async def _upload_one(client: httpx.AsyncClient, report_name: str, local_path: str, content_type: str) -> str | None:
    if not os.path.exists(local_path):
        logger.warning("Media file missing on disk, skipping: %s", local_path)
        return None

    try:
        with open(local_path, "rb") as fh:
            response = await client.post(
                # klik_pos.api.delivery.upload_delivery_file, not Frappe's stock upload_file -
                # the stock endpoint's MIME allowlist rejects audio/ogg (voice notes) for any
                # non-Desk-access user (see that endpoint's docstring on the klik_pos side).
                klikpos_client.method_url("klik_pos.api.delivery.upload_delivery_file"),
                headers=klikpos_client.headers(),
                files={"file": (os.path.basename(local_path), fh, content_type)},
                data={"report_name": report_name},
            )
        response.raise_for_status()
        body = response.json()["message"]
        if not body.get("success"):
            logger.warning("upload_delivery_file failed for %s: %s", local_path, body.get("message"))
            return None
        return body["file_url"]
    except Exception:
        logger.exception("Failed to upload %s for %s", local_path, report_name)
        return None


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _to_klikpos_datetime(iso_timestamp: str) -> str:
    """MySQL/MariaDB's DATETIME column rejects Python's default isoformat() output
    ("2026-07-31T09:09:14.174246+00:00" - microseconds + a timezone offset suffix), even though
    Frappe's get_datetime() (klik_pos.api.delivery.submit_delivery_report) parses the string fine
    on its own - the failure happens one layer down, when the DB driver tries to save it. Convert
    to the plain naive "YYYY-MM-DD HH:MM:SS" form used everywhere else in this integration
    (captured timestamp is already UTC per bot.py's now_utc = datetime.now(dt_timezone.utc))."""
    from datetime import datetime

    return datetime.fromisoformat(iso_timestamp).strftime("%Y-%m-%d %H:%M:%S")


async def sync_one(client: httpx.AsyncClient, row: dict[str, Any]) -> None:
    bot_delivery_id = row["bot_delivery_id"]
    payload = {
        "bot_delivery_id": bot_delivery_id,
        "reported_invoice_no": row["reported_invoice_no"],
        "completion_status": row["completion_status"],
        "payment_status": row["payment_status"],
        "delivery_driver": row["driver_name"],
        "driver_telegram_id": row["driver_id"],
        "delivery_timestamp": _to_klikpos_datetime(row["timestamp"]),
        "gps_latitude": row["latitude"],
        "gps_longitude": row["longitude"],
    }

    try:
        response = await client.post(
            klikpos_client.method_url("klik_pos.api.delivery.submit_delivery_report"),
            headers=klikpos_client.headers(),
            json={"data": payload},
            timeout=30,
        )
        response.raise_for_status()
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        permanent = row["sync_attempts"] + 1 >= SYNC_MAX_ATTEMPTS
        await local_store.mark_sync_failure(bot_delivery_id, f"network error: {e}", permanent=permanent)
        return
    except httpx.HTTPStatusError as e:
        # 5xx from KlikPOS itself is transient (server hiccup/restart); anything else with this
        # app's contract shouldn't normally happen since validation errors come back as 200 with
        # success:false, not a 4xx - but treat unexpected 4xx as permanent rather than looping.
        permanent = e.response.status_code < 500 or row["sync_attempts"] + 1 >= SYNC_MAX_ATTEMPTS
        await local_store.mark_sync_failure(bot_delivery_id, f"HTTP {e.response.status_code}: {e}", permanent=permanent)
        return

    body = response.json().get("message", {})
    if not body.get("success"):
        # KlikPOS validated the payload and rejected it - retrying the identical payload will not
        # help, so this is permanent regardless of attempt count.
        await local_store.mark_sync_failure(bot_delivery_id, body.get("message", "unknown validation error"), permanent=True)
        return

    report_name = body["delivery_report"]
    await _upload_and_attach(client, report_name, row)
    await local_store.mark_synced(bot_delivery_id, report_name)
    logger.info("Synced delivery %s -> %s", bot_delivery_id, report_name)


async def run_once() -> None:
    if not klikpos_client.is_configured():
        logger.warning("KlikPOS not configured (KLIKPOS_BASE_URL/KLIKPOS_API_KEY) - sync worker idle")
        return

    rows = await local_store.fetch_pending(limit=SYNC_BATCH_SIZE)
    due = [r for r in rows if _due_for_retry(r)]
    if not due:
        return

    async with httpx.AsyncClient() as client:
        for row in due:
            try:
                await sync_one(client, row)
            except Exception:
                # A bug in sync_one itself must not kill the loop or lose the row - it stays
                # Not Synced (no mark_sync_failure call here means sync_attempts isn't even
                # incremented, so this is retried plainly next pass, same as a fresh row).
                logger.exception("Unexpected error syncing delivery %s", row["bot_delivery_id"])


async def run_forever() -> None:
    import asyncio

    logger.info(
        "Sync worker started (interval=%ss, batch=%s, max_attempts=%s)",
        SYNC_INTERVAL_SECONDS, SYNC_BATCH_SIZE, SYNC_MAX_ATTEMPTS,
    )
    while True:
        try:
            await run_once()
        except Exception:
            logger.exception("Sync worker pass failed unexpectedly")
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)
