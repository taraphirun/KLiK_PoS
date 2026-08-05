"""Direct Telegram Bot API calls made *by klik_pos*, not routed through the Worker or Hookdeck
(ARCHITECTURE.md's "Outbound notifications" design decision). First user: submit_delivery_report
webhook's 422-permanent-failure alert (Phase 5.2). Phase 8 (driver-approved DM, booklet-stalled
alert, new-registration DM) reuses send_admin_alert / _send_telegram_message rather than
duplicating this.
"""

import frappe
import requests
from frappe.utils import cint


def get_bot_token():
    """Public - also used by api/telegram_media.py (Phase 6), which needs the raw token itself for
    `getFile`/file-download URLs, not just a message-send helper.
    """
    settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
    if not settings.enabled:
        return None
    # raise_exception=False: an unset Password field otherwise raises ValidationError - found live
    # (2026-08-04) when bot_token hadn't been configured yet, which crashed the *caller* of
    # send_admin_alert (submit_delivery_report_webhook) instead of just skipping this alert. This
    # function exists to report *other* failures and must degrade to "can't send, log it" rather
    # than becoming a new, uncaught failure mode itself.
    return settings.get_password("bot_token", raise_exception=False) or None


def _admin_telegram_ids():
    settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
    raw = settings.admin_telegram_ids or ""
    return [v.strip() for v in raw.split(",") if v.strip()]


def _send_telegram_message(chat_id, text, **extra):
    """One sendMessage call. Best-effort - never raises; failures are logged, since this function
    exists to alert humans about *other* failures and must not itself become a new failure mode
    that also goes unnoticed. Everything is inside the try, not just the HTTP call -
    get_bot_token() itself can raise (see its own comment) and that must be caught here too.

    `**extra` merges straight into the sendMessage body - e.g. `message_thread_id` for
    send_booklet_status_alert's reporting-chat broadcast, the one caller so far that needs
    anything beyond chat_id/text.
    """
    try:
        token = get_bot_token()
        if not token:
            frappe.log_error(title="Telegram alert skipped - bot token not configured", message=text)
            return

        response = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML", **extra},
            timeout=15,
        )
        response.raise_for_status()
        body = response.json()
        if not body.get("ok"):
            frappe.log_error(title="Telegram alert send failed", message=f"{text}\n\n{body}")
    except Exception:
        frappe.log_error(title="Telegram alert send failed", message=text)


def notify_driver(chat_id, text):
    """DMs a single driver directly (not an admin) - Phase 8.1's driver-approved message, and the
    natural home for any future driver-facing push (e.g. a booklet-stalled nudge aimed at the
    driver rather than an admin). Thin wrapper over `_send_telegram_message` kept as its own name
    for readability at call sites - `send_admin_alert` and `notify_driver` read very differently
    even though today they share an implementation.
    """
    _send_telegram_message(chat_id, text)


def send_admin_alert(text):
    """DMs every configured admin (Telegram Bot Settings' admin_telegram_ids). Never raises - see
    _send_telegram_message's own comment; the same must hold for the recipient-list lookup here,
    so this whole function is wrapped too, not just the per-recipient send loop."""
    try:
        admin_ids = _admin_telegram_ids()
        if not admin_ids:
            frappe.log_error(title="Telegram alert has no recipients - admin_telegram_ids unset", message=text)
            return

        for admin_id in admin_ids:
            _send_telegram_message(admin_id, text)
    except Exception:
        frappe.log_error(title="send_admin_alert failed", message=text)


def send_booklet_status_alert(booklet_number, new_status):
    """Phase 8.2. Ports booklet_sync.py's `_check_one_booklet` (the old bot's Telegram side of
    booklet-lifecycle.service.ts's notifyAdmins) directly into klik_pos, rather than keeping a
    separate poll loop to detect the same transition klik_pos already just computed.

    The old bot needed to *poll* `list_booklets` and track each booklet's last-seen status itself
    (`local_store.get/set_booklet_last_status`) purely because it had no other way to learn about a
    transition klik_pos's own database already knows about firsthand. `check_booklet_lifecycle`
    (api/booklet.py) computes `new_status != booklet.status` and calls this function *only* in that
    branch - so "was this the moment of transition" is already answered by the caller, and no
    separate tracking table is needed here.

    Only Stalled/Ready for Review are alert-worthy (mirrors booklet_sync.py's ALERT_STATUSES -
    Active/Closed never alert). Sends to *both* destinations the old bot did: the reporting chat
    (broadcast, for whoever's watching it) and every admin (DM) - not a duplicate, the two have
    different audiences and the old bot deliberately sent both.
    """
    labels = {"Stalled": "STALLED", "Ready for Review": "READY FOR REVIEW"}
    if new_status not in labels:
        return

    text = f"🚨 Booklet #{booklet_number} is {labels[new_status]}!"

    try:
        settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
        chat_id = settings.reporting_chat_id
        if chat_id:
            extra = {}
            if settings.reporting_topic_id:
                # Frappe Data field -> Telegram Integer, same gotcha ARCHITECTURE.md flags for the
                # KV push (driver.py) and the delivery-report payload - a string here makes
                # Telegram reject message_thread_id silently landing in the wrong topic or failing.
                extra["message_thread_id"] = cint(settings.reporting_topic_id)
            _send_telegram_message(chat_id, text, **extra)
    except Exception:
        frappe.log_error(title="Booklet status broadcast failed", message=f"{booklet_number}: {new_status}")

    send_admin_alert(text)
