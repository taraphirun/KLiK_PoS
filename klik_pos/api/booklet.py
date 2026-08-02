import json
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


@frappe.whitelist()
def close_booklet(booklet):
    """Staff sign-off that a booklet's physical pages have all been reconciled. Terminal - a Closed
    booklet is excluded from the lifecycle scheduler entirely (check_booklet_lifecycle below)."""
    try:
        doc = frappe.get_doc("Delivery Booklet", booklet)
        if doc.status == "Closed":
            return {"success": True, "booklet": doc.name, "status": doc.status}

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
def get_booklet_gaps(booklet):
    """Invoice numbers strictly between the lowest and highest reported numbers for this booklet
    that have no matching Delivery Report - a real skipped/missing page, not just "not yet
    delivered" (mirrors the NestJS dashboard's deliberate interior-only gap definition, not the
    booklet's full start-end range, most of which is legitimately just not written yet)."""
    try:
        rows = frappe.get_all("Delivery Report", filters={"booklet": booklet}, pluck="reported_invoice_no")
        numbers = sorted({n for n in (_extract_number(r) for r in rows) if n is not None})
        if len(numbers) < 2:
            return {"success": True, "data": []}

        seen = set(numbers)
        gaps = [n for n in range(numbers[0], numbers[-1] + 1) if n not in seen]
        return {"success": True, "data": gaps}

    except Exception as e:
        frappe.log_error(title="Delivery Booklet gap lookup failed")
        return {"success": False, "message": str(e), "data": []}


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
    checkBooklets. Pure status computation only, no Telegram send here: unlike the original NestJS
    service (which owns its own Telegram bot instance and DMs admins directly), KlikPOS has no
    Telegram integration of its own - the delivery-bot repo's booklet_sync.py polls list_booklets
    (same "KlikPOS -> bot is poll-only" pattern as driver status) and sends the Telegram alert
    itself when it observes a transition to Stalled/Ready for Review.
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

    frappe.db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Daily reconciliation checklist + closing (Module 17, phases/phase-16.md)
# ─────────────────────────────────────────────────────────────────────────────

# Statuses that count as "accounted for" for closing purposes - Partially Delivered is included
# deliberately (decided with the user 2026-08-02): its eventual remainder is a follow-up confirm
# against the *same* invoice, not a new paper page, so it's invisible to this page-number-keyed
# checklist by design and shouldn't block the day from closing.
CLOSABLE_STATUSES = {"Void", "Delivered", "Partially Delivered", "Self Pickup"}

# Maps a closable status to the Delivery Booklet Daily Closing snapshot field it counts toward.
_SUMMARY_COUNT_FIELD = {
    "Delivered": "delivered_count",
    "Partially Delivered": "partially_delivered_count",
    "Self Pickup": "self_pickup_count",
    "Void": "void_count",
}


def _classify_daily_checklist(date):
    """Core of the daily reconciliation checklist - shared by get_daily_reconciliation (read) and
    close_daily_reconciliation (which needs the identical fresh computation to validate against).

    Returns (rows, start_number, end_number, counts) - rows/start/end are None (counts all-zero)
    if nothing was touched on this date at all (not an error, just an empty day).
    """
    invoices = frappe.get_all(
        "Sales Invoice",
        filters={"docstatus": 1, "posting_date": date, "custom_invoice_ref": [">", 0]},
        fields=["name", "custom_invoice_ref", "custom_delivery_status"],
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
    if not numbers_today:
        return [], None, None, {v: 0 for v in _SUMMARY_COUNT_FIELD.values()}

    start_number, end_number = min(numbers_today), max(numbers_today)

    booklets = frappe.get_all(
        "Delivery Booklet",
        filters={"start_number": ["<=", end_number], "end_number": [">=", start_number]},
        fields=["name", "booklet_number", "start_number", "end_number"],
    )
    void_rows = (
        frappe.get_all(
            "Delivery Booklet Void Entry",
            filters={"parent": ["in", [b.name for b in booklets]]},
            fields=["parent", "page_number", "reason"],
        )
        if booklets
        else []
    )
    void_by_number = {v.page_number: v for v in void_rows}

    def _covering_booklet(n):
        return next((b for b in booklets if b.start_number <= n <= b.end_number), None)

    rows = []
    counts = {v: 0 for v in _SUMMARY_COUNT_FIELD.values()}

    for n in range(start_number, end_number + 1):
        booklet = _covering_booklet(n)
        invoice = invoice_by_number.get(n)
        report = report_by_number.get(n)
        void_entry = void_by_number.get(n)

        resolved_delivery_status = None
        if invoice:
            resolved_delivery_status = invoice.custom_delivery_status
        elif report and report.reconciliation_status == "Confirmed" and report.matched_invoice:
            # Confirmed via the normal reconciliation flow (Module 10/15) but not discoverable via
            # custom_invoice_ref above - e.g. an older backfilled invoice from before this ref-
            # stamping fix existed. Falls back to a direct lookup rather than misreporting a fully
            # resolved delivery as "Reported, No Invoice".
            resolved_delivery_status = frappe.db.get_value(
                "Sales Invoice", report.matched_invoice, "custom_delivery_status"
            )
            invoice = frappe._dict(name=report.matched_invoice)

        if void_entry:
            status = "Void"
        elif resolved_delivery_status is not None:
            status = (
                resolved_delivery_status
                if resolved_delivery_status in ("Delivered", "Partially Delivered", "Self Pickup")
                else "Pending Fulfillment"
            )
        elif report:
            status = "Reported, No Invoice"
        else:
            status = "Unresolved"

        if status in _SUMMARY_COUNT_FIELD:
            counts[_SUMMARY_COUNT_FIELD[status]] += 1

        rows.append(
            {
                "number": n,
                "status": status,
                "booklet": booklet.name if booklet else None,
                "booklet_number": booklet.booklet_number if booklet else None,
                "invoice": invoice.name if invoice else None,
                "delivery_report": report.name if report else None,
                "void_reason": void_entry.reason if void_entry else None,
            }
        )

    return rows, start_number, end_number, counts


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
        rows, start_number, end_number, counts = _classify_daily_checklist(date)
        unreferenced_invoices = _get_unreferenced_invoices(date)

        closing = frappe.db.get_value(
            "Delivery Booklet Daily Closing",
            str(date),
            [
                "status",
                "start_number",
                "end_number",
                "delivered_count",
                "partially_delivered_count",
                "self_pickup_count",
                "void_count",
                "closed_by",
                "closed_at",
                "reopened_by",
                "reopened_at",
                "needs_review_reason",
            ],
            as_dict=True,
        )

        if closing and closing.status == "Closed":
            drifted = (closing.start_number, closing.end_number) != (start_number, end_number) or any(
                closing.get(field) != counts[field] for field in _SUMMARY_COUNT_FIELD.values()
            )
            if drifted:
                reason = (
                    f"New activity detected for {date}: range/counts changed since closing "
                    f"(was {closing.start_number}-{closing.end_number}, now {start_number}-{end_number})"
                )
                frappe.db.set_value(
                    "Delivery Booklet Daily Closing",
                    str(date),
                    {"status": "Needs Re-review", "needs_review_reason": reason},
                )
                frappe.db.commit()
                closing.status = "Needs Re-review"
                closing.needs_review_reason = reason

        return {
            "success": True,
            "date": str(date),
            "start_number": start_number,
            "end_number": end_number,
            "data": rows,
            "summary": counts,
            "closing": closing,
            "unreferenced_invoices": unreferenced_invoices,
        }

    except Exception as e:
        frappe.log_error(title="Daily reconciliation checklist failed")
        return {"success": False, "message": str(e), "data": []}


@frappe.whitelist()
def close_daily_reconciliation(date=None):
    """Explicit end-of-day sign-off (Module 17) - hard-blocked until every number in the day's
    range is Void/Delivered/Partially Delivered/Self-Pickup, mirroring "can't close the book with
    blank entries." Recomputes fresh rather than trusting a previous get_daily_reconciliation
    response, so a stale frontend can't sign off on data that's since changed."""
    try:
        date = getdate(date) if date else getdate(nowdate())
        rows, start_number, end_number, counts = _classify_daily_checklist(date)

        if not rows:
            frappe.throw(f"Nothing was touched on {date} - there is no range to close")

        blocking = [r["number"] for r in rows if r["status"] not in CLOSABLE_STATUSES]
        if blocking:
            frappe.throw(
                f"{len(blocking)} number(s) still need action before {date} can be closed: "
                f"{', '.join(str(n) for n in blocking)}"
            )

        existing_name = frappe.db.exists("Delivery Booklet Daily Closing", str(date))
        doc = frappe.get_doc("Delivery Booklet Daily Closing", existing_name) if existing_name else frappe.new_doc(
            "Delivery Booklet Daily Closing"
        )
        doc.closing_date = date
        doc.start_number = start_number
        doc.end_number = end_number
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

        rows, _, _, _ = _classify_daily_checklist(date)
        row = next((r for r in rows if r["number"] == page_number), None)
        if not row or row["status"] != "Unresolved":
            frappe.throw(
                f"Page {page_number} is not Unresolved for {date} - only an Unresolved page can "
                f"be linked to an existing invoice"
            )

        # custom_invoice_ref's Custom Field has allow_on_submit=0 (a pre-existing gap, see
        # bugs.md's BUG-002 - it was created directly on the site, never fully configured), which
        # blocks a normal doc.save() from touching it post-submission. frappe.db.set_value bypasses
        # that document-level submit check for just this column - deliberately scoped rather than
        # flipping allow_on_submit globally, which would also open this field to direct desk-form
        # editing on any submitted invoice, a bigger change than this endpoint needs.
        frappe.db.set_value("Sales Invoice", invoice.name, "custom_invoice_ref", page_number)

        return {"success": True, "invoice_name": invoice.name, "page_number": page_number}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Link invoice to booklet page failed")
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

        # See link_invoice_to_page's comment - frappe.db.set_value bypasses the same
        # allow_on_submit=0 restriction, deliberately scoped to just this column.
        frappe.db.set_value("Sales Invoice", invoice.name, "custom_invoice_ref", 0)

        return {"success": True, "invoice_name": invoice.name}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Unlink invoice page failed")
        return {"success": False, "message": str(e)}
