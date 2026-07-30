import difflib
import json
import re

import frappe
from frappe.utils import add_days, flt, get_datetime, nowdate

from klik_pos.api.sales_invoice import create_payment_entry

# completion_status (Delivery Report) -> custom_delivery_status (Sales Invoice, Todo 020).
DELIVERY_STATUS_MAP = {"Full": "Delivered", "Partial": "Partially Delivered"}

ALLOWED_COMPLETION_STATUSES = {"Full", "Partial"}
ALLOWED_PAYMENT_STATUSES = {"Paid", "Unpaid", "Partial"}
REQUIRED_FIELDS = ("bot_delivery_id", "reported_invoice_no", "completion_status", "payment_status")

# Auto-match tuning. Only invoice-number matching is implemented (exact / normalized / fuzzy) -
# no customer or amount attribute matching, because Delivery Report has no bot-reported customer
# or amount field to match against (amount_collected is filled in by a human during confirm,
# Todo 023, not by the bot) - decided 2026-07-30.
FUZZY_CANDIDATE_WINDOW_DAYS = 30
EXACT_CONFIDENCE = 1.0
NORMALIZED_EXACT_CONFIDENCE = 0.92
FUZZY_MAX_CONFIDENCE = 0.85
FUZZY_MIN_CONFIDENCE = 0.6


def _validate_delivery_payload(data):
    missing = [f for f in REQUIRED_FIELDS if not data.get(f)]
    if missing:
        frappe.throw(f"Missing required field(s): {', '.join(missing)}")

    if data.get("completion_status") not in ALLOWED_COMPLETION_STATUSES:
        frappe.throw(
            f"Invalid completion_status '{data.get('completion_status')}', "
            f"expected one of {sorted(ALLOWED_COMPLETION_STATUSES)}"
        )

    if data.get("payment_status") not in ALLOWED_PAYMENT_STATUSES:
        frappe.throw(
            f"Invalid payment_status '{data.get('payment_status')}', "
            f"expected one of {sorted(ALLOWED_PAYMENT_STATUSES)}"
        )


def _safe_nonzero_int(value):
    """Parse value as an int, or None if it isn't purely numeric or is 0 (custom_invoice_ref's
    unset default - see match_delivery_report tier 1)."""
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed or None


def _normalize_invoice_no(value):
    """Upper-case, strip everything but letters/digits - tolerates dashes, spaces, and case
    typos ("acc sinv 2026 21" vs "ACC-SINV-2026-00021") without touching real content.
    str()-cast first since custom_invoice_ref comes back as an int, not text (see tier 1)."""
    return re.sub(r"[^A-Z0-9]", "", str(value or "").upper())


def _fetch_candidate_invoices():
    """Bounded candidate pool for normalized/fuzzy matching (tiers 2-3 below).

    Tier 1 (verbatim exact) queries the DB directly with no date bound - a unique-indexed exact
    lookup is cheap regardless of table size. Tiers 2-3 run in Python (normalization + string
    similarity aren't expressible in SQL), so the pool has to be bounded to stay fast; deliveries
    reconcile against recent invoices, not months-old ones, so a rolling window is the natural
    bound given there's no customer/amount signal available to narrow the search instead.
    """
    cutoff = add_days(nowdate(), -FUZZY_CANDIDATE_WINDOW_DAYS)
    return frappe.get_all(
        "Sales Invoice",
        filters={"docstatus": 1, "posting_date": [">=", cutoff]},
        fields=["name", "custom_invoice_ref", "outstanding_amount", "custom_delivery_status"],
    )


def _prefer_undelivered_unpaid(candidates):
    """Tie-break among equally-scored candidates: prefer invoices still owing money and not yet
    marked delivered, per Todo 022's tie-break rule."""

    def rank(c):
        unpaid_rank = 0 if flt(c.outstanding_amount) > 0 else 1
        undelivered_rank = 0 if c.custom_delivery_status != "Delivered" else 1
        return (unpaid_rank, undelivered_rank)

    return sorted(candidates, key=rank)[0]


def _apply_match(report, invoice_name, confidence, note):
    report.matched_invoice = invoice_name
    report.match_confidence = confidence
    report.reconciliation_status = "Suggested"
    report.match_notes = note


def match_delivery_report(report):
    """Resolve a Delivery Report to a real Sales Invoice by invoice number alone.

    Structured-to-structured matching only, per the Phase 9 system boundary - the bot already
    resolved everything it can (no OCR/AI here). Only invoice-number signals exist to match on
    (see module docstring above for why customer/amount attribute matching was dropped: Delivery
    Report has neither field populated by the bot). Three tiers, highest confidence first:
      1. Verbatim exact match against Sales Invoice `name` or `custom_invoice_ref`.
      2. Match after normalizing case/punctuation (typo/format tolerant).
      3. Fuzzy string similarity (difflib) against a bounded recent-invoice pool.
    A suggestion only - mutates the in-memory `report` doc alone, never the invoice. Read-only
    with respect to Sales Invoices. Safe to call again (e.g. a manual re-match, Todo 023), except
    it refuses to touch a report a human has already confirmed or rejected.
    """
    if report.reconciliation_status in ("Confirmed", "Rejected"):
        return

    report.matched_invoice = None
    report.match_confidence = 0
    report.reconciliation_status = "Unmatched"
    report.match_notes = None

    reported_no = (report.reported_invoice_no or "").strip()
    if not reported_no:
        return

    # Tier 1: verbatim exact match (unbounded - cheap indexed lookup).
    # custom_invoice_ref is an Int column defaulting to 0 (not Data/text, despite the name) - a
    # naive string filter lets MySQL coerce a non-numeric reported_no to 0 and match every
    # invoice that still has the untouched default. Only query it when reported_no is itself a
    # non-zero integer, and compare as an int.
    exact_name = frappe.db.get_value("Sales Invoice", {"name": reported_no}, "name")
    if not exact_name:
        ref_as_int = _safe_nonzero_int(reported_no)
        if ref_as_int is not None:
            exact_name = frappe.db.get_value("Sales Invoice", {"custom_invoice_ref": ref_as_int}, "name")
    if exact_name:
        _apply_match(report, exact_name, EXACT_CONFIDENCE, "Exact invoice number match")
        return

    normalized_reported = _normalize_invoice_no(reported_no)
    if not normalized_reported:
        return

    candidates = _fetch_candidate_invoices()

    # Tier 2: match after normalizing (case/punctuation-tolerant).
    normalized_hits = [
        c
        for c in candidates
        if _normalize_invoice_no(c.name) == normalized_reported
        or (c.custom_invoice_ref and _normalize_invoice_no(c.custom_invoice_ref) == normalized_reported)
    ]
    if normalized_hits:
        best = _prefer_undelivered_unpaid(normalized_hits)
        _apply_match(
            report, best.name, NORMALIZED_EXACT_CONFIDENCE, "Matched after normalizing case/punctuation"
        )
        return

    # Tier 3: fuzzy similarity - bias toward leaving Unmatched when uncertain (Todo 022 risk note).
    scored = []
    for c in candidates:
        score = difflib.SequenceMatcher(None, normalized_reported, _normalize_invoice_no(c.name)).ratio()
        if c.custom_invoice_ref:
            score = max(
                score,
                difflib.SequenceMatcher(
                    None, normalized_reported, _normalize_invoice_no(c.custom_invoice_ref)
                ).ratio(),
            )
        if score >= FUZZY_MIN_CONFIDENCE:
            scored.append((score, c))

    if not scored:
        return

    best_score = max(s for s, _ in scored)
    best_candidates = [c for s, c in scored if s == best_score]
    best = _prefer_undelivered_unpaid(best_candidates)
    confidence = min(best_score, FUZZY_MAX_CONFIDENCE)
    _apply_match(report, best.name, confidence, f"Fuzzy invoice number match (similarity {best_score:.2f})")


def _delivery_report_response(report):
    return {
        "success": True,
        "delivery_report": report.name,
        "matched_invoice": report.matched_invoice,
        "match_confidence": report.match_confidence,
        "match_notes": report.match_notes,
        "reconciliation_status": report.reconciliation_status,
    }


@frappe.whitelist()
def submit_delivery_report(data):
    """Ingestion endpoint for the Telegram delivery bot.

    Deliberately NOT allow_guest - the bot must authenticate as a dedicated Frappe user
    (API key/secret), not call this anonymously. Idempotent on bot_delivery_id: re-posting the
    same delivery (the bot's offline sync worker retrying after downtime, Phase 13) returns the
    existing record instead of creating a duplicate. delivery_timestamp is trusted as given by the
    bot rather than server-receive time, since a delivery may be synced hours after it happened.
    """
    try:
        if isinstance(data, str):
            data = json.loads(data)

        _validate_delivery_payload(data)

        bot_delivery_id = data.get("bot_delivery_id")

        existing_name = frappe.db.get_value(
            "Delivery Report", {"bot_delivery_id": bot_delivery_id}, "name"
        )
        if existing_name:
            return _delivery_report_response(frappe.get_doc("Delivery Report", existing_name))

        report = frappe.get_doc(
            {
                "doctype": "Delivery Report",
                "bot_delivery_id": bot_delivery_id,
                "reported_invoice_no": data.get("reported_invoice_no"),
                "completion_status": data.get("completion_status"),
                "payment_status": data.get("payment_status"),
                "delivery_driver": data.get("delivery_driver"),
                "driver_telegram_id": data.get("driver_telegram_id"),
                "delivery_timestamp": get_datetime(data["delivery_timestamp"])
                if data.get("delivery_timestamp")
                else None,
                "gps_latitude": flt(data["gps_latitude"]) if data.get("gps_latitude") is not None else None,
                "gps_longitude": flt(data["gps_longitude"])
                if data.get("gps_longitude") is not None
                else None,
                "photos": data.get("photos"),
                "voice_note": data.get("voice_note"),
                "raw_payload": data,
            }
        )

        match_delivery_report(report)

        try:
            report.insert(ignore_permissions=True)
        except frappe.exceptions.UniqueValidationError:
            # Lost a race against a concurrent retry of the same bot_delivery_id.
            frappe.db.rollback()
            existing_name = frappe.db.get_value(
                "Delivery Report", {"bot_delivery_id": bot_delivery_id}, "name"
            )
            return _delivery_report_response(frappe.get_doc("Delivery Report", existing_name))

        return _delivery_report_response(report)

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report ingestion failed")
        return {"success": False, "message": str(e)}


def _parse_bool(value, default=None):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in ("1", "true", "yes")


@frappe.whitelist()
def confirm_delivery_match(report_name, invoice_name=None, mark_paid=None, amount_collected=None):
    """Human confirms a Delivery Report's match (suggested or manually picked) and stamps the
    reconciled delivery data onto the Sales Invoice (Todo 020 fields). If the driver reported
    payment collected (Paid/Partial) and mark_paid isn't explicitly False, posts a Payment Entry
    via the existing create_payment_entry - never reimplemented here.

    amount_collected, if passed, is saved onto the Delivery Report before the Partial-payment
    branch reads it - this is how the reconciliation UI (Todo 024) supplies the human-confirmed
    collected amount in the same call, rather than a separate write beforehand.

    Idempotent: confirming an already-Confirmed report is a no-op and never posts a second
    Payment Entry (guarded both by an early-return fast path and a re-check of
    reconciliation_status/payment_entry immediately before posting, covering concurrent calls).

    Design rule (decided 2026-07-30): completion_status and payment_status are independent axes -
    a Partially Delivered order can still be fully paid and vice versa. mark-as-paid keys purely
    off payment_status; completion_status only drives custom_delivery_status.
    """
    try:
        report = frappe.get_doc("Delivery Report", report_name)

        if report.reconciliation_status == "Confirmed":
            return {
                "success": True,
                "message": "Already confirmed",
                "delivery_report": report.name,
                "matched_invoice": report.matched_invoice,
                "payment_entry": report.payment_entry,
            }

        if report.reconciliation_status == "Rejected":
            frappe.throw("Cannot confirm a rejected Delivery Report - re-match it first")

        if amount_collected is not None:
            report.amount_collected = flt(amount_collected)
            report.save(ignore_permissions=True)

        target_invoice_name = invoice_name or report.matched_invoice
        if not target_invoice_name:
            frappe.throw("No invoice to confirm - pass invoice_name or auto-match the report first")

        if not frappe.db.exists("Sales Invoice", target_invoice_name):
            frappe.throw(f"Sales Invoice {target_invoice_name} does not exist")

        invoice = frappe.get_doc("Sales Invoice", target_invoice_name)
        if invoice.docstatus != 1:
            frappe.throw(f"Sales Invoice {target_invoice_name} is not submitted")

        invoice.custom_delivery_status = DELIVERY_STATUS_MAP.get(report.completion_status, "Pending")
        invoice.custom_delivery_driver = report.delivery_driver
        invoice.custom_delivered_at = report.delivery_timestamp
        invoice.custom_delivery_gps_latitude = report.gps_latitude
        invoice.custom_delivery_gps_longitude = report.gps_longitude
        invoice.custom_delivery_report = report.name
        invoice.save(ignore_permissions=True)

        payment_entry_name = None
        mark_paid_override = _parse_bool(mark_paid)
        should_mark_paid = report.payment_status in ("Paid", "Partial") and mark_paid_override is not False

        if should_mark_paid:
            # Re-check right before posting - guards the race between two concurrent confirm
            # calls both passing the fast-path check above (Todo 023 risk: double payment).
            current_status, current_payment_entry = frappe.db.get_value(
                "Delivery Report", report.name, ["reconciliation_status", "payment_entry"]
            )
            if current_status == "Confirmed" or current_payment_entry:
                frappe.throw("Delivery Report was just confirmed by another request")

            if report.payment_status == "Paid":
                amount = flt(invoice.outstanding_amount)
            else:  # Partial
                amount = flt(report.amount_collected)
                if amount <= 0:
                    frappe.throw("amount_collected must be set (> 0) to confirm a Partial payment")
                if amount > flt(invoice.outstanding_amount):
                    frappe.throw(
                        f"amount_collected ({amount}) exceeds invoice outstanding_amount "
                        f"({invoice.outstanding_amount}) - cannot over-allocate"
                    )

            if amount > 0:
                payment_entry = create_payment_entry(invoice, None, amount)
                payment_entry_name = payment_entry.name

        report.matched_invoice = target_invoice_name
        report.reconciliation_status = "Confirmed"
        report.payment_entry = payment_entry_name
        report.save(ignore_permissions=True)

        return {
            "success": True,
            "delivery_report": report.name,
            "matched_invoice": target_invoice_name,
            "reconciliation_status": report.reconciliation_status,
            "payment_entry": payment_entry_name,
        }

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report confirm failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def reject_delivery_match(report_name, reason=None):
    """Flip a Delivery Report to Rejected. Never touches any Sales Invoice - matched_invoice and
    match_confidence are left as-is for audit (what was suggested/rejected and why), only the
    status changes. The optional reason is recorded as a comment on the report's timeline rather
    than overwriting match_notes (which explains the auto-match itself)."""
    try:
        report = frappe.get_doc("Delivery Report", report_name)

        if report.reconciliation_status == "Confirmed":
            frappe.throw("Cannot reject an already-confirmed Delivery Report")

        report.reconciliation_status = "Rejected"
        report.save(ignore_permissions=True)

        if reason:
            report.add_comment("Comment", f"Rejected: {reason}")

        return {
            "success": True,
            "delivery_report": report.name,
            "reconciliation_status": report.reconciliation_status,
        }

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report reject failed")
        return {"success": False, "message": str(e)}


DELIVERY_REPORT_LIST_FIELDS = [
    "name",
    "bot_delivery_id",
    "reported_invoice_no",
    "completion_status",
    "payment_status",
    "delivery_driver",
    "driver_telegram_id",
    "delivery_timestamp",
    "gps_latitude",
    "gps_longitude",
    "photos",
    "voice_note",
    "matched_invoice",
    "amount_collected",
    "reconciliation_status",
    "match_confidence",
    "match_notes",
    "payment_entry",
    "creation",
]


@frappe.whitelist()
def get_delivery_reports(status=None, search="", start=0, limit=100):
    """List Delivery Reports for the reconciliation queue (Todo 024 frontend), newest first.

    status: comma-separated reconciliation_status values. Defaults to the actionable queue
    (Unmatched + Suggested) - pass e.g. "Confirmed,Rejected" to view resolved history instead.
    search: matches bot_delivery_id / reported_invoice_no / delivery_driver / matched_invoice.
    """
    try:
        start = int(start or 0)
        limit = min(int(limit or 100), 200)

        statuses = [s.strip() for s in (status.split(",") if status else ["Unmatched", "Suggested"]) if s.strip()]
        filters = [["reconciliation_status", "in", statuses]] if statuses else []

        or_filters = None
        search = (search or "").strip()
        if search:
            term = f"%{search}%"
            or_filters = [
                ["bot_delivery_id", "like", term],
                ["reported_invoice_no", "like", term],
                ["delivery_driver", "like", term],
                ["matched_invoice", "like", term],
            ]

        # Delivery Report is a low-volume staging table (bounded by delivery throughput, not
        # sales data), so a plain count of matching names is cheap enough - no need for the
        # dict-syntax aggregate query here.
        total_count = len(frappe.get_all("Delivery Report", filters=filters, or_filters=or_filters, pluck="name"))

        data = frappe.get_all(
            "Delivery Report",
            filters=filters,
            or_filters=or_filters,
            fields=DELIVERY_REPORT_LIST_FIELDS,
            order_by="creation desc",
            limit_start=start,
            limit_page_length=limit,
        )

        return {"success": True, "data": data, "total_count": total_count, "start": start, "limit": limit}

    except Exception as e:
        frappe.log_error(title="Delivery Report list failed")
        return {"success": False, "message": str(e), "data": [], "total_count": 0}


@frappe.whitelist()
def rematch_delivery_report(report_name, invoice_name):
    """Manually override the suggested (or absent) match to a specific invoice, resetting status
    to Suggested so it still requires a separate confirm_delivery_match call - a re-match is not
    itself a confirmation."""
    try:
        report = frappe.get_doc("Delivery Report", report_name)

        if report.reconciliation_status == "Confirmed":
            frappe.throw(
                "Cannot re-match an already-confirmed Delivery Report - reject it first if the "
                "confirmed match was wrong"
            )

        if not frappe.db.exists("Sales Invoice", invoice_name):
            frappe.throw(f"Sales Invoice {invoice_name} does not exist")

        report.matched_invoice = invoice_name
        report.match_confidence = 1.0
        report.match_notes = f"Manually re-matched to {invoice_name} by {frappe.session.user}"
        report.reconciliation_status = "Suggested"
        report.save(ignore_permissions=True)

        return {
            "success": True,
            "delivery_report": report.name,
            "matched_invoice": invoice_name,
            "reconciliation_status": report.reconciliation_status,
        }

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report re-match failed")
        return {"success": False, "message": str(e)}
