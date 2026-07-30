import json

import frappe
from frappe.utils import flt, get_datetime

ALLOWED_COMPLETION_STATUSES = {"Full", "Partial"}
ALLOWED_PAYMENT_STATUSES = {"Paid", "Unpaid", "Partial"}
REQUIRED_FIELDS = ("bot_delivery_id", "reported_invoice_no", "completion_status", "payment_status")


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


def match_delivery_report(report):
    """Attempt to resolve a Delivery Report to a real Sales Invoice.

    Minimal exact-match implementation for now (Todo 021) - fuzzy/attribute matching with
    weighted confidence scoring is Todo 022. Mutates the in-memory `report` doc only
    (matched_invoice / match_confidence / reconciliation_status); never touches the invoice.
    Safe to call again on an already-saved report (e.g. a manual re-match).
    """
    invoice_no = (report.reported_invoice_no or "").strip()
    if invoice_no and frappe.db.exists("Sales Invoice", invoice_no):
        report.matched_invoice = invoice_no
        report.match_confidence = 1.0
        report.reconciliation_status = "Suggested"
    else:
        report.matched_invoice = None
        report.match_confidence = 0
        report.reconciliation_status = "Unmatched"


def _delivery_report_response(report):
    return {
        "success": True,
        "delivery_report": report.name,
        "matched_invoice": report.matched_invoice,
        "match_confidence": report.match_confidence,
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
