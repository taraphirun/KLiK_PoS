import json
import math
import re

import frappe
from frappe.utils import get_datetime, getdate, now_datetime, nowdate

# Booklet registry ported from hd-delivery-telegram's NestJS dashboard (backend/src/booklets/*,
# backend/src/deliveries/deliveries.controller.ts's candidate-booklets/resolve-booklet, and
# backend/src/workers/db-save.processor.ts's VIP customer match) - Module 16, phases/phase-15.md.
# That dashboard is a separate repo/deploy with its own Postgres DB; none of this data reached
# KlikPOS before now.
#
# Daily reconciliation checklist + closing (get_daily_reconciliation and below) - Module 17,
# phases/phase-16.md - the actual end-of-day workflow this shop uses the registry for: accounting
# for every paper page issued that day as Delivered/Partially Delivered/Self-Pickup/Void, with an
# explicit close-of-day sign-off.

OPEN_STATUSES = ("Active", "Stalled", "Ready for Review")
VALID_STATUSES = ("Active", "Stalled", "Ready for Review", "Closed")

BOOKLET_LIST_FIELDS = [
    "name",
    "booklet_number",
    "start_number",
    "end_number",
    "is_vip",
    "customer",
    "status",
    "closed_at",
    "closed_by",
    "creation",
    "modified",
]


def _extract_number(value):
    """Digits-only int parse, tolerant of prefixes/punctuation (e.g. "INV-1234" -> 1234) - mirrors
    the NestJS matching (`invNumStr.replace(/\\D/g, '')`). None if there are no digits at all."""
    digits = re.sub(r"\D", "", str(value or ""))
    return int(digits) if digits else None


def match_booklet_for_invoice(reported_invoice_no, delivery_timestamp=None):
    """Resolve a reported invoice number to a Delivery Booklet by number range, for
    submit_delivery_report to call at ingestion time (mirrors match_delivery_report's role for
    Sales Invoice matching, but against booklets instead).

    Prefers an open (non-Closed) booklet whose range contains the number. Falls back to a Closed
    booklet only if the delivery's own timestamp is not after that booklet's closed_at - a
    late-arriving sync for a booklet that was already closed by the time it arrived should still
    link correctly rather than come up out-of-range. Ties (overlapping ranges, which shouldn't
    normally happen but isn't validated against) prefer the most recently created booklet.

    Returns the Delivery Booklet docname, or None (caller sets is_booklet_out_of_range).
    """
    invoice_num = _extract_number(reported_invoice_no)
    if invoice_num is None:
        return None

    candidates = frappe.get_all(
        "Delivery Booklet",
        filters={"start_number": ["<=", invoice_num], "end_number": [">=", invoice_num]},
        fields=["name", "status", "closed_at"],
        order_by="creation desc",
    )
    if not candidates:
        return None

    open_match = next((c for c in candidates if c.status != "Closed"), None)
    if open_match:
        return open_match.name

    ts = get_datetime(delivery_timestamp) if delivery_timestamp else now_datetime()
    for c in candidates:
        if c.closed_at and ts <= get_datetime(c.closed_at):
            return c.name

    return None


def _find_covering_booklet(page_number):
    """Any booklet (any status - a void mark can land on a since-closed booklet's range too, unlike
    match_booklet_for_invoice which only cares about currently-open ones) whose range contains this
    page number. Most recently created wins on an overlap."""
    candidates = frappe.get_all(
        "Delivery Booklet",
        filters={"start_number": ["<=", page_number], "end_number": [">=", page_number]},
        fields=["name"],
        order_by="creation desc",
        limit=1,
    )
    return candidates[0].name if candidates else None


@frappe.whitelist()
def mark_page_void(page_number, reason=None):
    """Marks a booklet page number void (paper page written, sale cancelled/never happened) -
    Module 17. Auto-resolves the covering booklet the same way ingestion matching does; throws if
    none is registered yet (booklet registration is a prerequisite for the whole feature, same as
    today's invoice-number matching)."""
    try:
        page_number = int(page_number)
        booklet_name = _find_covering_booklet(page_number)
        if not booklet_name:
            frappe.throw(f"No booklet is registered covering page {page_number} - register one first")

        doc = frappe.get_doc("Delivery Booklet", booklet_name)
        if any(e.page_number == page_number for e in doc.void_entries):
            return {"success": True, "booklet": doc.name, "page_number": page_number}

        doc.append(
            "void_entries",
            {
                "page_number": page_number,
                "reason": reason,
                "voided_by": frappe.session.user,
                "voided_at": now_datetime(),
            },
        )
        doc.save(ignore_permissions=True)

        return {"success": True, "booklet": doc.name, "page_number": page_number}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet page void failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def unmark_page_void(page_number):
    """Undo a mistaken void mark."""
    try:
        page_number = int(page_number)
        booklet_name = _find_covering_booklet(page_number)
        if not booklet_name:
            return {"success": True, "page_number": page_number}

        doc = frappe.get_doc("Delivery Booklet", booklet_name)
        remaining = [e for e in doc.void_entries if e.page_number != page_number]
        if len(remaining) == len(doc.void_entries):
            return {"success": True, "booklet": doc.name, "page_number": page_number}

        doc.void_entries = remaining
        doc.save(ignore_permissions=True)

        return {"success": True, "booklet": doc.name, "page_number": page_number}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet page unvoid failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def list_booklets(status=None, search=""):
    """Booklet registry list for the management UI (Todo 041), and the mechanism the bot polls to
    learn about stall/ready-for-review transitions (Todo 043) - same "no push/webhook infra" reason
    as klik_pos.api.driver.list_drivers's docstring: KlikPOS -> bot is poll-only in this
    integration, bot -> KlikPOS is the only direction that pushes."""
    try:
        filters = {}
        if status:
            statuses = [s.strip() for s in status.split(",") if s.strip()]
            if statuses:
                filters["status"] = ["in", statuses]

        or_filters = None
        search = (search or "").strip()
        if search:
            term = f"%{search}%"
            or_filters = [["booklet_number", "like", term]]

        data = frappe.get_all(
            "Delivery Booklet",
            filters=filters,
            or_filters=or_filters,
            fields=BOOKLET_LIST_FIELDS,
            order_by="creation desc",
        )

        customer_names = {d.customer for d in data if d.customer}
        customer_labels = (
            {
                c.name: c.customer_name
                for c in frappe.get_all(
                    "Customer", filters={"name": ["in", list(customer_names)]}, fields=["name", "customer_name"]
                )
            }
            if customer_names
            else {}
        )
        for d in data:
            d["customer_name"] = customer_labels.get(d.customer)

        return {"success": True, "data": data}

    except Exception as e:
        frappe.log_error(title="Delivery Booklet list failed")
        return {"success": False, "message": str(e), "data": []}


@frappe.whitelist()
def upsert_booklet(data):
    """Create or update a booklet from the management UI. Renaming booklet_number (the docname,
    autoname: field:booklet_number) goes through frappe.rename_doc rather than a plain field
    assignment - Frappe doesn't let a Link'd field's autoname source change without it."""
    try:
        if isinstance(data, str):
            data = json.loads(data)

        booklet_number = (data.get("booklet_number") or "").strip()
        if not booklet_number:
            frappe.throw("booklet_number is required")

        start_number = data.get("start_number")
        end_number = data.get("end_number")
        if start_number is None or end_number is None:
            frappe.throw("start_number and end_number are required")
        start_number, end_number = int(start_number), int(end_number)
        if start_number > end_number:
            frappe.throw("start_number must not be greater than end_number")

        is_vip = bool(data.get("is_vip"))
        customer = data.get("customer") or None
        if is_vip and not customer:
            frappe.throw("customer is required for a VIP booklet")

        existing_name = data.get("name")
        if existing_name:
            if not frappe.db.exists("Delivery Booklet", existing_name):
                frappe.throw(f"Delivery Booklet {existing_name} does not exist")
            if existing_name != booklet_number:
                frappe.rename_doc("Delivery Booklet", existing_name, booklet_number, ignore_permissions=True)
            doc = frappe.get_doc("Delivery Booklet", booklet_number)
        else:
            if frappe.db.exists("Delivery Booklet", booklet_number):
                frappe.throw(f"Booklet {booklet_number} already exists")
            doc = frappe.new_doc("Delivery Booklet")
            doc.booklet_number = booklet_number
            doc.status = "Active"

        doc.start_number = start_number
        doc.end_number = end_number
        doc.is_vip = 1 if is_vip else 0
        doc.customer = customer if is_vip else None
        doc.save(ignore_permissions=True)

        return {"success": True, "booklet": doc.name}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet upsert failed")
        return {"success": False, "message": str(e)}


def _classify_booklet_range(booklet_name):
    """Every number in a booklet's *full* start_number-end_number range (all 50 pages, not just
    the interior span between touched numbers), classified the same way as the daily checklist's
    _classify_number - Void/Delivered/Partially Delivered/Self Pickup/Pending Fulfillment/
    Reported-No-Invoice/Unresolved. Scoped to the whole booklet across all time, not one date.

    Gates close_booklet (decided with the user, 2026-08-02: a booklet can't be closed with any
    page still unresolved, mirroring how close_daily_reconciliation already gates a day) and backs
    the Booklets page's readiness view (replaces the old get_booklet_gaps, which only looked at
    Delivery Reports and only the interior span - real gaps like a still-Pending invoice or a
    never-written tail page went unnoticed)."""
    doc = frappe.get_doc("Delivery Booklet", booklet_name)
    start_number, end_number = doc.start_number, doc.end_number

    invoices = frappe.get_all(
        "Sales Invoice",
        filters={"docstatus": 1, "custom_invoice_ref": ["between", [start_number, end_number]]},
        fields=["name", "custom_invoice_ref", "custom_delivery_status", "custom_requested_delivery_date"],
    )
    invoice_by_number = {inv.custom_invoice_ref: inv for inv in invoices}

    report_rows = frappe.get_all(
        "Delivery Report",
        filters={"booklet": doc.name},
        fields=["name", "reported_invoice_no", "reconciliation_status", "matched_invoice", "creation"],
    )
    # Stable sorts compose: lowest-priority first, same pattern get_delivery_reports already uses.
    report_rows.sort(key=lambda r: r.creation, reverse=True)
    report_rows.sort(key=lambda r: r.reconciliation_status == "Confirmed", reverse=True)
    report_by_number = {}
    for r in report_rows:
        n = _extract_number(r.reported_invoice_no)
        if n is not None and n not in report_by_number:
            report_by_number[n] = r

    void_by_number = {v.page_number: v for v in doc.void_entries}

    rows = []
    counts = {v: 0 for v in _SUMMARY_COUNT_FIELD.values()}
    for n in range(start_number, end_number + 1):
        status, row = _classify_number(n, invoice_by_number, report_by_number, void_by_number)
        if status in _SUMMARY_COUNT_FIELD:
            counts[_SUMMARY_COUNT_FIELD[status]] += 1
        rows.append(row)

    return rows, counts


@frappe.whitelist()
def get_booklet_status(booklet):
    """Full-range readiness view for one booklet (Module 17 follow-up, 2026-08-02) - every page
    classified, so staff can see what's blocking a close before attempting it. Replaces the old
    get_booklet_gaps."""
    try:
        rows, counts = _classify_booklet_range(booklet)
        return {"success": True, "data": rows, "summary": counts}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet status lookup failed")
        return {"success": False, "message": str(e), "data": []}


@frappe.whitelist()
def close_booklet(booklet):
    """Staff sign-off that a booklet's physical pages have all been reconciled - hard-blocked
    (decided with the user, 2026-08-02) until every page in the booklet's full range is Void/
    Delivered/Partially Delivered/Self Pickup, mirroring close_daily_reconciliation's own gate.
    Terminal - a Closed booklet is excluded from the lifecycle scheduler entirely
    (check_booklet_lifecycle below).

    Deliberately stricter than close_daily_reconciliation on one point (2026-08-03 follow-up): a
    Scheduled page (set_requested_delivery_date) is NOT enough here, even though it's closable for
    the day - see BOOKLET_CLOSABLE_STATUSES.
    """
    try:
        doc = frappe.get_doc("Delivery Booklet", booklet)
        if doc.status == "Closed":
            return {"success": True, "booklet": doc.name, "status": doc.status}

        rows, _ = _classify_booklet_range(booklet)
        blocking = [row["number"] for row in rows if row["status"] not in BOOKLET_CLOSABLE_STATUSES]
        if blocking:
            frappe.throw(
                f"{len(blocking)} page(s) still need action before booklet #{doc.booklet_number} "
                f"can be closed: {', '.join(str(n) for n in blocking)}"
            )

        doc.status = "Closed"
        doc.closed_at = now_datetime()
        doc.closed_by = frappe.session.user
        doc.save(ignore_permissions=True)

        return {"success": True, "booklet": doc.name, "status": doc.status}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet close failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def delete_booklet(booklet):
    try:
        if frappe.db.exists("Delivery Report", {"booklet": booklet}):
            frappe.throw("Cannot delete a booklet that already has linked Delivery Reports")
        frappe.delete_doc("Delivery Booklet", booklet, ignore_permissions=True)
        return {"success": True}
    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet delete failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def get_candidate_booklets(invoice_no):
    """Booklets whose range contains this invoice number, for the "resolve out-of-range" picker
    (mirrors ResolveBookletModal's GET .../candidate-booklets)."""
    try:
        invoice_num = _extract_number(invoice_no)
        if invoice_num is None:
            return {"success": True, "data": []}

        data = frappe.get_all(
            "Delivery Booklet",
            filters={"start_number": ["<=", invoice_num], "end_number": [">=", invoice_num]},
            fields=BOOKLET_LIST_FIELDS,
            order_by="creation desc",
        )
        return {"success": True, "data": data}

    except Exception as e:
        frappe.log_error(title="Delivery Booklet candidate lookup failed")
        return {"success": False, "message": str(e), "data": []}


@frappe.whitelist()
def resolve_booklet(report_name, booklet):
    """Manually link an out-of-range Delivery Report to a booklet (mirrors PATCH
    .../deliveries/:id/resolve-booklet)."""
    try:
        if not frappe.db.exists("Delivery Booklet", booklet):
            frappe.throw(f"Delivery Booklet {booklet} does not exist")

        report = frappe.get_doc("Delivery Report", report_name)
        report.booklet = booklet
        report.is_booklet_out_of_range = 0
        report.save(ignore_permissions=True)

        return {"success": True, "delivery_report": report.name, "booklet": booklet}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report booklet resolve failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def get_booklet_settings():
    doc = frappe.get_single("Delivery Booklet Settings")
    return {
        "success": True,
        "pages_per_booklet": doc.pages_per_booklet or 50,
        "normal_booklet_stall_days": doc.normal_booklet_stall_days or 1,
        "vip_booklet_stall_days": doc.vip_booklet_stall_days or 3,
    }


@frappe.whitelist()
def update_booklet_settings(data):
    try:
        if isinstance(data, str):
            data = json.loads(data)

        doc = frappe.get_single("Delivery Booklet Settings")
        if data.get("pages_per_booklet") is not None:
            doc.pages_per_booklet = int(data["pages_per_booklet"])
        if data.get("normal_booklet_stall_days") is not None:
            doc.normal_booklet_stall_days = int(data["normal_booklet_stall_days"])
        if data.get("vip_booklet_stall_days") is not None:
            doc.vip_booklet_stall_days = int(data["vip_booklet_stall_days"])
        doc.save(ignore_permissions=True)

        return {"success": True, **get_booklet_settings()}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Booklet settings update failed")
        return {"success": False, "message": str(e)}


def check_booklet_lifecycle():
    """Hourly scheduler job (hooks.py scheduler_events) - ports booklet-lifecycle.service.ts's
    checkBooklets.

    Phase 8.2 (2026-08-05): now alerts directly on a transition into Stalled/Ready for Review, via
    `telegram_notify.send_booklet_status_alert` - ARCHITECTURE.md's "outbound notifications, sent
    by klik_pos calling Telegram's Bot API directly" design. The original plan (and the still-live
    Python bot) instead has `delivery-bot/booklet_sync.py` *poll* `list_booklets` and track each
    booklet's last-seen status itself purely to detect the same transition klik_pos already knows
    about firsthand - unnecessary once klik_pos can send Telegram messages itself, so this alerts
    right where the transition is computed, `new_status != booklet.status`, instead.

    Each alert is enqueued rather than sent inline, `enqueue_after_commit=True` - this function
    processes many booklets before its single `frappe.db.commit()` at the end, so this guarantees
    an alert only fires for a status change that's actually persisted, never one later rolled back
    by an exception elsewhere in the same run.
    """
    settings = get_booklet_settings()
    pages_per_booklet = settings["pages_per_booklet"]

    booklets = frappe.get_all(
        "Delivery Booklet",
        filters={"status": ["in", OPEN_STATUSES]},
        fields=["name", "status", "is_vip", "start_number", "end_number", "creation"],
    )

    for booklet in booklets:
        stall_days = settings["vip_booklet_stall_days"] if booklet.is_vip else settings["normal_booklet_stall_days"]

        reports = frappe.get_all(
            "Delivery Report",
            filters={"booklet": booklet.name},
            fields=["reported_invoice_no", "creation"],
            order_by="creation desc",
        )

        if not reports:
            days_since_creation = (now_datetime() - get_datetime(booklet.creation)).total_seconds() / 86400
            if days_since_creation > stall_days and booklet.status == "Active":
                frappe.db.set_value("Delivery Booklet", booklet.name, "status", "Stalled")
                _enqueue_booklet_alert(booklet.name, "Stalled")
            continue

        numbers = {n for n in (_extract_number(r.reported_invoice_no) for r in reports) if n is not None}
        is_ready = len(reports) >= pages_per_booklet or booklet.end_number in numbers

        if is_ready:
            new_status = "Ready for Review"
        else:
            days_since_last = (now_datetime() - get_datetime(reports[0].creation)).total_seconds() / 86400
            if days_since_last > stall_days:
                new_status = "Stalled"
            else:
                new_status = "Active"

        if new_status != booklet.status:
            frappe.db.set_value("Delivery Booklet", booklet.name, "status", new_status)
            _enqueue_booklet_alert(booklet.name, new_status)

    frappe.db.commit()


def _enqueue_booklet_alert(booklet_number, new_status):
    """send_booklet_status_alert itself no-ops on Active/Closed (only Stalled/Ready for Review are
    alert-worthy), but the check happens here too so a job whose enqueue fails logs against a
    status that was actually worth alerting on, not noise for every ordinary Active tick."""
    if new_status not in ("Stalled", "Ready for Review"):
        return
    try:
        frappe.enqueue(
            "klik_pos.api.telegram_notify.send_booklet_status_alert",
            queue="short",
            enqueue_after_commit=True,
            booklet_number=booklet_number,
            new_status=new_status,
        )
    except Exception:
        frappe.log_error(title="Failed to enqueue booklet status alert", message=f"{booklet_number}: {new_status}")


# ─────────────────────────────────────────────────────────────────────────────
# Daily reconciliation checklist + closing (Module 17, phases/phase-16.md)
# ─────────────────────────────────────────────────────────────────────────────

# Statuses that count as "accounted for" for closing a *day* (close_daily_reconciliation) -
# Partially Delivered is included deliberately (decided with the user 2026-08-02): its eventual
# remainder is a follow-up confirm against the *same* invoice, not a new paper page, so it's
# invisible to this page-number-keyed checklist by design and shouldn't block the day from
# closing. Scheduled (2026-08-03 follow-up) is included the same way: its eventual real delivery
# re-surfaces, actionable, on the *requested* delivery date's own checklist instead (see
# _get_scheduled_deliveries) - not a new paper page either, so it doesn't block this date's close.
CLOSABLE_STATUSES = {"Void", "Delivered", "Partially Delivered", "Self Pickup", "Scheduled"}

# Statuses that count as "accounted for" for closing a *booklet* (close_booklet) - deliberately
# excludes Scheduled (decided with the user, 2026-08-03): closing a booklet retires it forever, so
# a page whose real delivery outcome is still unknown shouldn't be enough to sign off on - unlike
# closing a day, there's no later checklist that re-surfaces it once the booklet itself is Closed.
BOOKLET_CLOSABLE_STATUSES = CLOSABLE_STATUSES - {"Scheduled"}

# Maps a closable status to the Delivery Booklet Daily Closing snapshot field it counts toward.
_SUMMARY_COUNT_FIELD = {
    "Delivered": "delivered_count",
    "Partially Delivered": "partially_delivered_count",
    "Self Pickup": "self_pickup_count",
    "Void": "void_count",
    "Scheduled": "scheduled_count",
}


def _resolve_booklet_bucket(number, pages_per_booklet, registered_booklets):
    """Which booklet a page number belongs to, for clustering (Module 17 follow-up, 2026-08-02) -
    prompted by a real report of two invoices ~1000 apart on the same day producing ~1000 fake
    "Unresolved" rows in between, because the old logic took one min/max across the whole day
    regardless of booklet boundaries.

    Prefers an actual registered Delivery Booklet (any status) covering the number. Falls back to
    an *implied* bucket computed from pages_per_booklet - sequential integer booklet numbering,
    page 1 of booklet 1 = page number 1 - validated live against this shop's real registered
    booklets (#45 covers exactly 2201-2250 with pages_per_booklet=50, matching the formula
    exactly), so a booklet doesn't need to be registered yet for its pages to cluster correctly.

    Returns (key, booklet_name_or_None, booklet_number, is_registered, bucket_start, bucket_end).
    """
    for b in registered_booklets:
        if b.start_number <= number <= b.end_number:
            return b.name, b.name, b.booklet_number, True, b.start_number, b.end_number

    idx = math.ceil(number / pages_per_booklet)
    bucket_start = (idx - 1) * pages_per_booklet + 1
    bucket_end = idx * pages_per_booklet
    return f"__implied_{idx}", None, str(idx), False, bucket_start, bucket_end


def _classify_number(n, invoice_by_number, report_by_number, void_by_number):
    """Per-number classification - Void / Delivered / Partially Delivered / Self Pickup /
    Scheduled / Pending Fulfillment / Reported-No-Invoice / Unresolved. Factored out of
    _classify_daily_checklist so it's called once per number regardless of how numbers are grouped
    into booklets."""
    invoice = invoice_by_number.get(n)
    report = report_by_number.get(n)
    void_entry = void_by_number.get(n)

    resolved_delivery_status = None
    requested_delivery_date = None
    if invoice:
        resolved_delivery_status = invoice.custom_delivery_status
        requested_delivery_date = invoice.get("custom_requested_delivery_date")
    elif report and report.reconciliation_status == "Confirmed" and report.matched_invoice:
        # Confirmed via the normal reconciliation flow (Module 10/15) but not discoverable via
        # custom_invoice_ref above - e.g. an older backfilled invoice from before the ref-stamping
        # fix existed. Falls back to a direct lookup rather than misreporting a fully resolved
        # delivery as "Reported, No Invoice".
        resolved_delivery_status = frappe.db.get_value(
            "Sales Invoice", report.matched_invoice, "custom_delivery_status"
        )
        invoice = frappe._dict(name=report.matched_invoice)

    if void_entry:
        status = "Void"
    elif resolved_delivery_status in ("Delivered", "Partially Delivered", "Self Pickup"):
        status = resolved_delivery_status
    elif resolved_delivery_status is not None and requested_delivery_date:
        # Purchased today, asked for a later delivery (2026-08-03 follow-up) - resolved here, but
        # the invoice re-surfaces actionable on the *requested* date's own checklist instead (see
        # _get_scheduled_deliveries), so it isn't lost track of.
        status = "Scheduled"
    elif resolved_delivery_status is not None:
        status = "Pending Fulfillment"
    elif report:
        status = "Reported, No Invoice"
    else:
        status = "Unresolved"

    row = {
        "number": n,
        "status": status,
        "invoice": invoice.name if invoice else None,
        "delivery_report": report.name if report else None,
        "void_reason": void_entry.reason if void_entry else None,
        "requested_delivery_date": str(requested_delivery_date) if requested_delivery_date else None,
    }
    return status, row


def _classify_daily_checklist(date):
    """Core of the daily reconciliation checklist - shared by get_daily_reconciliation (read) and
    close_daily_reconciliation (which needs the identical fresh computation to validate against).

    Clusters every touched number by its (real-or-implied) booklet (see _resolve_booklet_bucket),
    then computes the interior min/max *within each cluster separately* - not one min/max across
    the whole day, which would span every gap between unrelated booklets (the bug this was
    rewritten to fix, 2026-08-02). Most of an unfinished booklet is legitimately "not written yet,"
    not a gap - this daily view stays interior-only even though _classify_booklet_range (used by
    close_booklet/get_booklet_status) deliberately checks a booklet's *entire* range instead: that
    check gates permanently closing a booklet, so it can't stop at "what's been touched so far."

    Returns (groups, counts). Each group: booklet/booklet_number/is_registered/start_number/
    end_number (interior span actually touched)/bucket_start/bucket_end (the booklet's full
    range, registered or implied - for the "Register this booklet" UI shortcut)/rows. groups is
    empty (counts all-zero) if nothing was touched on this date at all.
    """
    invoices = frappe.get_all(
        "Sales Invoice",
        filters={"docstatus": 1, "posting_date": date, "custom_invoice_ref": [">", 0]},
        fields=["name", "custom_invoice_ref", "custom_delivery_status", "custom_requested_delivery_date"],
    )
    invoice_by_number = {inv.custom_invoice_ref: inv for inv in invoices}

    report_rows = frappe.db.sql(
        """
        SELECT name, reported_invoice_no, reconciliation_status, matched_invoice, creation
        FROM `tabDelivery Report`
        WHERE reported_invoice_no IS NOT NULL AND reported_invoice_no != ''
        AND DATE(COALESCE(delivery_timestamp, creation)) = %s
        ORDER BY reconciliation_status = 'Confirmed' DESC, creation DESC
        """,
        (date,),
        as_dict=True,
    )
    report_by_number = {}
    for r in report_rows:
        n = _extract_number(r.reported_invoice_no)
        if n is not None and n not in report_by_number:
            report_by_number[n] = r

    numbers_today = set(invoice_by_number) | set(report_by_number)
    counts = {v: 0 for v in _SUMMARY_COUNT_FIELD.values()}
    if not numbers_today:
        return [], counts

    settings = get_booklet_settings()
    pages_per_booklet = settings["pages_per_booklet"]
    registered_booklets = frappe.get_all(
        "Delivery Booklet", fields=["name", "booklet_number", "start_number", "end_number"]
    )

    buckets = {}
    for n in numbers_today:
        key, booklet_name, booklet_number, is_registered, bucket_start, bucket_end = _resolve_booklet_bucket(
            n, pages_per_booklet, registered_booklets
        )
        bucket = buckets.setdefault(
            key,
            {
                "booklet": booklet_name,
                "booklet_number": booklet_number,
                "is_registered": is_registered,
                "bucket_start": bucket_start,
                "bucket_end": bucket_end,
                "numbers": set(),
            },
        )
        bucket["numbers"].add(n)

    registered_names = [b["booklet"] for b in buckets.values() if b["booklet"]]
    void_rows = (
        frappe.get_all(
            "Delivery Booklet Void Entry",
            filters={"parent": ["in", registered_names]},
            fields=["parent", "page_number", "reason"],
        )
        if registered_names
        else []
    )
    void_by_number = {v.page_number: v for v in void_rows}

    groups = []
    for bucket in sorted(buckets.values(), key=lambda b: b["bucket_start"]):
        start_number, end_number = min(bucket["numbers"]), max(bucket["numbers"])
        rows = []
        for n in range(start_number, end_number + 1):
            status, row = _classify_number(n, invoice_by_number, report_by_number, void_by_number)
            if status in _SUMMARY_COUNT_FIELD:
                counts[_SUMMARY_COUNT_FIELD[status]] += 1
            rows.append(row)

        groups.append(
            {
                "booklet": bucket["booklet"],
                "booklet_number": bucket["booklet_number"],
                "is_registered": bucket["is_registered"],
                "start_number": start_number,
                "end_number": end_number,
                "bucket_start": bucket["bucket_start"],
                "bucket_end": bucket["bucket_end"],
                "rows": rows,
            }
        )

    return groups, counts


def _get_unreferenced_invoices(date):
    """Sales Invoices submitted on `date` with no custom_invoice_ref at all - invisible to the
    numbered checklist above since there's no page number to place them at. Purely informational
    (added 2026-08-02 at the user's request): surfaces sales that happened outside the paper-
    booklet tracking entirely, so staff can catch a forgotten paper-number entry vs. a genuinely
    paperless sale - deliberately does NOT feed into CLOSABLE/blocking logic. Closing stays scoped
    to the physical booklet's min-max range only, exactly as before this was added."""
    return frappe.get_all(
        "Sales Invoice",
        filters={"docstatus": 1, "posting_date": date, "custom_invoice_ref": ["in", (0, None)]},
        fields=["name", "customer", "customer_name", "grand_total", "custom_delivery_status"],
        order_by="creation asc",
    )


def _get_scheduled_deliveries(date):
    """Invoices whose custom_requested_delivery_date is `date` (2026-08-03 follow-up) - the paper
    page itself belongs to an earlier posting_date's booklet group (already resolved there as
    'Scheduled'), but the actual delivery commitment is due *today*, so it surfaces again here,
    actionable, and blocks *this* date's Close Day until Delivered/Self-Pickup is confirmed for
    real. Unlike _get_unreferenced_invoices this is NOT purely informational - see the blocking
    check in close_daily_reconciliation/get_daily_reconciliation.

    Returns rows shaped like a DailyPageRow's action-relevant fields, keyed by invoice instead of
    page number: {invoice, customer, page_number, status, requested_delivery_date}. status is
    never 'Scheduled' here (that's the origin date's label for this same invoice) - it resolves to
    Delivered/Partially Delivered/Self Pickup (closable) or Pending Fulfillment (blocking), exactly
    like _classify_number would for a normal booklet page.
    """
    invoices = frappe.get_all(
        "Sales Invoice",
        filters={"docstatus": 1, "custom_requested_delivery_date": date},
        fields=[
            "name",
            "customer",
            "customer_name",
            "custom_invoice_ref",
            "custom_delivery_status",
            "custom_requested_delivery_date",
        ],
        order_by="creation asc",
    )
    rows = []
    for inv in invoices:
        status = (
            inv.custom_delivery_status
            if inv.custom_delivery_status in ("Delivered", "Partially Delivered", "Self Pickup")
            else "Pending Fulfillment"
        )
        rows.append(
            {
                "invoice": inv.name,
                "customer": inv.customer_name or inv.customer,
                "page_number": inv.custom_invoice_ref or None,
                "status": status,
                "requested_delivery_date": str(inv.custom_requested_delivery_date),
            }
        )
    return rows


def _scheduled_summary(rows):
    """Compact snapshot of _get_scheduled_deliveries's rows for storage/drift comparison,
    mirroring _groups_summary's role for booklet groups."""
    return [{"invoice": r["invoice"], "status": r["status"]} for r in rows]


def _flatten_rows(groups):
    return [row for group in groups for row in group["rows"]]


def _groups_summary(groups):
    """Compact per-group snapshot for storage on Delivery Booklet Daily Closing and for the
    drift comparison in get_daily_reconciliation's lazy re-review check."""
    return [
        {
            "booklet": g["booklet"],
            "booklet_number": g["booklet_number"],
            "is_registered": g["is_registered"],
            "start_number": g["start_number"],
            "end_number": g["end_number"],
        }
        for g in groups
    ]


@frappe.whitelist()
def get_daily_reconciliation(date=None):
    """End-of-day checklist (Module 17): every invoice/page number touched on `date` (defaults to
    today), classified as Void / Delivered / Partially Delivered / Self Pickup / Pending
    Fulfillment / Reported-No-Invoice / Unresolved. See phases/phase-16.md for the full design.

    Also carries a lazy re-review check: if this date already has a Closed closing record, its
    stored snapshot is compared against a fresh computation - on drift (new data arrived since
    closing), the closing record is flipped to "Needs Re-review" right here, so a list view of
    closings surfaces exactly which days need another look without anyone having to reopen each
    one to notice.
    """
    try:
        date = getdate(date) if date else getdate(nowdate())
        groups, counts = _classify_daily_checklist(date)
        unreferenced_invoices = _get_unreferenced_invoices(date)
        scheduled_deliveries = _get_scheduled_deliveries(date)
        current_summary = _groups_summary(groups)
        current_scheduled_summary = _scheduled_summary(scheduled_deliveries)

        closing = frappe.db.get_value(
            "Delivery Booklet Daily Closing",
            str(date),
            [
                "status",
                "groups_summary",
                "scheduled_summary",
                "delivered_count",
                "partially_delivered_count",
                "self_pickup_count",
                "void_count",
                "scheduled_count",
                "closed_by",
                "closed_at",
                "reopened_by",
                "reopened_at",
                "needs_review_reason",
            ],
            as_dict=True,
        )

        if closing and closing.status == "Closed":
            stored_summary = json.loads(closing.groups_summary) if closing.groups_summary else []
            stored_scheduled_summary = json.loads(closing.scheduled_summary) if closing.scheduled_summary else []
            drifted = (
                stored_summary != current_summary
                or stored_scheduled_summary != current_scheduled_summary
                or any(closing.get(field) != counts[field] for field in _SUMMARY_COUNT_FIELD.values())
            )
            if drifted:
                reason = f"New activity detected for {date}: booklet groups/scheduled deliveries/counts changed since closing"
                frappe.db.set_value(
                    "Delivery Booklet Daily Closing",
                    str(date),
                    {"status": "Needs Re-review", "needs_review_reason": reason},
                )
                frappe.db.commit()
                closing.status = "Needs Re-review"
                closing.needs_review_reason = reason

        if closing and closing.groups_summary:
            closing.groups_summary = json.loads(closing.groups_summary)
        if closing and closing.scheduled_summary:
            closing.scheduled_summary = json.loads(closing.scheduled_summary)

        return {
            "success": True,
            "date": str(date),
            "groups": groups,
            "summary": counts,
            "closing": closing,
            "unreferenced_invoices": unreferenced_invoices,
            "scheduled_deliveries": scheduled_deliveries,
        }

    except Exception as e:
        frappe.log_error(title="Daily reconciliation checklist failed")
        return {"success": False, "message": str(e), "groups": []}


@frappe.whitelist()
def close_daily_reconciliation(date=None):
    """Explicit end-of-day sign-off (Module 17) - hard-blocked until every number in the day's
    range is Void/Delivered/Partially Delivered/Self-Pickup, mirroring "can't close the book with
    blank entries." Recomputes fresh rather than trusting a previous get_daily_reconciliation
    response, so a stale frontend can't sign off on data that's since changed."""
    try:
        date = getdate(date) if date else getdate(nowdate())
        groups, counts = _classify_daily_checklist(date)
        scheduled_deliveries = _get_scheduled_deliveries(date)

        if not groups and not scheduled_deliveries:
            frappe.throw(f"Nothing was touched on {date} - there is no range to close")

        blocking_numbers = [row["number"] for row in _flatten_rows(groups) if row["status"] not in CLOSABLE_STATUSES]
        blocking_invoices = [row["invoice"] for row in scheduled_deliveries if row["status"] not in CLOSABLE_STATUSES]
        if blocking_numbers or blocking_invoices:
            parts = []
            if blocking_numbers:
                parts.append(f"{len(blocking_numbers)} number(s): {', '.join(str(n) for n in blocking_numbers)}")
            if blocking_invoices:
                parts.append(f"{len(blocking_invoices)} scheduled delivery(ies): {', '.join(blocking_invoices)}")
            return {
                "success": False,
                "message": f"Still need action before {date} can be closed - " + "; ".join(parts),
                "blocking_numbers": blocking_numbers,
                "blocking_invoices": blocking_invoices,
            }

        existing_name = frappe.db.exists("Delivery Booklet Daily Closing", str(date))
        doc = frappe.get_doc("Delivery Booklet Daily Closing", existing_name) if existing_name else frappe.new_doc(
            "Delivery Booklet Daily Closing"
        )
        doc.closing_date = date
        doc.groups_summary = json.dumps(_groups_summary(groups))
        doc.scheduled_summary = json.dumps(_scheduled_summary(scheduled_deliveries))
        for field, value in counts.items():
            setattr(doc, field, value)
        doc.status = "Closed"
        doc.closed_by = frappe.session.user
        doc.closed_at = now_datetime()
        doc.needs_review_reason = None
        doc.save(ignore_permissions=True)

        return {"success": True, "date": str(date), "status": doc.status, "closed_by": doc.closed_by, "closed_at": str(doc.closed_at)}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Daily reconciliation close failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def reopen_daily_reconciliation(date=None):
    """Undo a closing - System Manager only (decided with the user, 2026-08-02: closing is a real
    sign-off, not something undone casually). Leaves the original closed_by/closed_at as history
    rather than clearing them."""
    try:
        if "System Manager" not in frappe.get_roles(frappe.session.user):
            frappe.throw("Only a System Manager can reopen a daily closing")

        date = getdate(date) if date else getdate(nowdate())
        if not frappe.db.exists("Delivery Booklet Daily Closing", str(date)):
            frappe.throw(f"{date} has not been closed - nothing to reopen")

        doc = frappe.get_doc("Delivery Booklet Daily Closing", str(date))
        doc.status = "Reopened"
        doc.reopened_by = frappe.session.user
        doc.reopened_at = now_datetime()
        doc.save(ignore_permissions=True)

        return {"success": True, "date": str(date), "status": doc.status}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Daily reconciliation reopen failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def link_invoice_to_page(invoice_name, page_number, date=None):
    """Attaches an existing unreferenced invoice (Todo 050) to a specific booklet page number -
    the common case being a cashier who forgot to type the paper number at checkout for a sale
    that genuinely has one, rather than that page being truly forgotten end-to-end. Cheaper than
    the alternative (void the page, leave the invoice orphaned, or create a redundant second
    invoice via create_invoice_for_unreported_page).

    Only onto a currently-Unresolved page (decided with the user, 2026-08-02) - not
    Reported-No-Invoice, which already has its own Delivery-Report-based Create Invoice flow that
    this would conflict with.
    """
    try:
        page_number = int(page_number)
        date = getdate(date) if date else getdate(nowdate())

        invoice = frappe.get_doc("Sales Invoice", invoice_name)
        if invoice.docstatus != 1:
            frappe.throw(f"Sales Invoice {invoice_name} is not submitted")
        if invoice.custom_invoice_ref:
            frappe.throw(f"{invoice_name} already has a reference ({invoice.custom_invoice_ref})")

        groups, _ = _classify_daily_checklist(date)
        row = next((r for r in _flatten_rows(groups) if r["number"] == page_number), None)
        if not row or row["status"] != "Unresolved":
            frappe.throw(
                f"Page {page_number} is not Unresolved for {date} - only an Unresolved page can "
                f"be linked to an existing invoice"
            )

        # custom_invoice_ref now has allow_on_submit=1 (BUG-002, fixed 2026-08-03), so doc.save()
        # would work here too - frappe.db.set_value is used anyway, deliberately: a single-field
        # admin correction like this shouldn't re-run the full Sales Invoice validate/stock chain
        # a full save() would trigger.
        frappe.db.set_value("Sales Invoice", invoice.name, "custom_invoice_ref", page_number)

        return {"success": True, "invoice_name": invoice.name, "page_number": page_number}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Link invoice to booklet page failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def set_requested_delivery_date(invoice_name, date):
    """Marks a still-Pending booklet page as scheduled for delivery on a later date (2026-08-03
    follow-up, user request): "some invoice where purchased today but was asked to deliver at a
    later date." Resolves the page on its own posting date (status becomes 'Scheduled', counts
    toward closing) but the invoice re-surfaces, actionable, on the target date's own checklist via
    _get_scheduled_deliveries - so the commitment isn't just noted and forgotten.

    Reversible via clear_requested_delivery_date, and callable again to reschedule, both only while
    still Pending/Not Delivered (decided with the user 2026-08-03) - matches unlink_invoice_page's
    own gating: once delivery/pickup is actually confirmed, touching the paper reference is
    materially riskier than adjusting an unconfirmed schedule.
    """
    try:
        invoice = frappe.get_doc("Sales Invoice", invoice_name)
        if invoice.docstatus != 1:
            frappe.throw(f"Sales Invoice {invoice_name} is not submitted")
        if invoice.custom_delivery_status not in ("Pending", "Not Delivered"):
            frappe.throw(
                f"{invoice_name}'s delivery status is already {invoice.custom_delivery_status} - "
                f"can only schedule a still-pending invoice"
            )

        target_date = getdate(date)
        if target_date <= getdate(invoice.posting_date):
            frappe.throw("Requested delivery date must be after the invoice's own posting date")

        # allow_on_submit=1 on this field (see install.py), so a plain save() would work too -
        # frappe.db.set_value used anyway for the same reason as link_invoice_to_page's own use of
        # it just above: a single-field change shouldn't re-run the full validate/stock chain.
        frappe.db.set_value(
            "Sales Invoice", invoice.name, "custom_requested_delivery_date", target_date
        )

        return {"success": True, "invoice_name": invoice.name, "requested_delivery_date": str(target_date)}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Set requested delivery date failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def clear_requested_delivery_date(invoice_name):
    """Undoes set_requested_delivery_date - the page goes back to Pending Fulfillment on its own
    posting date, and the invoice drops out of the target date's scheduled-deliveries group.
    Same Pending/Not Delivered gating as set_requested_delivery_date."""
    try:
        invoice = frappe.get_doc("Sales Invoice", invoice_name)
        if invoice.docstatus != 1:
            frappe.throw(f"Sales Invoice {invoice_name} is not submitted")
        if invoice.custom_delivery_status not in ("Pending", "Not Delivered"):
            frappe.throw(
                f"{invoice_name}'s delivery status is already {invoice.custom_delivery_status} - "
                f"can only clear a still-pending invoice's scheduled date"
            )

        frappe.db.set_value("Sales Invoice", invoice.name, "custom_requested_delivery_date", None)

        return {"success": True, "invoice_name": invoice.name}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Clear requested delivery date failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def unlink_invoice_page(invoice_name):
    """Undoes link_invoice_to_page - clears the invoice's reference back out, sending the page
    back to Unresolved and the invoice back to the unreferenced-invoices list. Scoped to invoices
    still Pending/Not Delivered only (decided with the user, 2026-08-02, matches the Confirm
    Self-Pickup/Confirm Delivered gating) - once delivery/pickup is actually confirmed, unlinking
    the paper reference is a materially riskier action than undoing an unconfirmed data-entry
    attachment, so it's deliberately not offered here."""
    try:
        invoice = frappe.get_doc("Sales Invoice", invoice_name)
        if invoice.docstatus != 1:
            frappe.throw(f"Sales Invoice {invoice_name} is not submitted")
        if invoice.custom_delivery_status not in ("Pending", "Not Delivered"):
            frappe.throw(
                f"{invoice_name}'s delivery status is already {invoice.custom_delivery_status} - "
                f"can only unlink a page reference while still Pending"
            )

        # See link_invoice_to_page's comment - same deliberate choice of frappe.db.set_value over
        # doc.save() for a single-field change.
        frappe.db.set_value("Sales Invoice", invoice.name, "custom_invoice_ref", 0)

        return {"success": True, "invoice_name": invoice.name}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Unlink invoice page failed")
        return {"success": False, "message": str(e)}
