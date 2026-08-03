import difflib
import json
import re

import frappe
from frappe.utils import add_days, flt, get_datetime, now_datetime, nowdate
from frappe.utils.file_manager import save_file

from klik_pos.api.booklet import _extract_number as _extract_invoice_number
from klik_pos.api.booklet import match_booklet_for_invoice
from klik_pos.api.sales_invoice import _get_default_payment_mode, create_payment_entry, queue_sales_invoice

# completion_status (Delivery Report) -> custom_delivery_status (Sales Invoice, Todo 020).
DELIVERY_STATUS_MAP = {"Full": "Delivered", "Partial": "Partially Delivered"}

# A single invoice can legitimately receive more than one confirmed Delivery Report - a Partial
# delivery now, the remainder later (2026-07-31 addendum, see phase-09.md). This rank makes
# custom_delivery_status monotonic (never regress) regardless of confirm order: the reconciliation
# queue sorts newest bot-submission first, so staff can easily confirm a later Full delivery before
# an earlier Partial one for the same invoice - without this, that ordering would silently
# downgrade "Delivered" back to "Partially Delivered".
DELIVERY_STATUS_RANK = {"Pending": 0, "Not Delivered": 0, "Partially Delivered": 1, "Delivered": 2}

ALLOWED_COMPLETION_STATUSES = {"Full", "Partial"}
ALLOWED_PAYMENT_STATUSES = {"Paid", "Unpaid", "Partial"}
REQUIRED_FIELDS = ("bot_delivery_id", "reported_invoice_no", "completion_status", "payment_status")

# Module 17's "I know what happened, no bot report exists" manual override
# (set_manual_delivery_status) - deliberately a subset of custom_delivery_status's own options,
# excluding "Partially Delivered"/"Not Delivered"/"Pending" which only make sense coming from a
# real (bot-verified or in-progress) delivery, not a manual end-of-day claim.
MANUAL_DELIVERY_STATUSES = ("Delivered", "Self Pickup")

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


def resolve_driver(name_hint, telegram_id):
    """Resolve a bot-reported driver name/Telegram id to a Delivery Driver record (Todo 028).

    Telegram identity is trusted first (unique, bot-verified - see sync_driver_from_bot);
    falls back to an exact driver_name match (case-insensitive under Frappe's default DB
    collation). No fuzzy matching, unlike invoice matching: a wrong invoice match gets caught at
    confirm time by a human looking at the invoice; a wrong driver link has no equivalent
    reconciliation-blocking symptom, so a wrong guess here is worse than leaving it blank for
    manual review. Returns None (never guesses) if nothing matches - the raw text is preserved
    separately (reported_driver_name / raw_payload), so nothing is lost by leaving this blank.
    """
    telegram_id = str(telegram_id or "").strip()
    if telegram_id:
        match = frappe.db.get_value("Delivery Driver", {"telegram_user_id": telegram_id}, "name")
        if match:
            return match

    name_hint = (name_hint or "").strip()
    if not name_hint:
        return None

    return frappe.db.get_value("Delivery Driver", {"driver_name": name_hint}, "name")


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
                "reported_driver_name": data.get("delivery_driver"),
                "delivery_driver": resolve_driver(data.get("delivery_driver"), data.get("driver_telegram_id")),
                "driver_telegram_id": data.get("driver_telegram_id"),
                "delivery_timestamp": get_datetime(data["delivery_timestamp"])
                if data.get("delivery_timestamp")
                else None,
                "gps_latitude": flt(data["gps_latitude"]) if data.get("gps_latitude") is not None else None,
                "gps_longitude": flt(data["gps_longitude"])
                if data.get("gps_longitude") is not None
                else None,
                # JSON fieldtype auto-serializes a dict on assignment but rejects a raw list
                # outright (Frappe: base_document.py's get_valid_dict throws "cannot be a list"
                # for any non-table field) - must json.dumps() a list ourselves.
                "photos": json.dumps(data["photos"]) if isinstance(data.get("photos"), list) else data.get("photos"),
                "voice_note": data.get("voice_note"),
                "raw_payload": data,
            }
        )

        # Booklet matching (Module 16) - best-effort, mirrors invoice matching below: a numeric
        # reported_invoice_no that falls outside every known booklet range is flagged for manual
        # review (Todo 041/042) rather than left silently unset, same reasoning as
        # is_booklet_out_of_range's own docstring on the doctype field.
        reported_no = data.get("reported_invoice_no")
        booklet_match = match_booklet_for_invoice(reported_no, data.get("delivery_timestamp"))
        report.booklet = booklet_match
        report.is_booklet_out_of_range = (
            1 if (not booklet_match and _extract_invoice_number(reported_no) is not None) else 0
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


def _is_newer_or_first_delivery(existing_delivered_at, new_delivered_at):
    """True if the invoice has no prior delivery snapshot yet, or this report's delivery_timestamp
    is not older than the one already recorded. Guards the same out-of-order-confirm scenario as
    DELIVERY_STATUS_RANK, but for the driver/GPS/delivered-at snapshot fields: those should reflect
    the chronologically latest delivery, not whichever report a human happened to confirm last.
    Conservative when timestamps are missing - an untimed report never overwrites an existing
    timed snapshot, since there's no way to tell if it's actually more recent."""
    if not existing_delivered_at:
        return True
    if not new_delivered_at:
        return False
    return get_datetime(new_delivered_at) >= get_datetime(existing_delivered_at)


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

    Multiple deliveries per invoice (decided 2026-07-31): confirming a Delivery Report is NOT
    limited to one-per-invoice - a Partial delivery followed later by a second report for the
    remainder is the normal case, not a conflict (see phase-09.md addendum / dropped Module 12).
    Payment posting already handles this safely as-is (always checks live outstanding_amount, so
    it can't over-allocate across multiple confirms). The delivery *snapshot* fields
    (custom_delivery_status/driver/delivered_at/gps/report) need the guards below because the
    reconciliation queue sorts newest bot-submission first: it's natural for staff to confirm a
    later Full delivery before an earlier Partial one for the same invoice, which without a guard
    would silently regress the invoice back to a less-complete state.
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

        # An invoice can legitimately be confirmed against more than one Delivery Report (partial
        # delivery, then the remainder) - both guards below keep a second confirm from clobbering
        # a further-along state with an earlier one, regardless of which order they're confirmed
        # in (2026-07-31 addendum, see phase-09.md).
        new_status = DELIVERY_STATUS_MAP.get(report.completion_status, "Pending")
        if DELIVERY_STATUS_RANK.get(new_status, 0) >= DELIVERY_STATUS_RANK.get(invoice.custom_delivery_status, 0):
            invoice.custom_delivery_status = new_status

        if _is_newer_or_first_delivery(invoice.custom_delivered_at, report.delivery_timestamp):
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
    "reported_driver_name",
    "delivery_driver",
    "delivery_driver_name",
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
    "booklet",
    "is_booklet_out_of_range",
    "creation",
]


def _group_key(row):
    """Same-invoice grouping key (2026-07-31 addendum, decided with the user): matched_invoice
    once resolved, else the raw reported_invoice_no. A fallback to row.name only guards the
    defensive case of a manually-created Delivery Report with neither set (never happens via
    submit_delivery_report - reported_invoice_no is required there)."""
    return row.get("matched_invoice") or row.get("reported_invoice_no") or row.get("name")


def _group_info_for_keys(group_keys):
    """Cross-status aggregate per group key: total report count and whether any is Partial.
    Deliberately looks across ALL reconciliation_status values, not just the caller's current
    filter - a Suggested report is still "part of a group" even if its sibling was already
    Confirmed and would otherwise be filtered out of the Pending queue (decided with the user)."""
    if not group_keys:
        return {}

    placeholders = ", ".join(["%s"] * len(group_keys))
    rows = frappe.db.sql(
        f"""
        SELECT
            COALESCE(matched_invoice, reported_invoice_no) AS group_key,
            COUNT(*) AS total_count,
            SUM(CASE WHEN completion_status = 'Partial' THEN 1 ELSE 0 END) AS partial_count
        FROM `tabDelivery Report`
        WHERE COALESCE(matched_invoice, reported_invoice_no) IN ({placeholders})
        GROUP BY COALESCE(matched_invoice, reported_invoice_no)
        """,
        tuple(group_keys),
        as_dict=True,
    )
    return {r.group_key: r for r in rows}


@frappe.whitelist()
def get_delivery_reports(status=None, search="", start=0, limit=100):
    """List Delivery Reports for the reconciliation queue (Todo 024 frontend).

    status: comma-separated reconciliation_status values. Defaults to the actionable queue
    (Unmatched + Suggested) - pass e.g. "Confirmed,Rejected" to view resolved history instead.
    search: matches bot_delivery_id / reported_invoice_no / reported_driver_name / delivery_driver_name /
    matched_invoice.

    Ordering (2026-07-31 addendum, decided with the user): rows are grouped by invoice
    (_group_key) and sorted so "flagged" groups - more than one report for that invoice across ANY
    status, or containing a Partial delivery - float to the top, ahead of ordinary single-Full-
    delivery reports. Within a group, rows stay adjacent and newest first. Each row carries
    group_key/group_total_count/group_flagged so the frontend can visually cluster same-invoice
    cards and indicate when a group has members outside the current status filter (e.g. an
    already-Confirmed first delivery not shown in the default Pending queue).

    Sorting requires the full filtered/searched result set in memory before paginating (can't
    ORDER BY the flagged-priority computed above in SQL without a second query anyway) - acceptable
    given Delivery Report's low volume (bounded by delivery throughput, not sales data), same
    assumption the rest of this module already makes.
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
                ["reported_driver_name", "like", term],
                ["delivery_driver_name", "like", term],
                ["matched_invoice", "like", term],
            ]

        all_matches = frappe.get_all(
            "Delivery Report", filters=filters, or_filters=or_filters, fields=DELIVERY_REPORT_LIST_FIELDS
        )
        total_count = len(all_matches)

        booklet_names = {row["booklet"] for row in all_matches if row.get("booklet")}
        booklet_info = (
            {
                b.name: b
                for b in frappe.get_all(
                    "Delivery Booklet",
                    filters={"name": ["in", list(booklet_names)]},
                    fields=["name", "booklet_number", "status", "is_vip", "customer"],
                )
            }
            if booklet_names
            else {}
        )
        for row in all_matches:
            row["group_key"] = _group_key(row)
            b = booklet_info.get(row.get("booklet"))
            row["booklet_number"] = b.booklet_number if b else None
            row["booklet_status"] = b.status if b else None
            # Suggested customer for backfilling an invoice (Todo 044) - a hint the frontend can
            # prefill and staff can still override, not an authoritative assignment.
            row["booklet_customer"] = b.customer if (b and b.is_vip) else None

        group_info = _group_info_for_keys({row["group_key"] for row in all_matches})

        def is_flagged(row):
            info = group_info.get(row["group_key"])
            total = info.total_count if info else 1
            has_partial = bool(info and info.partial_count) or row.get("completion_status") == "Partial"
            return total > 1 or has_partial

        for row in all_matches:
            info = group_info.get(row["group_key"])
            row["group_total_count"] = info.total_count if info else 1
            row["group_flagged"] = is_flagged(row)

        # Stable sorts compose: apply lowest-priority key first so each later sort's tie-breaks
        # preserve the ordering already established by the ones before it.
        all_matches.sort(key=lambda r: r["creation"], reverse=True)  # newest first within a group
        all_matches.sort(key=lambda r: r["group_key"])  # cluster same-invoice rows together
        all_matches.sort(key=lambda r: 0 if r["group_flagged"] else 1)  # flagged groups float to top

        data = all_matches[start : start + limit]

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


@frappe.whitelist()
def upload_delivery_file(report_name):
    """Upload a single photo/voice file for a Delivery Report (Module 14 / Todo 035), bypassing
    Frappe's generic `/api/method/upload_file` MIME-type allowlist.

    That stock endpoint rejects any file type outside a hardcoded allowlist (JPG/PNG/GIF/PDF/
    text/office docs/mp4 - see `frappe.handler.ALLOWED_MIMETYPES`) for any user without Desk
    access, and voice notes (audio/ogg) aren't on that list. Granting the bot's service account
    Desk access just to clear one MIME check would be a broader capability than this integration
    needs (see driver.py/other delivery.py endpoints - the established pattern here is
    ignore_permissions at the endpoint level, not elevated account privileges). `save_file()`
    itself has no such restriction - the MIME check is an extra guard `/upload_file`'s HTTP
    handler applies before ever calling `save_file()`, not something `save_file()` enforces on
    its own - so this endpoint calls it directly.

    Requires report_name (the Delivery Report must already exist - created by
    submit_delivery_report first) so the file is properly doctype-linked for permission scoping,
    not an orphaned/owner-only file only the bot's own service user could read (same reasoning as
    attach_delivery_media below, which this is meant to be used together with: upload here to get
    a file_url, then call attach_delivery_media to record it on the report).
    """
    try:
        if not frappe.db.exists("Delivery Report", report_name):
            frappe.throw(f"Delivery Report {report_name} does not exist")

        uploaded = frappe.request.files.get("file")
        if not uploaded:
            frappe.throw("No file uploaded")

        file_doc = save_file(
            uploaded.filename, uploaded.stream.read(), "Delivery Report", report_name, is_private=1
        )

        return {"success": True, "file_url": file_doc.file_url}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report media upload failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def attach_delivery_media(report_name, photo_urls=None, voice_url=None):
    """Records already-uploaded Frappe File URLs onto a Delivery Report (Module 14 / Todo 035).

    The bot uploads files via upload_delivery_file (doctype=Delivery Report, docname=report_name,
    is_private=1) *after* the report already exists (created by submit_delivery_report first) -
    that gets each file proper doctype-linked permission scoping, so staff viewing the
    reconciliation queue can see photos/voice attached to a report they have access to, rather
    than an orphaned file only the bot's own service user could read. This endpoint just records
    the resulting URLs onto the report; it never uploads anything itself.

    photo_urls: list (or JSON-encoded list) of file URLs, merged into any existing photos rather
    than overwriting - safe to call more than once as a multi-photo delivery's files upload one at
    a time. voice_url: single URL, overwrites any previous value (a delivery has at most one voice
    note, matching the `voice_note` Attach field's single-file semantics).
    """
    try:
        if isinstance(photo_urls, str):
            photo_urls = json.loads(photo_urls) if photo_urls else []
        photo_urls = photo_urls or []

        report = frappe.get_doc("Delivery Report", report_name)

        if photo_urls:
            existing = report.photos or []
            if isinstance(existing, str):
                existing = json.loads(existing) if existing else []
            # json.dumps() required: JSON fieldtype auto-serializes a dict on assignment but
            # rejects a raw list outright (see submit_delivery_report's photos handling above).
            report.photos = json.dumps(existing + [url for url in photo_urls if url not in existing])

        if voice_url:
            report.voice_note = voice_url

        if photo_urls or voice_url:
            report.save(ignore_permissions=True)

        return {
            "success": True,
            "delivery_report": report.name,
            "photos": report.photos,
            "voice_note": report.voice_note,
        }

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Delivery Report media attach failed")
        return {"success": False, "message": str(e)}


def _apply_payment_status_to_invoice_data(invoice_data, payment_status, amount_collected=None, due_date=None):
    """Shapes invoice_data (queue_sales_invoice's payload) from a payment_status declaration
    (Paid/Partial/Unpaid) so the resulting submission bakes payment in correctly - see
    create_invoice_from_delivery_report's docstring for why this must happen in the *same*
    submission rather than a follow-up Payment Entry (ERPNext's credit-limit check runs on submit,
    seeing only this invoice's own outstanding_amount at that point). Shared by
    create_invoice_from_delivery_report (Module 15) and create_invoice_for_unreported_page
    (Module 17) so the two backfill entry points can't drift apart.

    Mutates and returns invoice_data. Also returns amount_collected (flt()'d) since "Partial"
    validates and needs it - callers that track it elsewhere (e.g. onto a Delivery Report) don't
    need to recompute flt() themselves.
    """
    if payment_status not in ALLOWED_PAYMENT_STATUSES:
        frappe.throw(f"Invalid payment_status '{payment_status}'")

    if payment_status == "Paid":
        invoice_data["pay_in_full"] = True

    elif payment_status == "Partial":
        amount_collected = flt(amount_collected)
        if amount_collected <= 0:
            frappe.throw("amount_collected must be set (> 0) for a Partial payment status")
        default_mode = _get_default_payment_mode()
        if not default_mode:
            frappe.throw(
                "No default payment mode is configured on this POS Profile - add one "
                "before recording a Partial payment here"
            )
        invoice_data["isCreditSale"] = False
        invoice_data["amountPaid"] = amount_collected
        invoice_data["paymentMethods"] = [{"method": default_mode, "amount": amount_collected}]
        if due_date:
            invoice_data["dueDate"] = due_date

    else:  # Unpaid
        if not due_date:
            frappe.throw("due_date is required when payment_status is Unpaid")
        invoice_data["isCreditSale"] = True
        invoice_data["dueDate"] = due_date

    return invoice_data, amount_collected


@frappe.whitelist()
def create_invoice_from_delivery_report(
    report_name, invoice_data, payment_status=None, amount_collected=None, due_date=None
):
    """Backfill a missing Sales Invoice directly from an Unmatched Delivery Report (Module 15 /
    Todo 038/039) - for the paper -> ERPNext transition, where a delivery was reported but the
    invoice itself was never entered into KlikPOS, so there's nothing for the normal
    reconciliation flow to match against (confirm_delivery_match requires the invoice to already
    exist).

    invoice_data is the base payload queue_sales_invoice already accepts (customer, items,
    optional posting_date) - payment shaping is layered on here from payment_status rather than
    left to the caller, because getting it wrong trips ERPNext's own credit-limit check in
    confusing ways (see below).

    payment_status ("Paid" / "Partial" / "Unpaid", Delivery Report's own enum) decides how the
    invoice is paid, and is written onto the Delivery Report too so the record reflects what staff
    actually declared at backfill time, not whatever was originally reported (Todo 039):
      - "Paid": invoice_data["pay_in_full"] = True. ERPNext's credit-limit check runs on submit
        AFTER this invoice's own GL entries post (see SalesInvoice.on_submit), so it sees this
        invoice's own outstanding_amount - baking full payment into the *same submission* (via
        queue_sales_invoice's pay_in_full support) is what keeps a fully-paid backfill from
        tripping the check, not a Payment Entry posted afterward (which would still leave this
        invoice's own outstanding at its full grand_total at submit time).
      - "Partial": needs amount_collected (>0) and a configured default payment mode (POS Payment
        Method on the active POS Profile) - same reasoning, baked into the submission so the
        credit check sees only the genuinely remaining outstanding.
      - "Unpaid": standard is_credit_sale path, requires due_date - full grand_total stays
        outstanding, so the credit-limit check applies in full. This is intentional, not a gap:
        an unpaid backfill is real, uncapped credit exposure exactly like any other credit sale.
    due_date is required for "Unpaid" (ERPNext requires it for any credit sale) and optional for
    "Partial" (defaults to today, same as normal checkout); not applicable to "Paid".

    Background submission is forced off: confirm_delivery_match requires a submitted
    (docstatus=1) invoice, which only queue_sales_invoice's synchronous path guarantees
    immediately - a background-queued invoice would still be a Draft at this point.

    confirm_delivery_match is always called with mark_paid=False: payment (if any) was already
    baked into the invoice's own submission above via pay_in_full/amountPaid, so a second Payment
    Entry from confirm_delivery_match's own payment-posting path would double it up. This means
    the response's payment_entry is always None here even when payment_status is Paid/Partial -
    the paid trail lives on the invoice's own payments table, not a separate Payment Entry.
    """
    try:
        report = frappe.get_doc("Delivery Report", report_name)

        if report.reconciliation_status == "Confirmed":
            frappe.throw(
                "Delivery Report is already confirmed against an invoice - use re-match instead"
            )

        if isinstance(invoice_data, str):
            invoice_data = json.loads(invoice_data)
        invoice_data = dict(invoice_data or {})
        invoice_data["enable_background_submission"] = False
        # Without businessType, _determine_is_pos defaults to is_pos=0 - a non-POS invoice, where
        # the `payments` child table (what pay_in_full/amountPaid below rely on to actually record
        # payment at submission time) isn't the operative paid-amount source at all, silently
        # leaving the invoice looking unpaid regardless of payment_status. B2C matches how this
        # app's normal walk-in checkout already behaves; only defaulted, never overrides a caller.
        invoice_data.setdefault("businessType", "B2C")
        # Stamps the paper page number onto the invoice itself (Module 17) - without this, an
        # invoice backfilled here is only discoverable via custom_delivery_report/matched_invoice,
        # not by invoice ref, leaving it invisible to anything that looks Sales Invoice up by
        # custom_invoice_ref (the daily reconciliation checklist's primary lookup). Only defaulted
        # from the report's own reported_invoice_no, never overrides an explicit caller value.
        if not invoice_data.get("custom_invoice_ref"):
            ref_number = _extract_invoice_number(report.reported_invoice_no)
            if ref_number is not None:
                invoice_data["custom_invoice_ref"] = ref_number

        if payment_status:
            invoice_data, amount_collected = _apply_payment_status_to_invoice_data(
                invoice_data, payment_status, amount_collected, due_date
            )
            report.payment_status = payment_status
            if payment_status == "Partial":
                report.amount_collected = amount_collected
            report.save(ignore_permissions=True)

        invoice_result = queue_sales_invoice(invoice_data)
        if not invoice_result.get("success"):
            return invoice_result

        invoice_name = invoice_result.get("invoice_name")
        confirm_result = confirm_delivery_match(report.name, invoice_name=invoice_name, mark_paid=False)
        if not confirm_result.get("success"):
            return {
                "success": False,
                "message": (
                    f"Invoice {invoice_name} was created but could not be linked to the Delivery "
                    f"Report: {confirm_result.get('message')}. The invoice was not discarded - "
                    f"use re-match to link it manually."
                ),
                "invoice_name": invoice_name,
            }

        return {
            "success": True,
            "invoice_name": invoice_name,
            "invoice": invoice_result.get("invoice"),
            "delivery_report": confirm_result.get("delivery_report"),
            "reconciliation_status": confirm_result.get("reconciliation_status"),
            "payment_entry": confirm_result.get("payment_entry"),
        }

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Create invoice from Delivery Report failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def set_manual_delivery_status(invoice_name, status):
    """Manual "I know what happened, no bot report exists" override for the daily reconciliation
    checklist (Module 17) - Confirm Self-Pickup, or Confirm Delivered when the driver forgot to
    submit a report but the delivery is known to have happened.

    Deliberately a lower-trust, separate path from confirm_delivery_match's bot-verified flow (no
    GPS/photo/driver identity behind this) - guarded against overriding an invoice that already
    has a real Confirmed Delivery Report, pointing staff at the normal reconciliation flow instead
    rather than letting this silently clobber a verified outcome. No extra audit trail beyond
    Frappe's own track_changes history on Sales Invoice (decided with the user, 2026-08-02) - no
    timeline comment stamped.
    """
    try:
        if status not in MANUAL_DELIVERY_STATUSES:
            frappe.throw(f"Invalid status '{status}', expected one of {MANUAL_DELIVERY_STATUSES}")

        invoice = frappe.get_doc("Sales Invoice", invoice_name)
        if invoice.docstatus != 1:
            frappe.throw(f"Sales Invoice {invoice_name} is not submitted")

        if invoice.custom_delivery_report:
            report_status = frappe.db.get_value(
                "Delivery Report", invoice.custom_delivery_report, "reconciliation_status"
            )
            if report_status == "Confirmed":
                frappe.throw(
                    f"{invoice_name} already has a confirmed Delivery Report - use the normal "
                    f"reconciliation flow to change its outcome, not this manual override"
                )

        invoice.custom_delivery_status = status
        invoice.custom_delivered_at = now_datetime()
        invoice.save(ignore_permissions=True)

        return {"success": True, "invoice_name": invoice.name, "status": invoice.custom_delivery_status}

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Manual delivery status set failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def create_invoice_for_unreported_page(page_number, invoice_data, payment_status=None, amount_collected=None, due_date=None):
    """Backfill a Sales Invoice for a booklet page number with *neither* an invoice nor a Delivery
    Report at all (Module 17's daily reconciliation "Unresolved" bucket - truly forgotten
    end-to-end, unlike create_invoice_from_delivery_report which always has a report to hang the
    invoice off). Ports the NestJS dashboard's old resolveMissing endpoint
    (deliveries.controller.ts) into KlikPOS: creates+submits the invoice directly via
    queue_sales_invoice with custom_invoice_ref set to the page number, no Delivery Report/
    confirm_delivery_match involved - there's nothing to reconcile against, this manual entry IS
    the record.

    Requires a customer up front (decided with the user, 2026-08-02) - same rule as Module 15's
    Create Invoice modal, no "unknown/walk-in, fix later" shortcut. payment_status shaping is the
    same shared helper create_invoice_from_delivery_report uses, so the two backfill paths can't
    drift apart on the credit-limit-safe payment baking logic.
    """
    try:
        page_number = int(page_number)

        if frappe.db.exists("Sales Invoice", {"custom_invoice_ref": page_number, "docstatus": 1}):
            frappe.throw(f"A submitted Sales Invoice already exists with invoice ref {page_number}")

        if isinstance(invoice_data, str):
            invoice_data = json.loads(invoice_data)
        invoice_data = dict(invoice_data or {})

        if not (invoice_data.get("customer") or {}).get("id"):
            frappe.throw("customer is required")

        invoice_data["enable_background_submission"] = False
        invoice_data.setdefault("businessType", "B2C")
        invoice_data["custom_invoice_ref"] = page_number

        if payment_status:
            invoice_data, amount_collected = _apply_payment_status_to_invoice_data(
                invoice_data, payment_status, amount_collected, due_date
            )

        invoice_result = queue_sales_invoice(invoice_data)
        if not invoice_result.get("success"):
            return invoice_result

        return {
            "success": True,
            "invoice_name": invoice_result.get("invoice_name"),
            "invoice": invoice_result.get("invoice"),
        }

    except frappe.exceptions.ValidationError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        frappe.log_error(title="Create invoice for unreported booklet page failed")
        return {"success": False, "message": str(e)}


@frappe.whitelist()
def get_shop_locations():
    """Fixed shop pins for the Live Delivery Map (2026-08-03 follow-up) - most deliveries
    originate near a shop, so this gives the map a reference point (and, once there's more than
    one, all of them at once - not scoped to whichever POS Profile the current session happens to
    have open).

    A warehouse counts as a "shop location" if it's assigned to an enabled POS Profile (decided
    with the user: "pos profile is open per warehouse so select the address of those warehouse
    only") - not every Warehouse is a shop, but every warehouse actually in use as a till location
    is, by definition. Only returns ones with coordinates actually set
    (custom_shop_latitude/custom_shop_longitude, see ensure_warehouse_shop_location_fields).
    """
    try:
        pos_profiles = frappe.get_all(
            "POS Profile",
            filters={"disabled": 0, "warehouse": ["is", "set"]},
            fields=["name", "warehouse"],
        )
        if not pos_profiles:
            return {"success": True, "data": []}

        profiles_by_warehouse = {}
        for p in pos_profiles:
            profiles_by_warehouse.setdefault(p.warehouse, []).append(p.name)

        warehouses = frappe.get_all(
            "Warehouse",
            filters={"name": ["in", list(profiles_by_warehouse)]},
            fields=["name", "warehouse_name", "custom_shop_latitude", "custom_shop_longitude"],
        )

        return {
            "success": True,
            "data": [
                {
                    "warehouse": w.name,
                    "warehouse_name": w.warehouse_name,
                    "latitude": w.custom_shop_latitude,
                    "longitude": w.custom_shop_longitude,
                    "pos_profiles": profiles_by_warehouse[w.name],
                }
                for w in warehouses
                # Float fields default to 0, not NULL - a real (0, 0) shop is implausible enough
                # here to safely treat both falsy values as "not configured yet" rather than
                # relying on an IS NOT NULL filter that wouldn't actually catch the never-set case.
                if w.custom_shop_latitude and w.custom_shop_longitude
            ],
        }

    except Exception as e:
        frappe.log_error(title="Shop locations lookup failed")
        return {"success": False, "message": str(e), "data": []}
