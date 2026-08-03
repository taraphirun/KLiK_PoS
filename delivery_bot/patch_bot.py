import re
import os

with open("bot.py", "r") as f:
    content = f.read()

# 1. Imports
content = content.replace(
"""import html
from datetime import datetime, timezone as dt_timezone
from typing import Any""",
"""import html
from datetime import datetime, timezone as dt_timezone, timedelta
from typing import Any
import uuid"""
)

content = content.replace(
"""from aiogram.fsm.storage.memory import MemoryStorage""",
"""from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.fsm.storage.redis import RedisStorage
from redis.asyncio import Redis"""
)

# 2. Config
content = content.replace(
"""ENV_BOT_TOKEN = os.getenv("DELIVERY_BOT_TOKEN", "")""",
"""ENV_BOT_TOKEN = os.getenv("DELIVERY_BOT_TOKEN", "")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")"""
)

# 3. Globals
content = content.replace(
"""db_pool: asyncpg.Pool | None = None
# Allowed driver set""",
"""db_pool: asyncpg.Pool | None = None
redis_client: Redis | None = None
# Allowed driver set"""
)

# 4. Schema update
content = content.replace(
"""        await conn.execute(f"CREATE SCHEMA IF NOT EXISTS {DB_SCHEMA}")
        await conn.execute(f\"\"\"
            CREATE TABLE IF NOT EXISTS {DB_SCHEMA}.delivery_logs (
                id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                invoice_number      TEXT NOT NULL,
                completion_status   TEXT NOT NULL CHECK (completion_status IN ('Full', 'Partial')),
                payment_status      TEXT NOT NULL CHECK (payment_status IN ('Paid', 'Unpaid', 'Partial')),
                photo_file_ids      JSONB NOT NULL,
                voice_note_file_id  TEXT,
                latitude            DOUBLE PRECISION NOT NULL,
                longitude           DOUBLE PRECISION NOT NULL,
                driver_id           BIGINT NOT NULL,
                driver_name         TEXT NOT NULL,
                "timestamp"         TIMESTAMPTZ NOT NULL
            )
        \"\"\")
    logger.info("Schema %s and delivery_logs table ensured", DB_SCHEMA)""",
"""        await conn.execute(f"CREATE SCHEMA IF NOT EXISTS {DB_SCHEMA}")
        await conn.execute(f"DROP TABLE IF EXISTS {DB_SCHEMA}.delivery_logs CASCADE")
        await conn.execute(f"DROP TABLE IF EXISTS {DB_SCHEMA}.delivery_drafts CASCADE")
        await conn.execute(f\"\"\"
            CREATE TABLE {DB_SCHEMA}.delivery_logs (
                id                  UUID PRIMARY KEY,
                invoice_number      TEXT NOT NULL,
                completion_status   TEXT NOT NULL CHECK (completion_status IN ('Full', 'Partial')),
                payment_status      TEXT NOT NULL CHECK (payment_status IN ('Paid', 'Unpaid', 'Partial')),
                photo_file_ids      JSONB NOT NULL,
                voice_note_file_id  TEXT,
                latitude            DOUBLE PRECISION NOT NULL,
                longitude           DOUBLE PRECISION NOT NULL,
                driver_id           BIGINT NOT NULL,
                driver_name         TEXT NOT NULL,
                "timestamp"         TIMESTAMPTZ NOT NULL
            )
        \"\"\")
        await conn.execute(f\"\"\"
            CREATE TABLE {DB_SCHEMA}.delivery_drafts (
                id                  UUID PRIMARY KEY,
                telegram_user_id    BIGINT NOT NULL,
                state               TEXT NOT NULL,
                data                JSONB NOT NULL,
                created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        \"\"\")
    logger.info("Schema %s and delivery tables ensured", DB_SCHEMA)

async def update_draft(user_id: int, state: FSMContext) -> None:
    current_state = await state.get_state()
    data = await state.get_data()
    delivery_uuid = data.get("delivery_uuid")
    if delivery_uuid and db_pool:
        async with db_pool.acquire() as conn:
            await conn.execute(
                f\"\"\"UPDATE {DB_SCHEMA}.delivery_drafts
                   SET state = $1, data = $2, updated_at = NOW()
                   WHERE id = $3\"\"\",
                current_state or "", json.dumps(data), delivery_uuid
            )"""
)

# 5. Delivery Location (Auth and Draft creation)
content = content.replace(
"""    if user_id not in allowed_drivers:
        await message.answer("🚫 You're not authorized. Use /register to request access.")
        return

    lat = message.location.latitude
    lon = message.location.longitude
    await state.update_data(latitude=lat, longitude=lon, photo_file_ids=[])

    logger.info("Driver %d shared location: (%f, %f)", user_id, lat, lon)""",
"""    if user_id not in allowed_drivers:
        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT status FROM public."Driver" WHERE "telegramUserId" = $1', str(user_id)
            )
        if row and row["status"] == "ACTIVE":
            allowed_drivers.add(user_id)
        else:
            await message.answer("🚫 You're not authorized. Use /register to request access.")
            return

    delivery_uuid = str(uuid.uuid4())
    lat = message.location.latitude
    lon = message.location.longitude
    await state.update_data(delivery_uuid=delivery_uuid, latitude=lat, longitude=lon, photo_file_ids=[])

    async with db_pool.acquire() as conn:
        await conn.execute(
            f\"\"\"INSERT INTO {DB_SCHEMA}.delivery_drafts (id, telegram_user_id, state, data)
                VALUES ($1, $2, $3, $4)\"\"\",
            delivery_uuid, user_id, "DeliveryFlow:AWAITING_INVOICE", json.dumps({"delivery_uuid": delivery_uuid, "latitude": lat, "longitude": lon, "photo_file_ids": []})
        )

    logger.info("Driver %d shared location: (%f, %f) uuid=%s", user_id, lat, lon, delivery_uuid)"""
)

# 6. Update draft on subsequent steps
for step in ["delivery_invoice", "delivery_completion", "delivery_payment"]:
    content = re.sub(
        rf"(async def {step}\(.*?\).*?:\n(?:.*\n)*?    await message\.answer\(.*?reply_markup=kb\))",
        r"\1\n    await update_draft(message.from_user.id, state)",
        content
    )
# fix for callback queries
for step in ["delivery_completion", "delivery_payment"]:
    content = re.sub(
        rf"(async def {step}\(callback: CallbackQuery, state: FSMContext\) -> None:\n(?:.*\n)*?    await callback\.message\.answer\(.*?reply_markup=kb\))",
        r"\1\n    await update_draft(callback.from_user.id, state)",
        content
    )
# fix invoice separately because it uses message.answer
content = content.replace(
    """    await message.answer("Was everything delivered?", reply_markup=kb)""",
    """    await message.answer("Was everything delivered?", reply_markup=kb)\n    await update_draft(message.from_user.id, state)"""
)


# 7. Photo batching with Redis
content = content.replace(
"""async def flush_photo_batch(batch_key: str, state: FSMContext, bot: Bot, chat_id: int) -> None:
    \"\"\"Flush a photo batch after the debounce window.\"\"\"
    await asyncio.sleep(2.0)

    batch = pending_photo_batches.pop(batch_key, None)
    if not batch:
        return

    file_ids: list[str] = batch["file_ids"]
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

    if batch_key in pending_photo_batches:
        # Extend existing batch
        batch = pending_photo_batches[batch_key]
        batch["file_ids"].append(file_id)
        # Cancel and reschedule the flush task
        batch["task"].cancel()
        logger.debug("Photo batch '%s' extended (%d photos)", batch_key, len(batch["file_ids"]))
    else:
        # New batch
        pending_photo_batches[batch_key] = {
            "file_ids": [file_id],
            "task": None,
        }
        logger.debug("Photo batch '%s' opened", batch_key)

    # Schedule/reschedule flush
    task = asyncio.create_task(
        flush_photo_batch(batch_key, state, message.bot, message.chat.id)
    )
    pending_photo_batches[batch_key]["task"] = task""",
"""async def flush_photo_batch(batch_key: str, state: FSMContext, bot: Bot, chat_id: int) -> None:
    \"\"\"Flush a photo batch after the debounce window.\"\"\"
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
    await update_draft(chat_id, state)

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
    \"\"\"Flush any photo batches left in Redis due to a restart.\"\"\"
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
"""
)

# 8. Finalize delivery updates
content = content.replace(
"""async def finalize_delivery(source: types.Message | CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    bot = source.bot if isinstance(source, types.Message) else source.message.bot
    user = source.from_user

    driver_id = user.id
    driver_name = user.full_name
    now_utc = datetime.now(dt_timezone.utc)

    invoice_number = data["invoice_number"]
    completion_status = data["completion_status"]
    payment_status = data["payment_status"]
    photo_file_ids = data.get("photo_file_ids", [])
    voice_note_file_id = data.get("voice_note_file_id")
    latitude = data["latitude"]
    longitude = data["longitude"]

    # 1. Insert into delivery_bot.delivery_logs
    async with db_pool.acquire() as conn:
        await conn.execute(
            f\"\"\"INSERT INTO {DB_SCHEMA}.delivery_logs
                (invoice_number, completion_status, payment_status, photo_file_ids,
                 voice_note_file_id, latitude, longitude, driver_id, driver_name, "timestamp")
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)\"\"\",
            invoice_number, completion_status, payment_status,
            photo_file_ids,  # JSONB via codec
            voice_note_file_id, latitude, longitude,
            driver_id, driver_name, now_utc,
        )

    # 2. Also create a simplified Invoice record in the public schema""",
"""async def finalize_delivery(source: types.Message | CallbackQuery, state: FSMContext) -> None:
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

    try:
        # 1. Insert into delivery_bot.delivery_logs
        async with db_pool.acquire() as conn:
            await conn.execute(
                f\"\"\"INSERT INTO {DB_SCHEMA}.delivery_logs
                    (id, invoice_number, completion_status, payment_status, photo_file_ids,
                     voice_note_file_id, latitude, longitude, driver_id, driver_name, "timestamp")
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)\"\"\",
                delivery_uuid, invoice_number, completion_status, payment_status,
                json.dumps(photo_file_ids),  # JSONB via codec doesn't always automatically serialize arrays if not explicit
                voice_note_file_id, latitude, longitude,
                driver_id, driver_name, now_utc,
            )
            
            # Remove draft
            await conn.execute(f"DELETE FROM {DB_SCHEMA}.delivery_drafts WHERE id = $1", delivery_uuid)
    except asyncpg.exceptions.UniqueViolationError:
        logger.info(f"Duplicate submission prevented for delivery_uuid {delivery_uuid}")
        reply_text = f"✅ Delivery for Invoice #{html.escape(invoice_number)} was already logged!"
        if isinstance(source, CallbackQuery):
            await source.message.answer(reply_text)
        else:
            await source.answer(reply_text)
        await state.clear()
        await send_main_menu(source)
        return
    except Exception as e:
        logger.exception("Failed to save delivery to database")
        error_text = "⚠️ Unable to save delivery right now. Please try again."
        if isinstance(source, CallbackQuery):
            await source.message.answer(error_text)
        else:
            await source.answer(error_text)
        return

    # 2. Also create a simplified Invoice record in the public schema"""
)

# 9. Initialization changes
content = content.replace(
"""    global db_pool, allowed_drivers, admin_telegram_ids

    # 1. Create DB pool
    logger.info("Connecting to database...")
    db_pool = await create_pool()
    await init_schema(db_pool)

    # 2. Load driver allow-list and admin IDs
    allowed_drivers = await load_allowed_drivers()
    admin_telegram_ids = await load_admin_ids()

    # 3. Resolve bot token""",
"""    global db_pool, allowed_drivers, admin_telegram_ids, redis_client

    # 1. Create DB pool
    logger.info("Connecting to database...")
    db_pool = await create_pool()
    await init_schema(db_pool)

    # 1.5 Create Redis
    redis_client = Redis.from_url(REDIS_URL)

    # 2. Load driver allow-list and admin IDs
    allowed_drivers = await load_allowed_drivers()
    admin_telegram_ids = await load_admin_ids()

    # 3. Resolve bot token"""
)

content = content.replace(
"""    # 4. Create bot and dispatcher
    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=MemoryStorage())
    dp.include_router(router)

    logger.info("Bot starting in polling mode...")
    logger.info(
        "NOTE: MemoryStorage means in-progress (not-yet-submitted) flows are "
        "lost on restart. Completed deliveries are safe in PostgreSQL."
    )

    try:
        await dp.start_polling(bot)
    finally:""",
"""    # 4. Create bot and dispatcher
    bot = Bot(token=token, default=DefaultBotProperties(parse_mode=ParseMode.HTML))
    dp = Dispatcher(storage=RedisStorage(redis_client, state_ttl=timedelta(hours=24), data_ttl=timedelta(hours=24)))
    dp.include_router(router)
    
    # 5. Recover orphaned photo batches
    await recover_orphaned_photo_batches(bot, dp)

    logger.info("Bot starting in polling mode...")
    logger.info("NOTE: RedisStorage is active. In-progress flows and draft data are preserved across restarts.")

    try:
        await dp.start_polling(bot)
    finally:"""
)

content = content.replace(
"""        if db_pool:
            await db_pool.close()
            logger.info("Database pool closed")""",
"""        if db_pool:
            await db_pool.close()
            logger.info("Database pool closed")
        if redis_client:
            await redis_client.close()
            logger.info("Redis client closed")"""
)

with open("bot_patched.py", "w") as f:
    f.write(content)

