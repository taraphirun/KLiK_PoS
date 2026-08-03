"""SQLite outbox for offline-first delivery capture (Module 14 / Todo 033).

Every delivery finalized by the FSM (bot.py's finalize_delivery) is written here immediately,
independent of KlikPOS reachability - this table is the durable capture store the sync worker
(sync_worker.py, Todo 034) drains. The Postgres dual-write (delivery_bot.delivery_logs +
public.Invoice, kept temporarily to feed the NestJS dashboard during the Module 14 transition) was
retired at cutover (Todo 036, 2026-08-03) - this file is now the sole durable store for delivery
capture, and (via driver_status below) also owns driver-status transition tracking that used to
live in Postgres's public.Driver table.

WAL mode + a fresh connection per call (rather than one long-lived connection) - aiogram handlers
run concurrently across drivers, and WAL mode is what lets concurrent readers/writers coexist
without "database is locked" errors (see Todo 033's concurrency risk note).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone as dt_timezone
from typing import Any

import aiosqlite

DB_PATH = os.getenv("LOCAL_STORE_PATH", os.path.join(os.path.dirname(__file__), "deliveries.sqlite"))
MEDIA_DIR = os.getenv("LOCAL_MEDIA_DIR", os.path.join(os.path.dirname(__file__), "media"))

os.makedirs(MEDIA_DIR, exist_ok=True)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS outbox (
    bot_delivery_id     TEXT PRIMARY KEY,
    reported_invoice_no TEXT NOT NULL,
    completion_status   TEXT NOT NULL,
    payment_status      TEXT NOT NULL,
    latitude             REAL NOT NULL,
    longitude            REAL NOT NULL,
    driver_id            TEXT NOT NULL,
    driver_name          TEXT NOT NULL,
    "timestamp"          TEXT NOT NULL,
    photo_paths          TEXT NOT NULL DEFAULT '[]',
    voice_path           TEXT,
    sync_status          TEXT NOT NULL DEFAULT 'Not Synced',
    synced_delivery_report TEXT,
    last_sync_error       TEXT,
    sync_attempts         INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_sync_status ON outbox (sync_status);

CREATE TABLE IF NOT EXISTS booklet_status (
    booklet_name TEXT PRIMARY KEY,
    last_status  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_status (
    telegram_user_id TEXT PRIMARY KEY,
    last_status       TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
"""


def _now_iso() -> str:
    return datetime.now(dt_timezone.utc).isoformat()


async def init_db() -> None:
    """Call once at startup - creates the outbox/booklet_status/driver_status tables if missing."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.executescript(_SCHEMA)
        await db.commit()


async def insert_delivery(
    bot_delivery_id: str,
    reported_invoice_no: str,
    completion_status: str,
    payment_status: str,
    latitude: float,
    longitude: float,
    driver_id: int,
    driver_name: str,
    timestamp: datetime,
    photo_paths: list[str],
    voice_path: str | None,
) -> bool:
    """Write one delivery to the outbox with sync_status='Not Synced'. Must succeed even if
    KlikPOS/network is completely unreachable - this is the entire offline-first guarantee, and
    this call is the primary (now sole, post-Todo-036) source of truth for "was this delivery
    captured."

    Returns True if a new row was inserted, False if bot_delivery_id already existed (duplicate
    resubmission - ON CONFLICT DO NOTHING makes the insert itself idempotent; the return value is
    just so the caller can tell the driver "already logged" instead of "logged" a second time)."""
    now = _now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        cursor = await db.execute(
            """INSERT INTO outbox
               (bot_delivery_id, reported_invoice_no, completion_status, payment_status,
                latitude, longitude, driver_id, driver_name, "timestamp", photo_paths, voice_path,
                sync_status, sync_attempts, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Not Synced', 0, ?, ?)
               ON CONFLICT(bot_delivery_id) DO NOTHING""",
            (
                bot_delivery_id,
                reported_invoice_no,
                completion_status,
                payment_status,
                latitude,
                longitude,
                str(driver_id),
                driver_name,
                timestamp.isoformat(),
                json.dumps(photo_paths),
                voice_path,
                now,
                now,
            ),
        )
        await db.commit()
        return cursor.rowcount > 0


async def fetch_pending(limit: int = 20) -> list[dict[str, Any]]:
    """Rows the sync worker should attempt this pass. Deliberately excludes 'Failed' rows -
    those hit a permanent (validation) error and won't succeed by retrying the same payload
    forever (Todo 034: "permanent errors ... are surfaced, not retried forever"); they need a
    human to look at last_sync_error and either fix the underlying data or manually reset the row
    back to 'Not Synced' before the worker will attempt it again."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT * FROM outbox WHERE sync_status = 'Not Synced' ORDER BY created_at ASC LIMIT ?""",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def fetch_failed(limit: int = 5) -> list[dict[str, Any]]:
    """Most recent Failed rows, for the /syncstatus admin command."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """SELECT * FROM outbox WHERE sync_status = 'Failed' ORDER BY updated_at DESC LIMIT ?""",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def mark_synced(bot_delivery_id: str, delivery_report: str) -> None:
    now = _now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE outbox
               SET sync_status = 'Synced', synced_delivery_report = ?, last_sync_error = NULL,
                   updated_at = ?
               WHERE bot_delivery_id = ?""",
            (delivery_report, now, bot_delivery_id),
        )
        await db.commit()


async def mark_sync_failure(bot_delivery_id: str, error: str, permanent: bool) -> None:
    """permanent=True (validation failure, or a transient error that's exceeded the retry cap -
    see sync_worker.py) sets status Failed and stops automatic retries. permanent=False (network
    error, timeout, 5xx) keeps status Not Synced so the next worker pass retries it."""
    now = _now_iso()
    status = "Failed" if permanent else "Not Synced"
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """UPDATE outbox
               SET sync_status = ?, last_sync_error = ?, sync_attempts = sync_attempts + 1,
                   updated_at = ?
               WHERE bot_delivery_id = ?""",
            (status, error, now, bot_delivery_id),
        )
        await db.commit()


async def status_counts() -> dict[str, int]:
    """Pending vs synced vs failed counts for the /syncstatus admin command (Todo 034
    requirement)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT sync_status, COUNT(*) AS n FROM outbox GROUP BY sync_status")
        rows = await cursor.fetchall()
        return {row["sync_status"]: row["n"] for row in rows}


async def get_booklet_last_status(booklet_name: str) -> str | None:
    """Last status booklet_sync.py observed for this booklet on a prior poll - the transition
    detector's memory, persisted so a bot restart doesn't re-fire an alert for a status it already
    alerted on before going down."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT last_status FROM booklet_status WHERE booklet_name = ?", (booklet_name,)
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def set_booklet_last_status(booklet_name: str, status: str) -> None:
    now = _now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO booklet_status (booklet_name, last_status, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(booklet_name) DO UPDATE SET last_status = excluded.last_status,
                                                        updated_at = excluded.updated_at""",
            (booklet_name, status, now),
        )
        await db.commit()


async def get_driver_last_status(telegram_user_id: str) -> str | None:
    """Last KlikPOS status driver_sync.py observed for this driver on a prior poll - same
    transition-detector-memory role as get_booklet_last_status, replacing the legacy Postgres
    public.Driver row (Todo 036: KlikPOS is the sole system of record for driver status; this is
    purely local bookkeeping so a status change is only acted on/notified once, and survives a bot
    restart)."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "SELECT last_status FROM driver_status WHERE telegram_user_id = ?", (telegram_user_id,)
        )
        row = await cursor.fetchone()
        return row[0] if row else None


async def set_driver_last_status(telegram_user_id: str, status: str) -> None:
    now = _now_iso()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO driver_status (telegram_user_id, last_status, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(telegram_user_id) DO UPDATE SET last_status = excluded.last_status,
                                                            updated_at = excluded.updated_at""",
            (telegram_user_id, status, now),
        )
        await db.commit()
