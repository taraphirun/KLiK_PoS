import frappe

@frappe.whitelist()
def fix_null_batch_sles(item_code, warehouse, batch_no, invoice_list):
    """
    Fix NULL batch_no on SLEs and Serial and Batch Bundle entries
    for a given list of invoices, then repost stock ledger.
    """
    # Admin stock-repair tool - writes Stock Ledger Entries directly and forces a repost.
    # Was whitelisted with no role check, so any authenticated user could corrupt stock
    # valuation. (Audit 2026-08-18, security finding.)
    frappe.only_for(["System Manager", "Stock Manager"])

    if isinstance(invoice_list, str):
        import json
        invoice_list = json.loads(invoice_list)

    results = {
        "sles_fixed": 0,
        "bundle_entries_fixed": 0,
        "repost": "pending"
    }

    # Step 1 — Fix SLEs
    sles = frappe.get_all(
        "Stock Ledger Entry",
        filters={
            "voucher_no": ["in", invoice_list],
            "batch_no": ["in", ["", None]],
            "is_cancelled": 0
        },
        fields=["name"]
    )

    for sle in sles:
        frappe.db.set_value(
            "Stock Ledger Entry",
            sle.name,
            "batch_no",
            batch_no,
            update_modified=False
        )
    results["sles_fixed"] = len(sles)
    frappe.db.commit()

    # Step 2 — Fix Serial and Batch Bundle child entries
    bundle_names = frappe.get_all(
        "Serial and Batch Bundle",
        filters={"voucher_no": ["in", invoice_list]},
        pluck="name"
    )

    if bundle_names:
        bundle_entries = frappe.get_all(
            "Serial and Batch Entry",
            filters={
                "batch_no": ["in", ["", None]],
                "parent": ["in", bundle_names]
            },
            fields=["name"]
        )

        for entry in bundle_entries:
            frappe.db.set_value(
                "Serial and Batch Entry",
                entry.name,
                "batch_no",
                batch_no,
                update_modified=False
            )
        results["bundle_entries_fixed"] = len(bundle_entries)
        frappe.db.commit()

    # Step 3 — Repost stock ledger
    try:
        from erpnext.stock.stock_ledger import update_entries_after

        # Find the earliest SLE posting date for this item/warehouse to repost from
        earliest = frappe.db.get_value(
            "Stock Ledger Entry",
            {
                "item_code": item_code,
                "warehouse": warehouse,
                "is_cancelled": 0
            },
            ["posting_date", "posting_time"],
            order_by="posting_date asc, posting_time asc"
        )

        update_entries_after({
            "item_code": item_code,
            "warehouse": warehouse,
            "posting_date": earliest[0] if earliest else frappe.utils.today(),
            "posting_time": earliest[1] if earliest else "00:00:00",
            "creation": frappe.utils.now()
        })
        frappe.db.commit()
        results["repost"] = "success"
    except Exception as e:
        results["repost"] = f"failed: {str(e)}"

    # Step 4 — Return verification snapshot
    snapshot = frappe.get_all(
        "Stock Ledger Entry",
        filters={
            "item_code": item_code,
            "warehouse": warehouse,
            "is_cancelled": 0
        },
        fields=["batch_no", "actual_qty", "qty_after_transaction", "voucher_no", "posting_date"],
        order_by="posting_date asc, posting_time asc"
    )
    results["ledger_snapshot"] = snapshot

    return results