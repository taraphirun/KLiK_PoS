"""Posts a delivery app report to the Telegram reporting group as one block - separator, text,
voice note, photos - once its files are in (2026-11-13).

Why this exists: `forward_delivery_to_reporting_chat_job` (delivery.py) posts a report right after
insert and sends media only from `telegram_file_ids` - the file ids the Telegram bot receives. The
delivery app (hd-delivery-app) has no Telegram file ids: it sends the report first, then uploads
each real file through `upload_delivery_file` + `attach_delivery_media`, often minutes later on a
weak connection. Posting the text at once and the files as they come let other deliveries land in
between, so the group became hard to read.

What it does, for app reports only (raw_payload.source == "App"; bot reports never reach here):
  - The forward job hands the report over (`hold_for_media`) instead of posting it.
  - Each time a file is attached, `post_app_media_job` runs. When every expected file is in
    (raw_payload.expected_photos / expected_voice), it posts the whole block at once.
  - If files are still missing WAIT_MINUTES after the report, the per-minute sweep posts the block
    anyway: the photos that arrived, a placeholder image for each missing one, and a warning
    caption. A photo that arrives later replaces its placeholder in place (editMessageMedia); if
    that fails it is sent as a reply. A late voice note is sent as a reply (Telegram cannot turn a
    photo into a voice message). The warning is removed once everything is in.
  - Every posted file URL is recorded, so nothing is posted twice; a failed send is retried by the
    hourly sweep for SWEEP_DAYS.
  - The block is posted under one lock, so two app reports never interleave.
  - A driver's edit (delivery.update_delivery_report) updates the block in place: the text is
    edited with an "edited" line, photos and a voice note the driver removed are deleted from the
    group (Telegram allows this for 48 hours), and added files fill placeholders or follow as
    replies.

State lives in Delivery Telegram Post (one row per report), not on Delivery Report: a stale
`report.save()` anywhere else would write these values back and lose them.
"""

import io
import json

import frappe
from frappe.utils import add_to_date, cint, get_datetime, now_datetime

from klik_pos.api.telegram_notify import (
    _send_telegram_message,
    delete_message,
    edit_message_text,
    get_reporting_chat,
    replace_photo_file,
    send_photo_files,
    send_voice_file,
    set_caption,
)

POST_DOCTYPE = "Delivery Telegram Post"

# Post the block anyway once a report is this old and still missing files.
WAIT_MINUTES = 1
# The sweeps stop retrying after this.
SWEEP_DAYS = 3
# One lock for all reports: a block is a few seconds to post, and this keeps two blocks from
# interleaving and two workers from posting the same file (attach calls finishing together each
# enqueue a job).
LOCK_NAME = "delivery_app_media"
LOCK_TIMEOUT = 300
MAX_ERROR_TEXT_LENGTH = 500

# "⚠️ Some photos or the voice note have not arrived yet."
KH_MEDIA_INCOMPLETE = "⚠️ រូបថត ឬសំឡេងខ្លះ មិនទាន់មកដល់នៅឡើយ"
# "✏️ Edited" - added to the text of a report the driver edited.
KH_EDITED = "✏️ បានកែប្រែ"

_placeholder = None


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
    return report.get("source") == "App" or _payload(report).get("source") == "App"


def _expected(report):
    """(photos, voice notes) the driver took. From the report's own fields, which an edit
    updates; reports from before those fields existed only have them in raw_payload."""
    if report.get("source") == "App":
        return cint(report.get("expected_photos")), cint(report.get("expected_voice"))
    payload = _payload(report)
    return cint(payload.get("expected_photos")), cint(payload.get("expected_voice"))


def enqueue_post(report_name):
    frappe.enqueue(
        "klik_pos.api.delivery_app_media.post_app_media_job",
        queue="short",
        enqueue_after_commit=True,
        report_name=report_name,
    )


def hold_for_media(report_name):
    """Called by forward_delivery_to_reporting_chat_job instead of posting an app report. Creates
    the report's Delivery Telegram Post row, then runs the job once (a report whose files are all
    in already - or that has none - posts straight away)."""
    if not frappe.db.exists(POST_DOCTYPE, report_name):
        frappe.get_doc(
            {"doctype": POST_DOCTYPE, "delivery_report": report_name, "posted_urls": json.dumps([])}
        ).insert(ignore_permissions=True)
    enqueue_post(report_name)


def placeholder_jpeg():
    """A small grey square with an hourglass, shown in the album until the real photo arrives."""
    global _placeholder
    if _placeholder is None:
        from PIL import Image, ImageDraw

        size = 320
        image = Image.new("RGB", (size, size), (229, 231, 235))
        draw = ImageDraw.Draw(image)
        grey = (156, 163, 175)
        draw.rectangle((110, 92, 210, 102), fill=grey)
        draw.rectangle((110, 218, 210, 228), fill=grey)
        draw.polygon([(118, 104), (202, 104), (160, 160)], fill=grey)
        draw.polygon([(160, 160), (118, 216), (202, 216)], outline=grey, width=6)
        draw.polygon([(140, 216), (180, 216), (160, 190)], fill=grey)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=80)
        _placeholder = buf.getvalue()
    return _placeholder


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


def _is_voice(file_url):
    return _filename(file_url).lower().endswith((".ogg", ".oga", ".m4a", ".mp3", ".wav", ".webm", ".amr"))


def post_app_media_job(report_name):
    """Enqueued when an app report is handed over, after each of its files is attached, and by the
    sweeps. Safe to run any number of times: it posts the block once and each file once."""
    # Imported here, not at the top: delivery.py imports this module, and nothing in it should be
    # able to stop delivery.py from loading.
    from frappe.utils.synchronization import filelock

    with filelock(LOCK_NAME, timeout=LOCK_TIMEOUT):
        # Start a fresh transaction: another worker may have posted (and committed) while this one
        # waited for the lock.
        frappe.db.commit()
        _Post(report_name).run()
        frappe.db.commit()


class _Post:
    def __init__(self, report_name):
        self.name = report_name
        self.errors = []

    def run(self):
        if not frappe.db.exists(POST_DOCTYPE, self.name) or not frappe.db.exists("Delivery Report", self.name):
            return
        target = get_reporting_chat()
        if not target:
            return
        self.report = frappe.get_doc("Delivery Report", self.name)
        if not is_app_report(self.report):
            return
        self.chat_id, topic_id = target
        self.thread = {"message_thread_id": topic_id} if topic_id else {}

        row = frappe.db.get_value(
            POST_DOCTYPE,
            self.name,
            [
                "posted_at",
                "summary_message_id",
                "posted_urls",
                "photo_slots",
                "warning_message_id",
                "voice_message_id",
                "text_revision",
                "done",
            ],
            as_dict=True,
        )
        self.posted = list(_json_value(row.posted_urls, []))
        self.slots = list(_json_value(row.photo_slots, []))
        self.summary_id = cint(row.summary_message_id) or None
        self.warning_id = cint(row.warning_message_id) or None
        self.voice_message_id = cint(row.voice_message_id) or None
        self.text_revision = cint(row.text_revision) or 1

        self.photos = [url for url in _json_value(self.report.photos, []) if url]
        self.voice = self.report.voice_note or None
        self.expected_photos, self.expected_voice = _expected(self.report)
        complete = len(self.photos) >= self.expected_photos and (bool(self.voice) or not self.expected_voice)

        # Rows from the first version (text posted at once, files as replies) have a message id or
        # posted files but no posted_at: treat them as posted.
        if not (row.posted_at or self.summary_id or self.posted):
            waited = get_datetime(self.report.creation) < add_to_date(now_datetime(), minutes=-WAIT_MINUTES)
            if not complete and not waited:
                return  # wait for the rest, or for the sweep after WAIT_MINUTES
            self.post_block(complete)
        else:
            self.apply_edit()
            self.follow_up()

        done = complete and (not self.voice or self.voice in self.posted) and all(u in self.posted for u in self.photos)
        if done and self.warning_id:
            if set_caption(self.chat_id, self.warning_id, ""):
                self.warning_id = None
                self.save(warning_message_id=None)
        self.save(
            done=1 if done else 0,
            last_error="; ".join(self.errors)[:MAX_ERROR_TEXT_LENGTH] if self.errors else None,
        )

    def save(self, **values):
        frappe.db.set_value(POST_DOCTYPE, self.name, values, update_modified=False)
        frappe.db.commit()

    def save_posted(self):
        self.save(posted_urls=json.dumps(self.posted), photo_slots=json.dumps(self.slots))

    def post_block(self, complete):
        """Separator, text, voice, photos (placeholders for missing ones), back to back."""
        from klik_pos.api.delivery import REPORT_SEPARATOR

        _send_telegram_message(self.chat_id, REPORT_SEPARATOR, **self.thread)
        self.summary_id = _send_telegram_message(self.chat_id, self.text(), **self.thread)
        # Recorded before the files go out: from here on this report only ever gets follow-ups,
        # whatever happens below, so the block is never posted twice.
        self.save(
            posted_at=now_datetime(),
            summary_message_id=str(self.summary_id) if self.summary_id else None,
            text_revision=self.revision(),
        )

        if self.voice:
            self.send_voice(reply=False)

        files, urls = [], []
        for url in self.photos:
            content = _read_file(self.name, url)
            if content is None:
                self.errors.append(f"photo {url}: file not readable")
                continue
            files.append((_filename(url), content))
            urls.append(url)
        missing = max(self.expected_photos - len(urls), 0)
        files += [(f"waiting-{i + 1}.jpg", placeholder_jpeg()) for i in range(missing)]
        urls += [None] * missing
        if not files:
            return
        caption = None if complete and not missing else KH_MEDIA_INCOMPLETE
        ids = send_photo_files(self.chat_id, files, caption=caption, **self.thread)
        for url, message_id in zip(urls, ids, strict=False):
            if message_id is None:
                if url:
                    self.errors.append(f"photo {url}: not sent")
                continue
            self.slots.append({"message_id": message_id, "url": url})
            if url:
                self.posted.append(url)
        if caption and ids and ids[0]:
            self.warning_id = ids[0]
            self.save(warning_message_id=str(ids[0]))
        self.save_posted()

    def revision(self):
        return max(cint(self.report.get("revision")), 1)

    def text(self):
        from klik_pos.api.delivery import reporting_summary_text

        try:
            text = reporting_summary_text(self.report)
        except Exception:
            frappe.log_error(title="Delivery app media: report text failed", message=self.name)
            text = f"📦 <b>#{self.report.reported_invoice_no}</b>"
        # is_edited, not revision: a report edited on the phone before it first reached klik_pos
        # arrives at revision 2 but was never changed after the office saw it.
        return f"{text}\n{KH_EDITED}" if self.report.get("is_edited") else text

    def apply_edit(self):
        """After a driver's edit: the text edited in place, removed photos and voice deleted from
        the group, placeholders no longer needed deleted. Added files are left to follow_up."""
        if self.revision() > self.text_revision:
            if not self.summary_id or edit_message_text(self.chat_id, self.summary_id, self.text()):
                self.text_revision = self.revision()
                self.save(text_revision=self.text_revision)
            else:
                self.errors.append("text not edited")

        if self.revision() == 1:
            return  # never edited: nothing to remove

        keep = []
        # Placeholders still needed: expected photos not shown in a slot yet (arrived ones that
        # are not placed yet will fill placeholders in follow_up).
        shown = sum(1 for slot in self.slots if slot.get("url") in self.photos)
        missing = max(self.expected_photos - shown, 0)
        placeholders = 0
        for slot in self.slots:
            url = slot.get("url")
            if url and url in self.photos:
                keep.append(slot)
                continue
            if not url and placeholders < missing:
                placeholders += 1
                keep.append(slot)
                continue
            # A photo the driver removed, or a placeholder no longer needed.
            if delete_message(self.chat_id, slot["message_id"]):
                if url in self.posted:
                    self.posted.remove(url)
                if slot["message_id"] == self.warning_id:
                    self.warning_id = None
                    self.save(warning_message_id=None)
            else:
                keep.append(slot)  # older than 48 hours: stays in the group
        if len(keep) != len(self.slots):
            self.slots = keep
            self.save_posted()

        old_voice = next((u for u in self.posted if u != self.voice and u not in self.photos and _is_voice(u)), None)
        if old_voice and self.voice_message_id and delete_message(self.chat_id, self.voice_message_id):
            self.posted.remove(old_voice)
            self.voice_message_id = None
            self.save(voice_message_id=None)
            self.save_posted()

    def follow_up(self):
        """Files that arrived after the block: photos into their placeholders, the rest as replies."""
        if self.voice and self.voice not in self.posted:
            self.send_voice(reply=True)
        for url in [u for u in self.photos if u not in self.posted]:
            content = _read_file(self.name, url)
            if content is None:
                self.errors.append(f"photo {url}: file not readable")
                continue
            slot = next((s for s in self.slots if not s.get("url") and s.get("message_id")), None)
            # Replacing a photo also replaces its caption: keep the warning on the message that
            # carries it (it is removed once everything is in).
            caption = KH_MEDIA_INCOMPLETE if slot and slot["message_id"] == self.warning_id else None
            if slot and replace_photo_file(self.chat_id, slot["message_id"], _filename(url), content, caption=caption):
                slot["url"] = url
            else:
                ids = send_photo_files(self.chat_id, [(_filename(url), content)], **self.thread, **self.reply())
                if not ids or ids[0] is None:
                    self.errors.append(f"photo {url}: not sent")
                    continue
                # Kept with the album's slots so an edit that removes it can delete it too.
                self.slots.append({"message_id": ids[0], "url": url})
            self.posted.append(url)
            self.save_posted()

    def send_voice(self, reply):
        content = _read_file(self.name, self.voice)
        if content is None:
            self.errors.append(f"voice {self.voice}: file not readable")
            return
        extra = {**self.thread, **(self.reply() if reply else {})}
        message_id = send_voice_file(self.chat_id, _filename(self.voice), content, **extra)
        if message_id:
            self.posted.append(self.voice)
            self.voice_message_id = message_id
            self.save(voice_message_id=str(message_id))
            self.save_posted()
        else:
            self.errors.append(f"voice {self.voice}: not sent")

    def reply(self):
        if not self.summary_id:
            return {}
        return {"reply_parameters": {"message_id": self.summary_id, "allow_sending_without_reply": True}}


def _rows(filters):
    return frappe.get_all(POST_DOCTYPE, filters=filters, pluck="name")


def _enqueue_all(names):
    for name in names:
        try:
            enqueue_post(name)
        except Exception:
            frappe.log_error(title="Delivery app media: sweep could not enqueue", message=name)


def sweep_waiting_app_reports():
    """Every minute (hooks.py cron). App reports not posted yet, WAIT_MINUTES or more old: post
    them now with what has arrived."""
    now = now_datetime()
    _enqueue_all(
        _rows(
            [
                ["posted_at", "is", "not set"],
                ["summary_message_id", "is", "not set"],
                ["done", "=", 0],
                ["creation", "<", add_to_date(now, minutes=-WAIT_MINUTES)],
                ["creation", ">", add_to_date(now, days=-SWEEP_DAYS)],
            ]
        )
    )


def sweep_stalled_app_media():
    """Hourly (hooks.py). App reports from the last SWEEP_DAYS whose files are not all posted:
    retry sends that failed and post late files. Reports not posted yet are included, as a
    backstop for the per-minute sweep."""
    _enqueue_all(_rows([["done", "=", 0], ["creation", ">", add_to_date(now_datetime(), days=-SWEEP_DAYS)]]))
