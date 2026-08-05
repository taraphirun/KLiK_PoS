import json

import frappe

from klik_pos.api.cloudflare_kv import get_acks_namespace_id, put_kv
from klik_pos.api.telegram_notify import KH_DRIVER_APPROVED, notify_driver, send_admin_alert

DRIVER_LIST_FIELDS = [
    "name",
    "driver_name",
    "phone_number",
    "status",
    "telegram_user_id",
    "telegram_username",
    "chat_id",
    "bot_driver_id",
    "creation",
    "modified",
]

# Telegram-identity fields are bot-owned (Phase 10 precedence rule) - upsert_driver (human-driven,
# KlikPOS UI) never writes these; only sync_driver_from_bot (bot-driven) does.
BOT_OWNED_FIELDS = ("telegram_user_id", "telegram_username", "chat_id", "bot_driver_id")

VALID_STATUSES = ("Pending", "Active", "Rejected")


@frappe.whitelist()
def list_drivers(status=None, search="", start=0, limit=100):
    """Paginated driver list for the management UI (Todo 027) - also the mechanism the bot polls
    to learn about approve/reject decisions (Todo 026: "KlikPOS -> bot" direction), since there's
    no push/webhook infra anywhere else in this integration (bot -> KlikPOS is the only direction
    that pushes; see submit_delivery_report). Filter by status and sort by `modified` to make
    polling for recent changes cheap.
    """
    try:
        start = int(start or 0)
        limit = min(int(limit or 100), 200)

        filters = {}
        if status:
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if statuses:
                filters["status"] = ["in", statuses]

        or_filters = None
        search = (search or "").strip()
        if search:
            term = f"%{search}%"
            or_filters = [
                ["driver_name", "like", term],
                ["phone_number", "like", term],
                ["telegram_username", "like", term],
            ]

        # Delivery Driver is a low-volume master (bounded by how many drivers exist, not
        # transaction volume) - a plain count of matching names is cheap enough here, same
        # reasoning as get_delivery_reports.
        total_count = len(
            frappe.get_all("Delivery Driver", filters=filters, or_filters=or_filters, pluck="name")
        )
        data = frappe.get_all(
            "Delivery Driver",
            filters=filters,
            or_filters=or_filters,
            fields=DRIVER_LIST_FIELDS,
            order_by="modified desc",
            limit_start=start,
            limit_page_length=limit,
        )
        return {"success": True, "data": data, "total_count": total_count, "start": start, "limit": limit}

    except Exception as e:
        frappe.log_error(title="Delivery Driver list failed")
        return {"success": False, "message": str(e), "data": [], "total_count": 0}


@frappe.whitelist()
def upsert_driver(data):
    """Create or update a driver from the KlikPOS management UI (Todo 027) - a human action, not
    the bot sync path. Only profile fields (driver_name, phone_number, status) are writable here;
    Telegram-identity fields (BOT_OWNED_FIELDS) are silently ignored if passed, so a human editing
    a driver can never clobber identity the bot already attached (Phase 10 precedence rule)."""
    try:
        if isinstance(data, str):
            data = json.loads(data)

        driver_name = (data.get("driver_name") or "").strip()
        if not driver_name:
            frappe.throw("driver_name is required")

        existing_name = data.get("name")
        if existing_name:
            if not frappe.db.exists("Delivery Driver", existing_name):
                frappe.throw(f"Delivery Driver {existing_name} does not exist")
            driver = frappe.get_doc("Delivery Driver", existing_name)
        else:
            driver = frappe.new_doc("Delivery Driver")

        driver.driver_name = driver_name

        if "phone_number" in data:
            driver.phone_number = (data.get("phone_number") or "").strip() or None

        status = data.get("status")
        if status:
            if status not in VALID_STATUSES:
                frappe.throw(f"Invalid status '{status}', expected one of {VALID_STATUSES}")
            driver.status = status

        driver.save(ignore_permissions=True)

        return {"success": True, "driver": driver.name, "status": driver.status}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Driver upsert failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def set_driver_status(driver, status):
    """Approve (Active), Rejected, or suspend. Delivery Driver has no separate Suspended state
    (Todo 025's Select is Pending/Active/Rejected, mirroring the bot's three-state model) -
    suspending an already-Active driver reuses Rejected, same as rejecting a Pending signup.
    KlikPOS is the sync master (Phase 10 decision): this is the only place status changes. The
    telegram-bot-worker's approved-driver cache is kept current by a push, not by the bot polling
    - see push_driver_cache below, hooked to Delivery Driver's on_update so it also covers Desk
    edits, bulk edits, and sync_driver_from_bot creates, not just this one call site."""
    try:
        if status not in VALID_STATUSES:
            frappe.throw(f"Invalid status '{status}', expected one of {VALID_STATUSES}")

        doc = frappe.get_doc("Delivery Driver", driver)
        doc.status = status
        doc.save(ignore_permissions=True)

        return {"success": True, "driver": doc.name, "status": doc.status}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Driver status change failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def sync_driver_from_bot(payload):
    """Bot calls this when a driver first messages it (idempotent - safe to call again on every
    interaction) to attach Telegram identity. Match priority: bot_driver_id first (the bot's own
    stable key), then telegram_user_id as a fallback for a driver the bot has interacted with
    before but whose bot_driver_id wasn't recorded here yet. Creates a new Pending driver if
    neither matches - an unsolicited bot-side signup, requiring KlikPOS approval (Todo 027) before
    it becomes selectable anywhere (Todo 028's Active-only Link filter).

    Precedence (Phase 10, decided): Frappe wins on status/profile fields; the bot wins only on the
    Telegram-identity fields it uniquely knows. Never touches driver_name/phone_number/status.

    Deliberately NOT allow_guest, same reasoning as submit_delivery_report (Todo 021): the bot
    authenticates as a dedicated Frappe user (API key/secret), not anonymously. Writes with
    ignore_permissions=True since that service user needs no Delivery Driver DB permission of its
    own - the whitelisted-and-authenticated endpoint is the access gate, not doctype permissions.
    """
    try:
        if isinstance(payload, str):
            payload = json.loads(payload)

        bot_driver_id = payload.get("bot_driver_id")
        telegram_user_id = payload.get("telegram_user_id")
        telegram_username = payload.get("telegram_username")
        chat_id = payload.get("chat_id")
        phone_number = payload.get("phone_number")

        if not bot_driver_id and not telegram_user_id:
            frappe.throw("bot_driver_id or telegram_user_id is required")

        existing_name = None
        if bot_driver_id:
            existing_name = frappe.db.get_value("Delivery Driver", {"bot_driver_id": bot_driver_id}, "name")
        if not existing_name and telegram_user_id:
            existing_name = frappe.db.get_value(
                "Delivery Driver", {"telegram_user_id": telegram_user_id}, "name"
            )

        if existing_name:
            driver = frappe.get_doc("Delivery Driver", existing_name)
            created = False
        else:
            # phone_number is set here too (creation only) even though it's a profile field, not
            # a BOT_OWNED_FIELDS identity field - same precedence as driver_name just below: the
            # bot seeds the *initial* value from the driver's own registration flow (2026-08-03,
            # Todo 036 - this used to only be captured in the now-retired Postgres Driver table),
            # but never overwrites it on a later sync once a human may have edited it.
            driver = frappe.new_doc("Delivery Driver")
            driver.driver_name = payload.get("driver_name") or telegram_username or "Unknown Driver"
            driver.phone_number = phone_number
            driver.status = "Pending"
            created = True

        if bot_driver_id:
            driver.bot_driver_id = bot_driver_id
        if telegram_user_id:
            driver.telegram_user_id = telegram_user_id
        if telegram_username:
            driver.telegram_username = telegram_username
        if chat_id:
            driver.chat_id = chat_id

        driver.save(ignore_permissions=True)

        # Phase 8.4: admins lose bot.py's proactive "new registration" DM (with inline
        # approve/reject buttons) once approval moves to klik_pos's Desk/SPA UI instead of staying
        # in the bot (Phase 4's scope cut) - without a replacement, approval turnaround regresses
        # to "whoever happens to check the /drivers page." Fires once, at creation, not on every
        # later re-sync of the same driver (a driver messaging the bot again shouldn't re-alert).
        if created:
            try:
                frappe.enqueue(
                    "klik_pos.api.telegram_notify.send_admin_alert",
                    queue="short",
                    enqueue_after_commit=True,
                    text=(
                        "🆕 <b>New driver registration pending approval</b>\n"
                        f"Name: {driver.driver_name}\n"
                        f"Phone: {driver.phone_number or 'n/a'}\n"
                        f"Telegram: {telegram_username or 'n/a'} ({telegram_user_id or bot_driver_id})\n\n"
                        f"Review: {driver.name}"
                    ),
                )
            except Exception:
                frappe.log_error(title="Failed to enqueue new-registration admin alert")

        # Phase 7: acks the Worker's pending-delivery/registration ledger (src/ledger-do.ts) so its
        # hourly sweep can stop re-POSTing this registration once klik_pos actually has it - keyed
        # by telegram_user_id, matching the Worker's registrationLedgerKey exactly (never
        # bot_driver_id; the Worker always sends telegram_user_id, so this is never the only
        # identifier available in practice, but the guard makes that assumption explicit rather
        # than silent). Enqueued (not written inline) for the same reason push_driver_cache_job is
        # a background job: a Cloudflare outage or bad token must never block or roll back this
        # save. Fires on every call, not just first-creation - a sweep re-POST of an
        # already-registered driver must ALSO re-ack, or the sweep would re-POST it forever despite
        # klik_pos definitely having the record.
        if telegram_user_id:
            try:
                frappe.enqueue(
                    "klik_pos.api.driver.push_registration_ack_job",
                    queue="short",
                    enqueue_after_commit=True,
                    telegram_user_id=telegram_user_id,
                )
            except Exception:
                frappe.log_error(title="Failed to enqueue registration ack push")

        return {"success": True, "driver": driver.name, "status": driver.status, "created": created}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Driver bot sync failed")
        return {"success": False, "message": str(e)}


def push_registration_ack_job(telegram_user_id):
    """Background job for the ack write above. Best-effort: if this fails, the Worker's ledger
    entry simply isn't cleared and the hourly sweep re-POSTs it - safe (sync_driver_from_bot is
    idempotent on telegram_user_id) if wasteful, so failure here is logged, not alerted.
    """
    namespace_id = get_acks_namespace_id()
    if not namespace_id:
        frappe.log_error(title="Registration ack push skipped - ACKS namespace id not configured")
        return
    try:
        put_kv(namespace_id, f"registration:{telegram_user_id}", frappe.utils.now())
    except Exception:
        # See delivery.py's push_delivery_ack_job for why `message` is deliberately omitted here -
        # passing one replaces frappe.log_error's auto-captured traceback instead of adding to it.
        frappe.log_error(title=f"Registration ack push to Cloudflare KV failed ({telegram_user_id})")


@frappe.whitelist()
def sync_driver_from_bot_webhook(payload):
    """Hookdeck ingress for driver-registration writes - sync_driver_from_bot's counterpart to
    delivery.py's submit_delivery_report_webhook, same reasoning: sync_driver_from_bot also always
    returns HTTP 200 even on failure, so without this wrapper Hookdeck can't tell a permanent
    rejection from a successful sync and never retries or alerts anyone. Not explicitly listed in
    PHASES.md's original Phase 5 checklist, but ARCHITECTURE.md already names this endpoint as one
    of the two Hookdeck-forwarded writes, so it needs the same fix for the same reason.
    """
    if isinstance(payload, str):
        payload = json.loads(payload)

    result = sync_driver_from_bot(payload)

    if not result.get("success"):
        # sync_driver_from_bot's only validation failure is this one inline condition - mirrored
        # here rather than extracted into a shared helper, since it's a single check, not a
        # multi-field validator like delivery.py's _validate_delivery_payload.
        is_permanent = not payload.get("bot_driver_id") and not payload.get("telegram_user_id")
        if is_permanent:
            frappe.local.response.http_status_code = 422
            send_admin_alert(
                "🚨 <b>Driver registration permanently rejected</b>\n"
                f"Reason: {result.get('message')}\n"
                f"telegram_user_id: {payload.get('telegram_user_id')}\n\n"
                "Hookdeck has stopped retrying this one."
            )
        else:
            frappe.local.response.http_status_code = 500

    return result


# ─────────────────────────────────────────────────────────────────
# KV driver cache push (ARCHITECTURE.md "Reads vs. writes" / PHASES.md Phase 3)
# ─────────────────────────────────────────────────────────────────

# Fields that change the cached-approval-relevant picture - everything the Worker's cache actually
# carries (DRIVER_LIST_FIELDS minus name/creation/modified, which aren't driver-editable). A save
# that touches none of these doesn't need a push.
CACHE_RELEVANT_FIELDS = (
    "driver_name",
    "phone_number",
    "status",
    "telegram_user_id",
    "telegram_username",
    "chat_id",
    "bot_driver_id",
)


def push_driver_cache(doc, method=None):
    """`Delivery Driver` `on_update` hook (see hooks.py `doc_events`) - the *only* trigger for a KV
    cache push. Deliberately not wired to set_driver_status/upsert_driver individually: on_update
    fires after every save regardless of call site, so it also covers Desk edits, bulk edits,
    imports, and sync_driver_from_bot's bot-side creates - all of which the two-function approach
    would have missed, leaving the cache silently stale for up to the hourly reconciliation window
    (PHASES.md 3.7).

    Guards on has_value_changed so an unrelated save (e.g. some future field the cache doesn't
    use) doesn't push. Always true on creation - and that now matters rather than being harmless:
    a brand-new Pending driver belongs in the `drivers:all` key the bot reads to answer "is my
    registration pending?", even though it's correctly absent from the Active-only key.

    Only *decides and enqueues* here, synchronously inside the save transaction. The actual
    Cloudflare HTTP call happens in push_driver_cache_job, after commit (enqueue_after_commit),
    so a Cloudflare outage or bad token can never block or roll back a Delivery Driver save - and
    the enqueue call itself is try/excepted for the same reason (a down queue backend shouldn't
    block a save either; the hourly reconciliation cron is the backstop for a push that never
    happened at all).
    """
    changed = any(doc.has_value_changed(field) for field in CACHE_RELEVANT_FIELDS)
    if not changed:
        return

    try:
        frappe.enqueue(
            "klik_pos.api.driver.push_driver_cache_job",
            queue="short",
            enqueue_after_commit=True,
        )
    except Exception:
        frappe.log_error(title="Failed to enqueue driver cache push")

    # Phase 8.1: the driver-approved DM. bot.py used to send this itself, inline, the moment its
    # own admin-approval buttons were tapped (driver_sync.py's "🎉 Your registration has been
    # approved!"); this rewrite moved approval to klik_pos's Desk/SPA UI instead, which meant that
    # DM had no trigger left anywhere - found live (2026-08-05) when an approval produced no
    # notification. `on_update` already guards on has_value_changed, so specifically gate on the
    # *status* field transitioning to Active, not on any of the other CACHE_RELEVANT_FIELDS (e.g.
    # a phone-number edit shouldn't re-send this).
    if doc.has_value_changed("status") and doc.status == "Active" and doc.chat_id:
        try:
            frappe.enqueue(
                "klik_pos.api.driver.notify_driver_approved_job",
                queue="short",
                enqueue_after_commit=True,
                driver_name=doc.name,
            )
        except Exception:
            frappe.log_error(title="Failed to enqueue driver-approved notification")


def notify_driver_approved_job(driver_name):
    """Background job (runs post-commit, same reasoning as push_driver_cache_job - a Telegram
    outage must never block or roll back the approval save). Re-fetches rather than trusting the
    enqueue-time doc: by the time this runs the record could have been edited again (e.g. rejected
    moments later), and re-checking here avoids a stale "you're approved!" DM in that race.
    """
    driver = frappe.get_doc("Delivery Driver", driver_name)
    if driver.status != "Active" or not driver.chat_id:
        return
    notify_driver(driver.chat_id, KH_DRIVER_APPROVED)


def push_driver_cache_job():
    """Background job (never call directly outside a queue context - runs post-commit). Full-list
    replace of two KV keys: `drivers:approved` (Active only - the approval gate) and `drivers:all`
    (every status - lets the bot distinguish Pending/Rejected without calling this bench live).
    One key each, not one per driver (ARCHITECTURE.md) - at five drivers, full-list replacement
    makes revocation automatic with no tombstones needed.

    Silently no-ops if Telegram Bot Settings isn't enabled yet - expected before Phase 3's
    Cloudflare account/KV namespace exist (PHASES.md Prerequisites), not an error state. A
    *configured-but-incomplete* settings doc (missing namespace id) is a real error, though, and is
    still logged as one below - only "not enabled at all" is silent.
    """
    settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
    if not settings.enabled:
        return

    namespace_id = settings.cloudflare_kv_namespace_id
    if not namespace_id:
        frappe.log_error(
            title="Driver cache push skipped - Telegram Bot Settings incomplete",
            message="Enabled but missing cloudflare_kv_namespace_id.",
        )
        return

    all_drivers = frappe.get_all(
        "Delivery Driver",
        fields=DRIVER_LIST_FIELDS,
        order_by="modified desc",
    )
    active_drivers = [d for d in all_drivers if d.get("status") == "Active"]

    # Two keys, one query. `drivers:approved` gates every delivery (Active only, fail-closed);
    # `drivers:all` carries every status so the bot can tell Pending from Rejected from unknown
    # *without* calling this bench live. That live call previously sat on /start's and /register's
    # hot path, which meant a home-lab outage stalled the bot's most-used command - the exact
    # dependency the Worker architecture exists to remove. Filtered in Python rather than with a
    # second get_all so both keys always describe the same instant.
    #
    # put_kv (api/cloudflare_kv.py) raises on failure; each key gets its own try/except here so one
    # failing still lets the other land, same as before this was extracted into a shared helper.
    for key_name, payload in (("drivers:approved", active_drivers), ("drivers:all", all_drivers)):
        try:
            put_kv(namespace_id, key_name, payload)
        except Exception:
            frappe.log_error(title=f"Driver cache push to Cloudflare KV failed ({key_name})")
