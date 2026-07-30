import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_field


def before_install():
    """Remove custom fields and property setters added by the old POS extension."""
    custom_fields_to_remove = [
        "POS Profile-custom_require_sales_person",
        "POS Profile-custom_sales_person_pin_required",
        "Sales Person-pos_pin",
        "Customer-custom_is_walkin",
    ]

    for field_name in custom_fields_to_remove:
        if frappe.db.exists("Custom Field", field_name):
            frappe.delete_doc("Custom Field", field_name, ignore_permissions=True)


def ensure_sales_invoice_reserve_stock_field():
    """Create the custom reserve stock flag on Sales Invoice if it does not exist."""
    if frappe.db.exists("Custom Field", "Sales Invoice-reserve_stock"):
        return

    create_custom_field(
        "Sales Invoice",
        {
            "fieldname": "reserve_stock",
            "label": "Reserve Stock",
            "fieldtype": "Check",
            "insert_after": "is_pos",
            "default": "0",
            "read_only": 1,
            "hidden": 1,
            "module": "KLiK PoS",
            "description": "Reserve stock using ERPNext Stock Reservation Entry while the invoice is queued or pending submission.",
        },
        ignore_validate=True,
    )

def ensure_stock_reservation_is_enabled():
    if not frappe.db.get_single_value("Stock Settings", "enable_stock_reservation"):
        frappe.db.set_value("Stock Settings", None, "enable_stock_reservation", 1)

def ensure_az_coil_item_group_child_table():
    if not frappe.db.exists("DocType", "KLiK AZ Coil Item Group"):
        doc = frappe.get_doc({
            "doctype": "DocType",
            "name": "KLiK AZ Coil Item Group",
            "module": "KLiK PoS",
            "istable": 1,
            "custom": 1,
            "fields": [
                {
                    "fieldname": "item_group",
                    "fieldtype": "Link",
                    "options": "Item Group",
                    "label": "Item Group",
                    "in_list_view": 1
                }
            ]
        })
        doc.insert(ignore_permissions=True)

def ensure_az_coil_custom_fields():
    ensure_az_coil_item_group_child_table()
    create_custom_field(
        "POS Profile",
        {
            "fieldname": "custom_az_coil_item_groups",
            "label": "AZ Coil Item Groups",
            "fieldtype": "Table",
            "options": "KLiK AZ Coil Item Group",
            "insert_after": "custom_business_type",
            "module": "KLiK PoS",
        },
        ignore_validate=True,
    )
    create_custom_field(
        "Sales Invoice Item",
        {
            "fieldname": "custom_ds_roofing_spec",
            "label": "DS Roofing Spec",
            "fieldtype": "JSON",
            "insert_after": "description",
            "module": "KLiK PoS",
        },
        ignore_validate=True,
    )
    create_custom_field(
        "Sales Invoice Item",
        {
            "fieldname": "custom_description",
            "label": "Custom Description",
            "fieldtype": "Text",
            "insert_after": "custom_ds_roofing_spec",
            "module": "KLiK PoS",
        },
        ignore_validate=True,
    )

def ensure_pos_print_format_field():
    """Create the POS Profile field that erpnext_telegram_integration's
    send_document_to_telegram reads (get_pos_print_format) to pick which print
    format to render for Telegram PDF/image attachments. That app references
    the field by name but never ships a fixture for it, so without this it
    silently falls back to the 'Standard' print format instead of whatever the
    POS Profile is actually configured to use.
    """
    if frappe.db.exists("Custom Field", "POS Profile-custom_pos_printformat"):
        return

    create_custom_field(
        "POS Profile",
        {
            "fieldname": "custom_pos_printformat",
            "label": "Telegram Print Format",
            "fieldtype": "Link",
            "options": "Print Format",
            "insert_after": "print_format",
            "module": "KLiK PoS",
            "description": "Print format used when sending invoices to Telegram (erpnext_telegram_integration.get_pos_print_format). Falls back to 'Standard' if left blank.",
        },
        ignore_validate=True,
    )


def ensure_delivery_reconciliation_fields():
    """Create the Sales Invoice fields that hold the *reconciled* (trusted) delivery outcome.

    These are only ever written by the Delivery Report confirm step (Module 10 / Todo 023) -
    never directly by the bot - so they're read-only here. Denormalized (including GPS) onto
    the invoice rather than read through custom_delivery_report so Report Builder/list filters
    can query them as real columns; custom_delivery_report is kept for audit/drill-down back to
    the raw bot payload. Distinct from the existing custom_delivery_personnel/_name fields, which
    track an internally-assigned delivery person, not the bot-reported driver on a confirmed
    delivery.
    """
    fields = [
        {
            "fieldname": "custom_delivery_status",
            "label": "Delivery Status",
            "fieldtype": "Select",
            "options": "Pending\nDelivered\nPartially Delivered\nNot Delivered",
            "default": "Pending",
            "insert_after": "custom_delivery_personnel_name",
            "read_only": 1,
            "module": "KLiK PoS",
        },
        {
            "fieldname": "custom_delivery_driver",
            "label": "Delivery Driver (Bot Reported)",
            "fieldtype": "Data",
            "insert_after": "custom_delivery_status",
            "read_only": 1,
            "module": "KLiK PoS",
            "description": "Driver name from the confirmed Delivery Report, not the internally-assigned Delivery Personnel above.",
        },
        {
            "fieldname": "custom_delivered_at",
            "label": "Delivered At",
            "fieldtype": "Datetime",
            "insert_after": "custom_delivery_driver",
            "read_only": 1,
            "module": "KLiK PoS",
        },
        {
            "fieldname": "custom_delivery_column_break",
            "fieldtype": "Column Break",
            "insert_after": "custom_delivered_at",
            "module": "KLiK PoS",
        },
        {
            "fieldname": "custom_delivery_gps_latitude",
            "label": "Delivery GPS Latitude",
            "fieldtype": "Float",
            "precision": "6",
            "insert_after": "custom_delivery_column_break",
            "read_only": 1,
            "module": "KLiK PoS",
        },
        {
            "fieldname": "custom_delivery_gps_longitude",
            "label": "Delivery GPS Longitude",
            "fieldtype": "Float",
            "precision": "6",
            "insert_after": "custom_delivery_gps_latitude",
            "read_only": 1,
            "module": "KLiK PoS",
        },
        {
            "fieldname": "custom_delivery_report",
            "label": "Delivery Report",
            "fieldtype": "Link",
            "options": "Delivery Report",
            "insert_after": "custom_delivery_gps_longitude",
            "read_only": 1,
            "module": "KLiK PoS",
            "description": "The confirmed Delivery Report this delivery outcome was reconciled from.",
        },
    ]

    for field in fields:
        if frappe.db.exists("Custom Field", f"Sales Invoice-{field['fieldname']}"):
            continue
        create_custom_field("Sales Invoice", field, ignore_validate=True)


def after_install():
    ensure_sales_invoice_reserve_stock_field()
    ensure_stock_reservation_is_enabled()
    ensure_az_coil_custom_fields()
    ensure_pos_print_format_field()
    ensure_delivery_reconciliation_fields()
