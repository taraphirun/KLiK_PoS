import frappe

from klik_pos.api.delivery import resolve_driver


def execute():
    """Todo 028: delivery_driver (Delivery Report) and custom_delivery_driver (Sales Invoice) were
    just converted from free-text Data fields to Link(Delivery Driver). This backfills existing
    rows so the now-Link columns hold either a valid Delivery Driver docname or blank - never the
    old free text, which would fail Link validation the next time one of these documents is saved.

    Runs post_model_sync, so the schema change (patches.txt) has already landed by the time this
    executes - frappe.db.set_value below is safe to call with the new Link fieldtype.
    """
    linked, unmatched = _backfill_delivery_reports()
    invoice_linked, invoice_unmatched = _backfill_sales_invoices()

    frappe.db.commit()
    print(
        f"Delivery Driver backfill: Delivery Report {linked} linked / {unmatched} unmatched "
        f"(left blank, original text preserved in reported_driver_name); "
        f"Sales Invoice {invoice_linked} linked / {invoice_unmatched} unmatched."
    )


def _backfill_delivery_reports():
    """Every existing row's delivery_driver column still holds the pre-migration free text (the
    schema change alone doesn't touch data). Move that text to reported_driver_name, then try to
    resolve it to a real Delivery Driver the same way fresh ingestion does (Todo 028)."""
    reports = frappe.get_all(
        "Delivery Report",
        fields=["name", "delivery_driver", "driver_telegram_id", "reported_driver_name"],
    )

    linked = 0
    unmatched = 0
    for report in reports:
        # Idempotent: a row already migrated (reported_driver_name populated, delivery_driver
        # already a real Delivery Driver name or already blank) is left alone.
        if report.reported_driver_name:
            continue

        raw_name = report.delivery_driver
        if not raw_name:
            continue

        match = resolve_driver(raw_name, report.driver_telegram_id)
        frappe.db.set_value(
            "Delivery Report",
            report.name,
            {"reported_driver_name": raw_name, "delivery_driver": match},
            update_modified=False,
        )
        if match:
            linked += 1
        else:
            unmatched += 1

    return linked, unmatched


def _backfill_sales_invoices():
    """custom_delivery_driver is only ever set by confirm_delivery_match (Todo 023) copying
    Delivery Report.delivery_driver - so for any invoice with a linked custom_delivery_report,
    re-copy from that report (now resolved by _backfill_delivery_reports above) rather than
    re-running driver-name matching independently; this guarantees the two stay consistent instead
    of a second matching pass potentially picking a different driver. Only falls back to
    independent matching for the (expected-empty, defensive) case of a raw driver string with no
    linked report."""
    invoices = frappe.get_all(
        "Sales Invoice",
        filters=[["custom_delivery_driver", "!=", ""]],
        fields=["name", "custom_delivery_driver", "custom_delivery_report"],
    )

    linked = 0
    unmatched = 0
    for invoice in invoices:
        if invoice.custom_delivery_report:
            resolved = frappe.db.get_value("Delivery Report", invoice.custom_delivery_report, "delivery_driver")
        else:
            resolved = resolve_driver(invoice.custom_delivery_driver, None)

        # Already a valid Delivery Driver name (e.g. re-running this patch) - nothing to do.
        if resolved == invoice.custom_delivery_driver and frappe.db.exists("Delivery Driver", resolved):
            linked += 1
            continue

        frappe.db.set_value(
            "Sales Invoice", invoice.name, "custom_delivery_driver", resolved, update_modified=False
        )
        if resolved:
            linked += 1
        else:
            unmatched += 1

    return linked, unmatched
