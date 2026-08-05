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


def _call_telegram(method, payload, what):
    """One Bot API call for the non-sendMessage methods below. Same best-effort contract as
    `_send_telegram_message` (never raises; logs instead) - these are all supervisory/notification
    sends, and a failure to *report* something must never become a new unreported failure.
    """
    try:
        token = get_bot_token()
        if not token:
            frappe.log_error(title="Telegram send skipped - bot token not configured", message=what)
            return

        response = requests.post(f"https://api.telegram.org/bot{token}/{method}", json=payload, timeout=30)
        response.raise_for_status()
        body = response.json()
        if not body.get("ok"):
            frappe.log_error(title=f"Telegram {method} failed", message=f"{what}\n\n{body}")
    except Exception:
        frappe.log_error(title=f"Telegram {method} failed", message=what)


def send_photo(chat_id, file_id, **extra):
    """Single photo by Telegram file_id - no download, the bot can resend its own file_ids directly."""
    _call_telegram("sendPhoto", {"chat_id": chat_id, "photo": file_id, **extra}, f"photo {file_id}")


def send_media_group(chat_id, file_ids, **extra):
    """Album send, **chunked at 10**.

    Telegram caps an album at 10 items and rejects the *entire* call over that with "400: too many
    messages to send as an album" - so an unchunked 15-photo forward delivers **zero** photos, not
    the first 10. That exact bug shipped in the Worker's TypeScript version and was caught live
    (2026-08-05) only because a 15-photo test delivery was run; this is the same fix ported, and is
    the single most important detail in this function.

    Sequential, not concurrent: albums should land in order, and parallel sendMediaGroup calls to
    one chat invite Telegram's per-chat rate limit for no useful gain on a background job.
    A lone trailing item (e.g. the 11th of 11) falls back to sendPhoto, since sendMediaGroup
    requires 2+ items.
    """
    CHUNK = 10
    for i in range(0, len(file_ids), CHUNK):
        batch = file_ids[i : i + CHUNK]
        if len(batch) == 1:
            send_photo(chat_id, batch[0], **extra)
        else:
            media = [{"type": "photo", "media": fid} for fid in batch]
            _call_telegram("sendMediaGroup", {"chat_id": chat_id, "media": media, **extra}, f"album of {len(batch)}")


def send_voice(chat_id, file_id, caption=None, **extra):
    payload = {"chat_id": chat_id, "voice": file_id, **extra}
    if caption:
        payload["caption"] = caption
    _call_telegram("sendVoice", payload, f"voice {file_id}")


def get_reporting_chat():
    """(chat_id, topic_id) for the delivery review chat, or None if unset/disabled.

    Read straight from Telegram Bot Settings - no KV round-trip. The `config:reporting` KV key this
    used to be pushed to existed only because the *Worker* needed the value; now that klik_pos owns
    the forward itself (api/delivery.py), it just reads its own settings doc, and that key and its
    push job are gone.
    """
    settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
    if not settings.enabled or not settings.reporting_chat_id:
        return None
    # cint: Frappe Data field is always a string ("671"), Telegram's message_thread_id must be an
    # Integer - same gotcha already flagged for the driver-cache push and the delivery payload.
    return settings.reporting_chat_id, (cint(settings.reporting_topic_id) if settings.reporting_topic_id else None)


# ─────────────────────────────────────────────────────────────────────────────
# Driver-facing Khmer strings (2026-08-05).
#
# Scope decided with the user: driver-facing messages and the review-group report are Khmer;
# anything addressed to an *admin* (send_admin_alert's callers, the booklet alert, the
# new-registration ping, permanent-failure alerts) stays English. The Worker keeps its own copy of
# this convention in src/strings.ts - these are the klik_pos-originated messages only.
#
# English original is kept beside each string so a non-Khmer reader can review a change here, and a
# Khmer reader can tell what a string was meant to say. Corrections welcome - a native speaker
# should have the last word on all of these.
# ─────────────────────────────────────────────────────────────────────────────

# "Your registration has been approved! Send /start to begin using the bot."
KH_DRIVER_APPROVED = "🎉 ការចុះឈ្មោះរបស់អ្នកត្រូវបានអនុម័ត!\n\nសូមផ្ញើ /start ដើម្បីចាប់ផ្តើមប្រើប្រាស់។"


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
    Active/Closed never alert).

    **Admin DM only** (changed 2026-08-05, user's call). bot.py broadcast this to the review chat
    *as well as* DMing admins; that second copy was dropped deliberately - booklet lifecycle is an
    operations concern for whoever manages the paper booklets, not something drivers or the review
    chat need to see. Keeping it admin-only also sidesteps a language split: the review chat is
    Khmer now, admin messages stay English, and this text would otherwise have needed both.
    """
    labels = {"Stalled": "STALLED", "Ready for Review": "READY FOR REVIEW"}
    if new_status not in labels:
        return

    send_admin_alert(f"🚨 Booklet #{booklet_number} is {labels[new_status]}!")
