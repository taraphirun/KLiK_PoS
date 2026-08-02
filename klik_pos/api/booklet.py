import json
import re

import frappe
from frappe.utils import get_datetime, now_datetime

# Ported from hd-delivery-telegram's NestJS dashboard (backend/src/booklets/*,
# backend/src/deliveries/deliveries.controller.ts's candidate-booklets/resolve-booklet, and
# backend/src/workers/db-save.processor.ts's VIP customer match) - Module 16. That dashboard is
# a separate repo/deploy with its own Postgres DB; none of this data reached KlikPOS before now.
# See phases/phase-16.md for the full feasibility writeup and decisions.

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
