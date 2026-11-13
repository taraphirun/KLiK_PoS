"""Posts a delivery app report's photos and voice note to the Telegram reporting group
(2026-11-13).

Why this exists: `forward_delivery_to_reporting_chat_job` (delivery.py) posts a report's text once,
right after insert, and sends media only from `telegram_file_ids` - the file ids the Telegram bot
receives. The delivery app (hd-delivery-app) has no Telegram file ids: it sends the report first,
then uploads each real file through `upload_delivery_file` + `attach_delivery_media`, often minutes
later on a weak connection. Nothing posted those files, so the group saw the text only.

What it does, for app reports only (raw_payload.source == "App"; bot reports never reach here):
  - When the report's text is posted, `record_summary` keeps its message id in a
    Delivery Telegram Post row (one per report).
  - Each time a file is attached, `post_app_media_job` runs. Once every expected file is in
    (raw_payload.expected_photos / expected_voice), it posts the voice note, then the photos as
    albums, as replies to the report's text.
  - If files are still missing 2 hours after the report, the hourly sweep posts what has arrived,
    with a warning; files that arrive later follow as replies.
  - Every posted file URL is recorded, so nothing is posted twice, and a failed send is retried by
    the sweep (for 3 days).

Kept apart from Delivery Report on purpose: a stale `report.save()` anywhere else would write
these values back and lose them.
"""

import json

import frappe
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from klik_pos.api.telegram_notify import get_reporting_chat, send_photo_files, send_voice_file

POST_DOCTYPE = "Delivery Telegram Post"

# Post what has arrived once a report is this old and still missing files.
STALL_HOURS = 2
# The sweep stops retrying after this.
SWEEP_DAYS = 3
# One lock for all reports: posting is a few seconds per report, and this keeps two workers from
# posting the same file at once (two attach calls finishing together each enqueue a job).
LOCK_NAME = "delivery_app_media"
LOCK_TIMEOUT = 300
MAX_ERROR_TEXT_LENGTH = 500

# "⚠️ Some photos or the voice note have not arrived yet."
KH_MEDIA_INCOMPLETE = "⚠️ រូបថត ឬសំឡេងខ្លះ មិនទាន់មកដល់នៅឡើយ"


def _json_value(value, default):
    """A JSON field as stored: already parsed, a JSON string, or empty."""
    if isinstance(value, str):
        try:
            return json.loads(value) if value else default
        except ValueError:
            return default
    return value if value is not None else default


def _payload(report):
    payload = _json_value(report.raw_payload, {})
    return payload if isinstance(payload, dict) else {}


def is_app_report(report):
    """True for reports sent by the delivery app (it sets source "App"); the bot never does."""
    return _payload(report).get("source") == "App"


def enqueue_post(report_name):
    frappe.enqueue(
        "klik_pos.api.delivery_app_media.post_app_media_job",
        queue="short",
        enqueue_after_commit=True,
        report_name=report_name,
    )


def record_summary(report_name, message_id):
    """Called by forward_delivery_to_reporting_chat_job right after it posted an app report's
    text. Creates the report's Delivery Telegram Post row (its existence means "the text is in the
    group, media may follow"), then runs the media job once, for files that all arrived before the
    text was posted. `message_id` is None when that send failed: the media then goes as plain
    posts instead of replies."""
    if frappe.db.exists(POST_DOCTYPE, report_name):
        if message_id and not frappe.db.get_value(POST_DOCTYPE, report_name, "summary_message_id"):
            frappe.db.set_value(POST_DOCTYPE, report_name, "summary_message_id", str(message_id), update_modified=False)
    else:
        frappe.get_doc(
            {
                "doctype": POST_DOCTYPE,
                "delivery_report": report_name,
                "summary_message_id": str(message_id) if message_id else None,
                "posted_urls": json.dumps([]),
            }
        ).insert(ignore_permissions=True)
    enqueue_post(report_name)


def _read_file(report_name, file_url):
    """The bytes of a file attached to this report, or None. Read from disk through its File
    record (private files are not reachable by URL from here)."""
    try:
        names = frappe.get_all(
            "File",
            filters={"file_url": file_url, "attached_to_doctype": "Delivery Report", "attached_to_name": report_name},
            pluck="name",
            limit=1,
        )
        if not names:
            return None
        with open(frappe.get_doc("File", names[0]).get_full_path(), "rb") as f:
            return f.read()
    except Exception:
        frappe.log_error(title="Delivery app media: file not readable", message=f"{report_name}\n{file_url}")
        return None


def _filename(file_url):
    return file_url.rsplit("/", 1)[-1]


def post_app_media_job(report_name):
    """Enqueued after each file is attached to an app report, after its text is posted, and by the
    hourly sweep. Safe to run any number of times: it only posts files not posted before."""
    # Imported here, not at the top: delivery.py imports this module, and nothing in it should be
    # able to stop delivery.py from loading.
    from frappe.utils.synchronization import filelock

    with filelock(LOCK_NAME, timeout=LOCK_TIMEOUT):
        # Start a fresh transaction: another worker may have posted files (and committed) while
        # this one waited for the lock.
        frappe.db.commit()
        _post(report_name)
        frappe.db.commit()


def _post(report_name):
    if not frappe.db.exists(POST_DOCTYPE, report_name):
        return  # text not posted yet (or forwarding is off); record_summary runs this again later
    if not frappe.db.exists("Delivery Report", report_name):
        return
    target = get_reporting_chat()
    if not target:
        return
    report = frappe.get_doc("Delivery Report", report_name)
    if not is_app_report(report):
        return

    post = frappe.db.get_value(POST_DOCTYPE, report_name, ["summary_message_id", "posted_urls", "done"], as_dict=True)
    posted = list(_json_value(post.posted_urls, []))

    payload = _payload(report)
    photos = [url for url in _json_value(report.photos, []) if url]
    voice = report.voice_note or None
    complete = len(photos) >= cint(payload.get("expected_photos")) and (
        bool(voice) or not cint(payload.get("expected_voice"))
    )

    new_voice = voice if voice and voice not in posted else None
    new_photos = [url for url in photos if url not in posted]
    if not new_voice and not new_photos:
        if complete and not post.done:
            frappe.db.set_value(POST_DOCTYPE, report_name, "done", 1, update_modified=False)
        return

    stalled = get_datetime(report.creation) < add_to_date(now_datetime(), hours=-STALL_HOURS)
    if not complete and not stalled:
        return  # wait for the rest, or for the sweep after STALL_HOURS

    chat_id, topic_id = target
    extra = {}
    if topic_id:
        extra["message_thread_id"] = topic_id
    if post.summary_message_id:
        extra["reply_parameters"] = {"message_id": cint(post.summary_message_id), "allow_sending_without_reply": True}
    # The warning goes on the first file of a report posted before all its files arrived.
    caption = KH_MEDIA_INCOMPLETE if (not complete and not posted) else None
    errors = []

    def save_posted():
        frappe.db.set_value(POST_DOCTYPE, report_name, "posted_urls", json.dumps(posted), update_modified=False)
        frappe.db.commit()

    # Voice first, then photos: the same order as the bot's forward.
    if new_voice:
        content = _read_file(report_name, new_voice)
        if content is None:
            errors.append(f"voice {new_voice}: file not readable")
        elif send_voice_file(chat_id, _filename(new_voice), content, caption=caption, **extra):
            posted.append(new_voice)
            caption = None
            save_posted()
        else:
            errors.append(f"voice {new_voice}: not sent")

    if new_photos:
        files, urls = [], []
        for url in new_photos:
            content = _read_file(report_name, url)
            if content is None:
                errors.append(f"photo {url}: file not readable")
                continue
            files.append((_filename(url), content))
            urls.append(url)
        if files:
            sent = send_photo_files(chat_id, files, caption=caption, **extra)
            if sent:
                posted.extend(urls[:sent])
                save_posted()
            if sent < len(files):
                errors.append(f"{len(files) - sent} photo(s): not sent")

    done = complete and (not voice or voice in posted) and all(url in posted for url in photos)
    frappe.db.set_value(
        POST_DOCTYPE,
        report_name,
        {"done": 1 if done else 0, "last_error": "; ".join(errors)[:MAX_ERROR_TEXT_LENGTH] if errors else None},
        update_modified=False,
    )


def sweep_stalled_app_media():
    """Hourly (hooks.py). App reports whose files are not all posted, from 2 hours to 3 days old:
    run the media job, which posts whatever has arrived (with a warning when files are missing)
    and retries sends that failed."""
    now = now_datetime()
    names = frappe.get_all(
        POST_DOCTYPE,
        filters={
            "done": 0,
            "creation": ["between", [add_to_date(now, days=-SWEEP_DAYS), add_to_date(now, hours=-STALL_HOURS)]],
        },
        pluck="name",
    )
    for name in names:
        try:
            enqueue_post(name)
        except Exception:
            frappe.log_error(title="Delivery app media: sweep could not enqueue", message=name)
