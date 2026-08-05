"""Downloads Telegram-hosted media (photos/voice) into real Frappe File records attached to a
Delivery Report - the klik_pos-side half of ARCHITECTURE.md's fire-and-forget media design.

The Worker only ever forwards Telegram `file_id`s and never downloads binaries itself
(ARCHITECTURE.md: "the Worker only forwards Telegram file_ids... it never downloads binaries").
That means the old bot's two-step `submit_delivery_report -> attach_delivery_media` flow (upload
first, then tell klik_pos the resulting URL) is impossible here: the Worker's write goes through
Hookdeck fire-and-forget, so it never learns the report name back to make a second call with. This
module is the other half of that design - klik_pos itself, which holds a long-lived bot token and
already has a durable place (the newly-inserted Delivery Report) to attach media to
asynchronously, does the download.
"""

import time

import frappe
import requests
from frappe.utils.file_manager import save_file

from klik_pos.api.delivery import _attach_delivery_media
from klik_pos.api.telegram_notify import get_bot_token, send_admin_alert

MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (1, 2, 4)
DOWNLOAD_TIMEOUT = 30

# Small Text has no hard DB length limit under Frappe/MariaDB, but keeping the stored error
# readable (rather than an unbounded pile-up of every retried file's message) is worth doing
# unconditionally.
MAX_ERROR_TEXT_LENGTH = 500


class PermanentDownloadError(Exception):
    """A Telegram-side rejection that retrying the identical file_id will never fix - an
    expired/bad file_id, a file over the Bot API's 20MB `getFile` limit, or a token rotated out
    from under an old file_id (ARCHITECTURE.md failure mode #9). Distinguished from a transient
    network blip or a Telegram 5xx, which *is* retried below - the same permanent-vs-transient
    split this project already applies to Hookdeck's `>=500`-only retry rule and
    `submit_delivery_report_webhook`'s 422-vs-500 status mapping.
    """


def _get_file_path(file_id, token):
    """Telegram's `getFile`: resolves the short-lived `file_path` the actual download URL below
    needs. A non-2xx or `ok: false` response means the file_id itself is rejected (expired, wrong
    bot/token, too large) - permanent, not worth retrying.
    """
    response = requests.get(
        f"https://api.telegram.org/bot{token}/getFile",
        params={"file_id": file_id},
        timeout=DOWNLOAD_TIMEOUT,
    )
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not response.ok or not body.get("ok"):
        raise PermanentDownloadError(body.get("description") or f"getFile HTTP {response.status_code}")
    return body["result"]["file_path"]


def _download_bytes(file_path, token):
    """The actual file download, from Telegram's separate file-serving host (not the Bot API host
    used for getFile itself)."""
    response = requests.get(f"https://api.telegram.org/file/bot{token}/{file_path}", timeout=DOWNLOAD_TIMEOUT)
    if not response.ok:
        raise PermanentDownloadError(f"file download HTTP {response.status_code}")
    return response.content


def _download_with_retry(file_id, token):
    """getFile + download for one file_id, retried only on a transient failure. A
    PermanentDownloadError propagates on the first attempt - retrying an expired file_id three
    times wastes the retry budget on something that can never succeed.
    """
    last_err = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            file_path = _get_file_path(file_id, token)
            return _download_bytes(file_path, token)
        except PermanentDownloadError:
            raise
        except Exception as err:
            last_err = err
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(RETRY_BACKOFF_SECONDS[attempt])
    raise last_err


def _filename_for(file_id, is_voice):
    # Telegram voice notes are always OGG/Opus; photos are always JPEG (grammy/delivery.ts takes
    # the highest-resolution entry, which Telegram always encodes as JPEG regardless of the
    # driver's original format).
    return f"{file_id}.{'ogg' if is_voice else 'jpg'}"


def sync_delivery_media_job(report_name):
    """Enqueued exactly once, right after a new Delivery Report is inserted
    (`delivery.py`'s `submit_delivery_report`), whenever the bot forwarded any photo/voice
    file_ids. Downloads each into a real Frappe File attached to the report, then delegates to
    `_attach_delivery_media` (`delivery.py`) - the same merge-and-save the old bot's two-step
    `submit -> attach_delivery_media` flow used, so a report's `photos`/`voice_note` fields end up
    identical in shape regardless of which bot version reported them.

    Partial failure is handled per-file, not per-job: one bad file_id records an error and alerts
    a human without blocking the other files in the same delivery - never silently dropped, per
    ARCHITECTURE.md failure mode #9. This job itself runs once; only the individual download
    (`_download_with_retry`) retries, and only for transient failures.
    """
    report = frappe.get_doc("Delivery Report", report_name)

    raw = report.telegram_file_ids
    if isinstance(raw, str):
        raw = frappe.parse_json(raw) if raw else {}
    raw = raw or {}
    photo_ids = raw.get("photos") or []
    voice_id = raw.get("voice")

    if not photo_ids and not voice_id:
        return

    token = get_bot_token()
    if not token:
        message = "Media sync skipped: Telegram bot token not configured."
        frappe.log_error(title="Delivery media sync skipped - no bot token", message=report_name)
        send_admin_alert(f"🚨 <b>Delivery media sync skipped</b>\nReport: {report_name}\n{message}")
        _attach_delivery_media(report, error=message)
        return

    photo_urls = []
    errors = []

    for file_id in photo_ids:
        try:
            content = _download_with_retry(file_id, token)
            file_doc = save_file(
                _filename_for(file_id, is_voice=False), content, "Delivery Report", report_name, is_private=1
            )
            photo_urls.append(file_doc.file_url)
        except Exception as err:
            errors.append(f"photo {file_id}: {err}")

    voice_url = None
    if voice_id:
        try:
            content = _download_with_retry(voice_id, token)
            file_doc = save_file(
                _filename_for(voice_id, is_voice=True), content, "Delivery Report", report_name, is_private=1
            )
            voice_url = file_doc.file_url
        except Exception as err:
            errors.append(f"voice {voice_id}: {err}")

    error_text = "; ".join(errors)[:MAX_ERROR_TEXT_LENGTH] if errors else None
    _attach_delivery_media(report, photo_urls=photo_urls, voice_url=voice_url, error=error_text)

    if errors:
        detail = "\n".join(errors)
        frappe.log_error(title="Delivery media sync had failures", message=f"{report_name}\n{detail}")
        send_admin_alert(f"🚨 <b>Delivery media sync failed for one or more files</b>\nReport: {report_name}\n{detail}")
