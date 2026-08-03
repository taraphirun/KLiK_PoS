"""
HD Delivery Telegram Bot — FSM-based delivery reporting
========================================================
Drivers interact via private chat to log deliveries through a structured
conversation flow. KlikPOS (Frappe) is the sole system of record for driver
identity/status and delivery data (Postgres/Redis-as-DB/MinIO retired at
cutover, Todo 036, 2026-08-03) - the bot's own config comes from .env, and
delivery capture goes to the local SQLite outbox (local_store.py), synced to
KlikPOS by sync_worker.py. Redis is still used, but only for aiogram's own
FSM state storage (RedisStorage) and photo-album batching, not as a database.

Requires: aiogram 3.x, tzdata, python-dotenv
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import html
from datetime import datetime, timezone as dt_timezone, timedelta
from typing import Any
import uuid

from dotenv import load_dotenv

# Must run before importing any local module that reads KLIKPOS_* env vars at import time
# (klikpos_client.py, imported transitively by driver_sync/sync_worker below) - otherwise those
# module-level os.getenv() calls run against an environment .env hasn't been loaded into yet,
# freezing them as empty strings for the life of the process. Found 2026-08-01: this silently
# broke both the delivery sync worker and the driver push/poll - no error, no attempts logged,
# just a quiet no-op every pass (klikpos_client.is_configured() returning False took the early-
# return branch in both run_once() and poll_klikpos_status()).
load_dotenv()

import httpx

import booklet_sync
import driver_sync
import klikpos_client
import local_store
import sync_worker

from aiogram import Bot, Dispatcher, F, Router, types
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.fsm.storage.redis import RedisStorage
from redis.asyncio import Redis
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaPhoto,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)

# ─────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("delivery-bot")

# ─────────────────────────────────────────────────────────────────
# Configuration (env vars only, post-Todo-036 - no more Postgres SystemSetting table)
# ─────────────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("DELIVERY_BOT_TOKEN", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

# Comma-separated Telegram user IDs who get admin commands (/syncstatus) and registration
# approval DMs - replaces the old Postgres public."User" WHERE role='ADMIN' lookup.
ADMIN_TELEGRAM_IDS = {
    int(v) for v in os.getenv("ADMIN_TELEGRAM_IDS", "").split(",") if v.strip().isdigit()
}

REPORTING_CHAT_ID = os.getenv("REPORTING_CHAT_ID") or None
_REPORTING_TOPIC_ID_RAW = os.getenv("REPORTING_TOPIC_ID")
REPORTING_TOPIC_ID = int(_REPORTING_TOPIC_ID_RAW) if _REPORTING_TOPIC_ID_RAW else None
LOCAL_TZ = os.getenv("LOCAL_TZ", "Asia/Phnom_Penh")


# ─────────────────────────────────────────────────────────────────
# FSM States
# ─────────────────────────────────────────────────────────────────

class RegistrationFlow(StatesGroup):
    AWAITING_NAME = State()
    AWAITING_PHONE = State()


class DeliveryFlow(StatesGroup):
    AWAITING_INVOICE = State()
    AWAITING_COMPLETION_STATUS = State()
    AWAITING_PAYMENT_STATUS = State()
    AWAITING_PHOTOS = State()
    AWAITING_VOICE_NOTE = State()


# ─────────────────────────────────────────────────────────────────
# Globals (set during startup)
# ─────────────────────────────────────────────────────────────────
redis_client: Redis | None = None
# Allowed driver set: { telegram_user_id (int) } - loaded from KlikPOS at startup, kept current by
# driver_poll_loop's background poll and by registration/approval actions below.
allowed_drivers: set[int] = set()
# Photo album batching
pending_photo_batches: dict[str, dict[str, Any]] = {}

router = Router()

# ─────────────────────────────────────────────────────────────────
# Config/driver helpers (env vars + KlikPOS API - no local database, Todo 036)
# ─────────────────────────────────────────────────────────────────


async def load_allowed_drivers() -> set[int]:
    """Load active driver Telegram IDs from KlikPOS's Delivery Driver list."""
    if not klikpos_client.is_configured():
        logger.warning("KlikPOS not configured - starting with an empty allowed-drivers set")
        return set()

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                klikpos_client.method_url("klik_pos.api.driver.list_drivers"),
                headers=klikpos_client.headers(),
                params={"status": "Active", "limit": 200},
                timeout=15,
            )
            response.raise_for_status()
            body = response.json().get("message", {})
    except Exception:
        logger.exception("Failed to load allowed drivers from KlikPOS")
        return set()

    if not body.get("success"):
        return set()

    ids: set[int] = set()
    for row in body.get("data", []):
        tg_id = row.get("telegram_user_id")
        if tg_id:
            try:
                ids.add(int(tg_id))
            except (TypeError, ValueError):
                continue
    logger.info("Loaded %d allowed drivers from KlikPOS", len(ids))
    return ids


# ─────────────────────────────────────────────────────────────────
# Keyboard helpers
# ─────────────────────────────────────────────────────────────────

def main_menu_keyboard() -> ReplyKeyboardMarkup:
    """Persistent reply keyboard with the location trigger button."""
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📍 Start Delivery Upload", request_location=True)]],
        resize_keyboard=True,
    )


async def send_main_menu(target: types.Message | CallbackQuery, text: str = "Ready for the next delivery!") -> None:
    """Send the main menu keyboard."""
    if isinstance(target, CallbackQuery):
        await target.message.answer(text, reply_markup=main_menu_keyboard())
    else:
        await target.answer(text, reply_markup=main_menu_keyboard())


# ─────────────────────────────────────────────────────────────────
# /start command
# ─────────────────────────────────────────────────────────────────

@router.message(Command("start"))
async def cmd_start(message: types.Message, state: FSMContext) -> None:
    await state.clear()
    user_id = message.from_user.id

    # Check if already an active driver
    if user_id in allowed_drivers:
        await send_main_menu(message, "Welcome back! Tap the button below to start a delivery upload.")
        return

    # Check if pending/rejected - read-only lookup against KlikPOS, doesn't create anything
    # (Todo 036: KlikPOS is the sole driver system of record).
    async with httpx.AsyncClient() as client:
        driver = await driver_sync.find_driver_by_telegram_id(client, str(user_id))

    if driver and driver.get("status") == "Pending":
        await message.answer("⏳ Your registration is pending admin approval. You'll be notified once approved.")
        return
    if driver and driver.get("status") == "Rejected":
        await message.answer("❌ Your registration was not approved. Contact an administrator for details.")
        return

    await message.answer(
        "👋 Welcome to HD Delivery Bot!\n\n"
        "You're not registered as a driver yet. Use /register to request access.",
        reply_markup=ReplyKeyboardRemove(),
    )


# ─────────────────────────────────────────────────────────────────
# /cancel command
# ─────────────────────────────────────────────────────────────────

@router.message(Command("cancel"))
async def cmd_cancel(message: types.Message, state: FSMContext) -> None:
    current = await state.get_state()
    await state.clear()
    if current:
        await send_main_menu(message, "❌ Operation cancelled.")
    else:
        await send_main_menu(message, "Nothing to cancel. Ready when you are!")


# ─────────────────────────────────────────────────────────────────
# /syncstatus command — KlikPOS sync health (Module 14 / Todo 034)
# ─────────────────────────────────────────────────────────────────

@router.message(Command("syncstatus"))
async def cmd_syncstatus(message: types.Message) -> None:
    user_id = message.from_user.id
    if user_id not in ADMIN_TELEGRAM_IDS:
        await message.answer("🚫 Admins only.")
        return

    counts = await local_store.status_counts()
    not_synced = counts.get("Not Synced", 0)
    synced = counts.get("Synced", 0)
    failed = counts.get("Failed", 0)

    text = (
        f"📡 <b>KlikPOS Sync Status</b>\n\n"
        f"⏳ Pending: {not_synced}\n"
        f"✅ Synced: {synced}\n"
        f"❌ Failed (needs attention): {failed}"
    )

    if failed:
        rows = await local_store.fetch_failed(limit=5)
        text += "\n\nMost recent failures:\n"
        for row in rows:
            text += (
                f"• {html.escape(row['reported_invoice_no'])} "
                f"({html.escape(row['last_sync_error'] or 'unknown error')})\n"
            )

    await message.answer(text)


# ─────────────────────────────────────────────────────────────────
# /register command — Registration FSM
# ─────────────────────────────────────────────────────────────────

@router.message(Command("register"))
async def cmd_register(message: types.Message, state: FSMContext) -> None:
    user_id = message.from_user.id

    # Already registered?
    if user_id in allowed_drivers:
        await message.answer("✅ You're already registered! Use /start to begin.")
        return

    # Already pending? Read-only lookup against KlikPOS (Todo 036).
    async with httpx.AsyncClient() as client:
        driver = await driver_sync.find_driver_by_telegram_id(client, str(user_id))

    if driver and driver.get("status") == "Pending":
        await message.answer("⏳ Your registration is already pending approval.")
        return
    if driver and driver.get("status") == "Active":
        # Somehow not in our cache — reload
        allowed_drivers.add(user_id)
        await message.answer("✅ You're already registered! Use /start to begin.")
        return

    await state.set_state(RegistrationFlow.AWAITING_NAME)
    await message.answer(
        "📝 Let's get you registered!\n\nWhat is your full name?",
        reply_markup=ReplyKeyboardRemove(),
    )


@router.message(RegistrationFlow.AWAITING_NAME, F.text)
async def registration_name(message: types.Message, state: FSMContext) -> None:
    await state.update_data(reg_name=message.text.strip())
    await state.set_state(RegistrationFlow.AWAITING_PHONE)

    # Phone contact button
    kb = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="📱 Share Phone Number", request_contact=True)]],
        resize_keyboard=True,
        one_time_keyboard=True,
    )
    await message.answer("📱 Please share your phone number:", reply_markup=kb)


@router.message(RegistrationFlow.AWAITING_PHONE, F.contact)
async def registration_phone(message: types.Message, state: FSMContext) -> None:
    data = await state.get_data()
    driver_name = data["reg_name"]
    phone = message.contact.phone_number
    if phone.startswith("+"):
        phone = phone[1:]

    user_id = message.from_user.id
    username = f"@{message.from_user.username}" if message.from_user.username else None

    # Create the Pending driver directly in KlikPOS (Todo 036: sole system of record, no local
    # Driver table anymore) - matched by telegram_user_id since there's no local bot_driver_id to
    # generate. Best-effort must not block registration if KlikPOS happens to be unreachable right
    # now - the driver still gets a "submitted" reply either way; an admin can always fall back to
    # KlikPOS's own /drivers page to add them if this push failed.
    async with httpx.AsyncClient() as client:
        await driver_sync.push_driver_to_klikpos(
            client,
            bot_driver_id=None,
            driver_name=driver_name,
            telegram_user_id=str(user_id),
            telegram_username=username,
            chat_id=str(message.chat.id),
            phone_number=phone,
        )

    await state.clear()
    await message.answer(
        "✅ Registration submitted! An admin will review your request.\n"
        "You'll receive a notification once approved.",
        reply_markup=ReplyKeyboardRemove(),
    )

    # DM all admins with approve/reject
    approve_kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ Approve", callback_data=f"reg_approve:{user_id}"),
            InlineKeyboardButton(text="❌ Reject", callback_data=f"reg_reject:{user_id}"),
        ]
    ])
    admin_msg = (
        f"🆕 <b>New Driver Registration</b>\n\n"
        f"<b>Name:</b> {html.escape(driver_name)}\n"
        f"<b>Phone:</b> {html.escape(phone)}\n"
        f"<b>Telegram ID:</b> {user_id}\n"
        f"<b>Username:</b> {html.escape(username or 'N/A')}"
    )

    if not ADMIN_TELEGRAM_IDS:
        logger.warning("No ADMIN_TELEGRAM_IDS configured — no one to notify about registration!")

    bot_instance = message.bot
    for admin_id in ADMIN_TELEGRAM_IDS:
        try:
            await bot_instance.send_message(admin_id, admin_msg, parse_mode=ParseMode.HTML, reply_markup=approve_kb)
            logger.info("Sent registration DM to admin %d", admin_id)
        except Exception as e:
            logger.warning("Failed to DM admin %d: %s", admin_id, e)


@router.message(RegistrationFlow.AWAITING_PHONE)
async def registration_phone_invalid(message: types.Message) -> None:
    await message.answer("Please use the button below to share your phone number.")


@router.message(RegistrationFlow.AWAITING_NAME)
async def registration_name_invalid(message: types.Message) -> None:
    await message.answer("Please send your name as a text message.")


# ─────────────────────────────────────────────────────────────────
# Registration approval callbacks
# ─────────────────────────────────────────────────────────────────

@router.callback_query(F.data.startswith("reg_approve:"))
async def cb_reg_approve(callback: CallbackQuery) -> None:
    await callback.answer()
    driver_tg_id = int(callback.data.split(":")[1])

    allowed_drivers.add(driver_tg_id)
    await callback.message.edit_text(callback.message.text + "\n\n✅ <b>APPROVED</b>", parse_mode=ParseMode.HTML)

    # Push the status straight to KlikPOS (Todo 036) - identity (name/username/chat_id) was
    # already pushed at registration time, so this only needs the docname, found by
    # telegram_user_id since the approve button's callback_data only carries that.
    async with httpx.AsyncClient() as client:
        driver_row = await driver_sync.find_driver_by_telegram_id(client, str(driver_tg_id))
        if driver_row:
            await driver_sync.push_status_to_klikpos(client, driver_row["name"], "Active")
        else:
            logger.warning("Approved driver %d but no matching KlikPOS Delivery Driver found", driver_tg_id)

    # Notify the driver
    try:
        await callback.bot.send_message(
            driver_tg_id,
            "🎉 Your registration has been approved! Send /start to begin using the bot.",
        )
    except Exception as e:
        logger.warning("Failed to notify approved driver %d: %s", driver_tg_id, e)


@router.callback_query(F.data.startswith("reg_reject:"))
async def cb_reg_reject(callback: CallbackQuery) -> None:
    await callback.answer()
    driver_tg_id = int(callback.data.split(":")[1])

    allowed_drivers.discard(driver_tg_id)
    await callback.message.edit_text(callback.message.text + "\n\n❌ <b>REJECTED</b>", parse_mode=ParseMode.HTML)

    async with httpx.AsyncClient() as client:
        driver_row = await driver_sync.find_driver_by_telegram_id(client, str(driver_tg_id))
        if driver_row:
            await driver_sync.push_status_to_klikpos(client, driver_row["name"], "Rejected")
        else:
            logger.warning("Rejected driver %d but no matching KlikPOS Delivery Driver found", driver_tg_id)

    try:
        await callback.bot.send_message(
            driver_tg_id,
            "❌ Your registration was not approved. Contact an administrator for details.",
        )
    except Exception as e:
        logger.warning("Failed to notify rejected driver %d: %s", driver_tg_id, e)


# ─────────────────────────────────────────────────────────────────
# Delivery Flow — Step 0: Location trigger
# ─────────────────────────────────────────────────────────────────

@router.message(StateFilter(None), F.location)
async def delivery_location(message: types.Message, state: FSMContext) -> None:
    user_id = message.from_user.id

    if user_id not in allowed_drivers:
        async with httpx.AsyncClient() as client:
            driver = await driver_sync.find_driver_by_telegram_id(client, str(user_id))
        if driver and driver.get("status") == "Active":
            allowed_drivers.add(user_id)
        else:
            await message.answer("🚫 You're not authorized. Use /register to request access.")
            return

    delivery_uuid = str(uuid.uuid4())
    lat = message.location.latitude
    lon = message.location.longitude
    # RedisStorage (dp's FSM storage, see main()) already persists this across restarts - no
    # separate delivery_drafts write needed (Todo 036 retired that redundant Postgres copy).
    await state.update_data(delivery_uuid=delivery_uuid, latitude=lat, longitude=lon, photo_file_ids=[])

    logger.info("Driver %d shared location: (%f, %f) uuid=%s", user_id, lat, lon, delivery_uuid)

    await state.set_state(DeliveryFlow.AWAITING_INVOICE)
    await message.answer(
        "📍 Location secured! Please enter the Invoice Number.",
        reply_markup=ReplyKeyboardRemove(),
    )


# ─────────────────────────────────────────────────────────────────
# Step 1: Invoice number
# ─────────────────────────────────────────────────────────────────

@router.message(DeliveryFlow.AWAITING_INVOICE, F.text)
async def delivery_invoice(message: types.Message, state: FSMContext) -> None:
    await state.update_data(invoice_number=message.text.strip())
    await state.set_state(DeliveryFlow.AWAITING_COMPLETION_STATUS)

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="✅ All Delivered", callback_data="status_full"),
            InlineKeyboardButton(text="⚠️ Missing Product", callback_data="status_partial"),
        ]
    ])
    await message.answer("Was everything delivered?", reply_markup=kb)


@router.message(DeliveryFlow.AWAITING_INVOICE)
async def delivery_invoice_invalid(message: types.Message) -> None:
    await message.answer("⚠️ Please enter the invoice number as text.")


# ─────────────────────────────────────────────────────────────────
# Step 2: Completion status
# ─────────────────────────────────────────────────────────────────

@router.callback_query(DeliveryFlow.AWAITING_COMPLETION_STATUS, F.data.in_({"status_full", "status_partial"}))
async def delivery_completion(callback: CallbackQuery, state: FSMContext) -> None:
    await callback.answer()
    status = "Full" if callback.data == "status_full" else "Partial"
    await state.update_data(completion_status=status)

    label = "✅ All Delivered" if status == "Full" else "⚠️ Missing Product"
    await callback.message.edit_text(f"Completion: <b>{label}</b>", parse_mode=ParseMode.HTML)

    await state.set_state(DeliveryFlow.AWAITING_PAYMENT_STATUS)

    kb = InlineKeyboardMarkup(inline_keyboard=[
        [
            InlineKeyboardButton(text="🟢 Paid", callback_data="pay_paid"),
            InlineKeyboardButton(text="🔴 Unpaid", callback_data="pay_unpaid"),
            InlineKeyboardButton(text="🟡 Partial", callback_data="pay_partial"),
        ]
    ])
    await callback.message.answer("Payment Status?", reply_markup=kb)


# ─────────────────────────────────────────────────────────────────
# Step 3: Payment status
# ─────────────────────────────────────────────────────────────────

@router.callback_query(DeliveryFlow.AWAITING_PAYMENT_STATUS, F.data.in_({"pay_paid", "pay_unpaid", "pay_partial"}))
async def delivery_payment(callback: CallbackQuery, state: FSMContext) -> None:
    await callback.answer()
    pay_map = {"pay_paid": "Paid", "pay_unpaid": "Unpaid", "pay_partial": "Partial"}
    payment = pay_map[callback.data]
    await state.update_data(payment_status=payment)

    label_map = {"Paid": "🟢 Paid", "Unpaid": "🔴 Unpaid", "Partial": "🟡 Partial"}
    await callback.message.edit_text(f"Payment: <b>{label_map[payment]}</b>", parse_mode=ParseMode.HTML)

    await state.set_state(DeliveryFlow.AWAITING_PHOTOS)
    await callback.message.answer("📸 Please upload the delivery and invoice photos now.")


# ─────────────────────────────────────────────────────────────────
# Step 4: Photos (album debounce)
# ─────────────────────────────────────────────────────────────────

async def flush_photo_batch(batch_key: str, state: FSMContext, bot: Bot, chat_id: int) -> None:
    """Flush a photo batch after the debounce window."""
    await asyncio.sleep(2.0)

    if not redis_client:
        return
    redis_key = f"photo_batch:{batch_key}"
    import json
    raw = await redis_client.get(redis_key)
    if not raw:
        return
    
    await redis_client.delete(redis_key)
    batch = json.loads(raw)
    file_ids = batch["file_ids"]
    n = len(file_ids)
    logger.info("Photo batch '%s' flushed with %d photo(s)", batch_key, n)

    # Append to FSM running list
    data = await state.get_data()
    existing = data.get("photo_file_ids", [])
    existing.extend(file_ids)
    await state.update_data(photo_file_ids=existing)

    total = len(existing)
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="✅ Done with Photos", callback_data="photos_done")]
    ])
    await bot.send_message(
        chat_id,
        f"📸 Got {n} photo(s) — {total} total so far. Send more, or tap Done.",
        reply_markup=kb,
    )


@router.message(DeliveryFlow.AWAITING_PHOTOS, F.photo)
async def delivery_photo(message: types.Message, state: FSMContext) -> None:
    photo = message.photo[-1]  # highest resolution
    file_id = photo.file_id
    media_group_id = message.media_group_id
    batch_key = media_group_id or f"single_{message.message_id}"
    redis_key = f"photo_batch:{batch_key}"

    import json
    if not redis_client:
        return
    
    raw = await redis_client.get(redis_key)
    if raw:
        batch = json.loads(raw)
        batch["file_ids"].append(file_id)
        await redis_client.set(redis_key, json.dumps(batch))
        logger.debug("Photo batch '%s' extended (%d photos)", batch_key, len(batch["file_ids"]))
    else:
        batch = {"file_ids": [file_id], "chat_id": message.chat.id, "user_id": message.from_user.id}
        await redis_client.set(redis_key, json.dumps(batch))
        logger.debug("Photo batch '%s' opened", batch_key)
        # Schedule flush only on first item (simple debounce)
        asyncio.create_task(flush_photo_batch(batch_key, state, message.bot, message.chat.id))

async def recover_orphaned_photo_batches(bot: Bot, dp: Dispatcher) -> None:
    """Flush any photo batches left in Redis due to a restart."""
    if not redis_client:
        return
    import json
    keys = await redis_client.keys("photo_batch:*")
    for key in keys:
        raw = await redis_client.get(key)
        if raw:
            batch = json.loads(raw)
            chat_id = batch["chat_id"]
            user_id = batch["user_id"]
            batch_key = key.decode("utf-8").split(":", 1)[1] if isinstance(key, bytes) else key.split(":", 1)[1]
            
            # Recreate state context
            state = FSMContext(storage=dp.storage, key=dp.storage.resolve_address(bot=bot, chat_id=chat_id, user_id=user_id))
            asyncio.create_task(flush_photo_batch(batch_key, state, bot, chat_id))



@router.callback_query(DeliveryFlow.AWAITING_PHOTOS, F.data == "photos_done")
async def delivery_photos_done(callback: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    photos = data.get("photo_file_ids", [])

    if not photos:
        await callback.answer("⚠️ No photos received yet! Send at least one.", show_alert=True)
        return

    await callback.answer()
    await callback.message.edit_text(f"📸 {len(photos)} photo(s) collected.")

    await state.set_state(DeliveryFlow.AWAITING_VOICE_NOTE)

    completion = data.get("completion_status", "Full")
    if completion == "Full":
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="⏩ Skip Voice Note", callback_data="skip_voice")]
        ])
        await callback.message.answer(
            "🎙️ Hold the mic to add notes, or tap Skip.",
            reply_markup=kb,
        )
    else:
        await callback.message.answer(
            "⚠️ You flagged a missing product. Please send a voice note explaining what is missing."
        )


@router.message(DeliveryFlow.AWAITING_PHOTOS)
async def delivery_photos_invalid(message: types.Message) -> None:
    await message.answer("📸 Please send photos, or tap ✅ Done with Photos when finished.")


# ─────────────────────────────────────────────────────────────────
# Step 5: Voice note & finalize
# ─────────────────────────────────────────────────────────────────

@router.message(DeliveryFlow.AWAITING_VOICE_NOTE, F.voice)
async def delivery_voice(message: types.Message, state: FSMContext) -> None:
    await state.update_data(voice_note_file_id=message.voice.file_id)
    await finalize_delivery(message, state)


@router.callback_query(DeliveryFlow.AWAITING_VOICE_NOTE, F.data == "skip_voice")
async def delivery_skip_voice(callback: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()

    # Only allow skip if completion was Full
    if data.get("completion_status") == "Partial":
        await callback.answer("⚠️ Voice note is required for partial deliveries.", show_alert=True)
        return

    await callback.answer()
    await callback.message.edit_text("⏩ Voice note skipped.")
    await state.update_data(voice_note_file_id=None)
    await finalize_delivery(callback, state)


@router.message(DeliveryFlow.AWAITING_VOICE_NOTE)
async def delivery_voice_invalid(message: types.Message, state: FSMContext) -> None:
    data = await state.get_data()
    if data.get("completion_status") == "Partial":
        await message.answer("⚠️ Please send a voice note explaining the missing product.")
    else:
        await message.answer("🎙️ Please send a voice note, or tap ⏩ Skip.")


# ─────────────────────────────────────────────────────────────────
# Finalize: outbox insert + group forwarding
# ─────────────────────────────────────────────────────────────────

# upload_photos_to_minio()/recover_pending_uploads() were retired at cutover (Todo 036, 2026-08-03)
# - photo delivery to KlikPOS is fully covered by download_media_locally() below (writes to local
# disk at finalize time) + sync_worker.py's upload_delivery_file/attach_delivery_media, which don't
# need MinIO at all.


async def download_media_locally(
    bot: Bot, delivery_uuid: str, photo_file_ids: list[str], voice_note_file_id: str | None
) -> tuple[list[str], str | None]:
    """Download Telegram file(s) to local disk for the SQLite outbox (Module 14 / Todo 033/035).

    Done synchronously in finalize_delivery, not deferred to sync time: the bot already has a
    live Telegram connection at this point (it's mid-conversation), so this doesn't compromise
    offline-first (that guarantee is about KlikPOS/network-to-Frappe reachability, not Telegram
    itself - the bot can't do anything at all without a live Telegram connection regardless).
    Downloading now, once, means the sync worker later only ever deals with local files, never
    Telegram file_ids that could theoretically go stale.
    """
    delivery_media_dir = os.path.join(local_store.MEDIA_DIR, delivery_uuid)
    os.makedirs(delivery_media_dir, exist_ok=True)

    photo_paths: list[str] = []
    for index, file_id in enumerate(photo_file_ids):
        dest_path = os.path.join(delivery_media_dir, f"photo_{index}.jpg")
        await bot.download(file=file_id, destination=dest_path)
        photo_paths.append(dest_path)

    voice_path: str | None = None
    if voice_note_file_id:
        voice_path = os.path.join(delivery_media_dir, "voice.ogg")
        await bot.download(file=voice_note_file_id, destination=voice_path)

    return photo_paths, voice_path


async def driver_poll_loop(bot: Bot) -> None:
    """Background loop wrapper for driver_sync.poll_klikpos_status (Phase 10 addendum) - lives
    here rather than in driver_sync.py so it can close over this module's allowed_drivers global
    without a circular import."""
    logger.info("Driver status poll started (interval=%ss)", driver_sync.DRIVER_POLL_INTERVAL_SECONDS)
    while True:
        try:
            await driver_sync.poll_klikpos_status(bot, allowed_drivers)
        except Exception:
            logger.exception("Driver poll pass failed unexpectedly")
        await asyncio.sleep(driver_sync.DRIVER_POLL_INTERVAL_SECONDS)


async def booklet_poll_loop(bot: Bot) -> None:
    """Background loop wrapper for booklet_sync.poll_klikpos_booklets (Module 16) - same shape as
    driver_poll_loop above. Admin IDs and reporting chat config are now static env vars
    (Todo 036), not DB-backed - a change to either needs a bot restart to take effect, unlike
    before this cutover."""
    logger.info("Booklet status poll started (interval=%ss)", booklet_sync.BOOKLET_POLL_INTERVAL_SECONDS)
    while True:
        try:
            await booklet_sync.poll_klikpos_booklets(bot, ADMIN_TELEGRAM_IDS, REPORTING_CHAT_ID, REPORTING_TOPIC_ID)
        except Exception:
            logger.exception("Booklet poll pass failed unexpectedly")
        await asyncio.sleep(booklet_sync.BOOKLET_POLL_INTERVAL_SECONDS)


async def finalize_delivery(source: types.Message | CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    bot = source.bot if isinstance(source, types.Message) else source.message.bot
    user = source.from_user

    # Validation
    required_keys = ["invoice_number", "completion_status", "payment_status", "latitude", "longitude", "delivery_uuid"]
    missing = [k for k in required_keys if k not in data]
    if missing:
        msg = "⚠️ Delivery session is incomplete or expired. Please start over using /start."
        if isinstance(source, CallbackQuery):
            await source.message.answer(msg)
        else:
            await source.answer(msg)
        await state.clear()
        return

    driver_id = user.id
    driver_name = user.full_name
    now_utc = datetime.now(dt_timezone.utc)

    delivery_uuid = data["delivery_uuid"]
    invoice_number = data["invoice_number"]
    completion_status = data["completion_status"]
    payment_status = data["payment_status"]
    photo_file_ids = data.get("photo_file_ids", [])
    voice_note_file_id = data.get("voice_note_file_id")
    latitude = data["latitude"]
    longitude = data["longitude"]

    # 1. Download media to local disk, then write the SQLite outbox row FIRST (Module 14 / Todo
    # 033) - this is what makes capture offline-first: it must succeed independent of whether
    # Postgres/KlikPOS are reachable, so nothing below this point is allowed to gate it.
    try:
        photo_paths, voice_path = await download_media_locally(
            bot, delivery_uuid, photo_file_ids, voice_note_file_id
        )
    except Exception:
        logger.exception("Failed to download media from Telegram for delivery %s", delivery_uuid)
        error_text = "⚠️ Unable to download your photos/voice note right now. Please try again."
        if isinstance(source, CallbackQuery):
            await source.message.answer(error_text)
        else:
            await source.answer(error_text)
        return

    try:
        inserted = await local_store.insert_delivery(
            bot_delivery_id=delivery_uuid,
            reported_invoice_no=invoice_number,
            completion_status=completion_status,
            payment_status=payment_status,
            latitude=latitude,
            longitude=longitude,
            driver_id=driver_id,
            driver_name=driver_name,
            timestamp=now_utc,
            photo_paths=photo_paths,
            voice_path=voice_path,
        )
    except Exception:
        logger.exception("Failed to write delivery %s to local outbox", delivery_uuid)
        error_text = "⚠️ Unable to save delivery right now. Please try again."
        if isinstance(source, CallbackQuery):
            await source.message.answer(error_text)
        else:
            await source.answer(error_text)
        return

    if not inserted:
        logger.info("Duplicate submission prevented for delivery_uuid %s", delivery_uuid)
        reply_text = f"✅ Delivery for Invoice #{html.escape(invoice_number)} was already logged!"
        if isinstance(source, CallbackQuery):
            await source.message.answer(reply_text)
        else:
            await source.answer(reply_text)
        await state.clear()
        await send_main_menu(source)
        return

    # Legacy Postgres dual-write (delivery_bot.delivery_logs + public.Invoice), which fed the
    # NestJS dashboard during the Module 14 transition, was retired at cutover (Todo 036,
    # 2026-08-03) - the outbox insert above is now the sole capture point, and sync_worker.py
    # drains it to KlikPOS in the background.

    logger.info(
        "Delivery logged: invoice=%s driver=%s(%d) photos=%d voice=%s",
        invoice_number, driver_name, driver_id, len(photo_file_ids),
        "yes" if voice_note_file_id else "no",
    )

    # 2. Forward to group chat
    try:
        chat_id, topic_id = REPORTING_CHAT_ID, REPORTING_TOPIC_ID
        if chat_id:
            try:
                from zoneinfo import ZoneInfo
                local_time = now_utc.astimezone(ZoneInfo(LOCAL_TZ))
            except Exception:
                local_time = now_utc

            time_str = local_time.strftime("%Y-%m-%d %H:%M")

            text_msg = (
                f"📦 <b>#{html.escape(invoice_number)} Delivered</b>\n"
                f"<b>Completion Status:</b> {html.escape(completion_status)}\n"
                f"<b>Payment Status:</b> {html.escape(payment_status)}\n"
                f"<b>Driver:</b> {html.escape(driver_name)}\n"
                f"<b>Time:</b> {time_str}"
            )

            kwargs: dict[str, Any] = {}
            if topic_id:
                kwargs["message_thread_id"] = topic_id

            await bot.send_message(
                chat_id, text_msg, parse_mode=ParseMode.HTML, **kwargs,
            )

            # Voice note
            if voice_note_file_id:
                await bot.send_voice(
                    chat_id, voice_note_file_id,
                    caption="🎙️ Voice note attached below for review:",
                    **kwargs,
                )

            # Photos
            if len(photo_file_ids) == 1:
                await bot.send_photo(chat_id, photo_file_ids[0], **kwargs)
            elif len(photo_file_ids) >= 2:
                media = [InputMediaPhoto(media=fid) for fid in photo_file_ids]
                await bot.send_media_group(chat_id, media, **kwargs)
        else:
            logger.warning("No REPORTING_CHAT_ID configured — skipping group forward")
    except Exception:
        logger.exception("Failed to forward delivery to group chat (data already saved to DB)")

    # 3. Reply to driver
    reply_text = f"✅ Delivery for Invoice #{html.escape(invoice_number)} successfully logged!"
    if isinstance(source, CallbackQuery):
        await source.message.answer(reply_text)
    else:
        await source.answer(reply_text)

    # 4. Clear state and show main menu
    await state.clear()
    if isinstance(source, CallbackQuery):
        await send_main_menu(source)
    else:
        await send_main_menu(source)


# ─────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────

async def main() -> None:
    global allowed_drivers, redis_client

    # 1. Local SQLite outbox (Module 14 / Todo 033) - the bot's only local datastore post-Todo 036.
    await local_store.init_db()

    # 2. Create Redis with resilience options - FSM state storage + photo-album batching only
    # (Todo 036: no longer used as a database).
    redis_client = Redis.from_url(
        REDIS_URL,
        health_check_interval=30,
        socket_keepalive=True,
        retry_on_timeout=True,
    )

    # 3. Load driver allow-list from KlikPOS
    allowed_drivers = await load_allowed_drivers()

    # 4. Resolve bot token - env var only (Todo 036: no more DB-backed Settings page fallback/wait
    # loop). Fail fast with a clear error rather than silently hanging.
    if not BOT_TOKEN or BOT_TOKEN == "YOUR_BOT_TOKEN_HERE":
        logger.error("No bot token configured! Set DELIVERY_BOT_TOKEN in .env.")
        return

    # 5. Create bot and dispatcher
    bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=RedisStorage(redis_client, state_ttl=timedelta(hours=24), data_ttl=timedelta(hours=24)))
    dp.include_router(router)

    # 6. Recover orphaned photo batches
    await recover_orphaned_photo_batches(bot, dp)

    # 7. Start the KlikPOS sync worker (Module 14 / Todo 034/035) - drains the local outbox in
    # the background for the lifetime of the process.
    sync_task = asyncio.create_task(sync_worker.run_forever())

    # 8. Start the KlikPOS driver status poll (Phase 10 addendum) - makes an approval/rejection
    # made from KlikPOS's own /drivers page actually reach the bot.
    driver_poll_task = asyncio.create_task(driver_poll_loop(bot))

    # 9. Start the KlikPOS booklet lifecycle poll (Module 16) - makes a booklet stalling or
    # becoming ready-for-review (computed hourly on the KlikPOS side) actually reach Telegram.
    booklet_poll_task = asyncio.create_task(booklet_poll_loop(bot))

    logger.info("Bot starting in polling mode...")
    logger.info("NOTE: RedisStorage is active. In-progress flows are preserved across restarts.")

    try:
        await dp.start_polling(bot)
    finally:
        logger.info("Shutting down...")
        sync_task.cancel()
        driver_poll_task.cancel()
        booklet_poll_task.cancel()
        if redis_client:
            await redis_client.close()
            logger.info("Redis client closed")


if __name__ == "__main__":
    asyncio.run(main())
