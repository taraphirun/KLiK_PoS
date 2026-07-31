import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_field, create_custom_fields


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
    """Create/update the Sales Invoice fields that hold the *reconciled* (trusted) delivery
    outcome.

    These are only ever written by the Delivery Report confirm step (Module 10 / Todo 023) -
    never directly by the bot - so they're read-only in the desk form. Denormalized (including
    GPS) onto the invoice rather than read through custom_delivery_report so Report Builder/list
    filters can query them as real columns; custom_delivery_report is kept for audit/drill-down
    back to the raw bot payload. Distinct from the existing custom_delivery_personnel/_name
    fields, which track an internally-assigned delivery person, not the bot-reported driver on a
    confirmed delivery.

    allow_on_submit=1 is required on every data-carrying field here: reconciliation always runs
    *after* the invoice is already submitted (that's the entire point - it happens later, at
    delivery time), and Frappe blocks writes to non-allow_on_submit fields on a submitted
    document. Uses create_custom_fields (update=True) rather than create_custom_field so
    re-running this (e.g. after changing a field's properties) also fixes already-existing sites,
    not just fresh installs - see Todo 023 notes for the incident that made this necessary.
    """
    create_custom_fields(
        {
            "Sales Invoice": [
                {
                    "fieldname": "custom_delivery_status",
                    "label": "Delivery Status",
                    "fieldtype": "Select",
                    "options": "Pending\nDelivered\nPartially Delivered\nNot Delivered",
                    "default": "Pending",
                    "insert_after": "custom_delivery_personnel_name",
                    "read_only": 1,
                    "allow_on_submit": 1,
                },
                {
                    "fieldname": "custom_delivery_driver",
                    "label": "Delivery Driver (Bot Reported)",
                    "fieldtype": "Link",
                    "options": "Delivery Driver",
                    "insert_after": "custom_delivery_status",
                    "read_only": 1,
                    "allow_on_submit": 1,
                    "description": "Driver from the confirmed Delivery Report, not the internally-assigned Delivery Personnel above. Copied from Delivery Report.delivery_driver at confirm time (Todo 023) - already a resolved Link as of Todo 028, nothing to match here.",
                },
                {
                    "fieldname": "custom_delivery_driver_name",
                    "label": "Delivery Driver Name",
                    "fieldtype": "Data",
                    "fetch_from": "custom_delivery_driver.driver_name",
                    "insert_after": "custom_delivery_driver",
                    "read_only": 1,
                    "allow_on_submit": 1,
                },
                {
                    "fieldname": "custom_delivered_at",
                    "label": "Delivered At",
                    "fieldtype": "Datetime",
                    "insert_after": "custom_delivery_driver_name",
                    "read_only": 1,
                    "allow_on_submit": 1,
                },
                {
                    "fieldname": "custom_delivery_column_break",
                    "fieldtype": "Column Break",
                    "insert_after": "custom_delivered_at",
                },
                {
                    "fieldname": "custom_delivery_gps_latitude",
                    "label": "Delivery GPS Latitude",
                    "fieldtype": "Float",
                    "precision": "6",
                    "insert_after": "custom_delivery_column_break",
                    "read_only": 1,
                    "allow_on_submit": 1,
                },
                {
                    "fieldname": "custom_delivery_gps_longitude",
                    "label": "Delivery GPS Longitude",
                    "fieldtype": "Float",
                    "precision": "6",
                    "insert_after": "custom_delivery_gps_latitude",
                    "read_only": 1,
                    "allow_on_submit": 1,
                },
                {
                    "fieldname": "custom_delivery_report",
                    "label": "Delivery Report",
                    "fieldtype": "Link",
                    "options": "Delivery Report",
                    "insert_after": "custom_delivery_gps_longitude",
                    "read_only": 1,
                    "allow_on_submit": 1,
                    "description": "The confirmed Delivery Report this delivery outcome was reconciled from.",
                },
            ]
        },
        ignore_validate=True,
    )


def ensure_google_maps_api_key_field():
    """POS Profile field holding the Google Maps JavaScript API key for the Live Delivery Map
    (Module 13 / Todo 032). A JS API key is meant to run client-side (restrict it by HTTP
    referrer in Google Cloud Console, not treat it as a server secret) - Data, not Password, so
    it round-trips through the existing posDetails-on-frontend pattern this app already uses for
    other POS Profile custom fields (e.g. custom_az_coil_item_groups) without special-casing.
    """
    if frappe.db.exists("Custom Field", "POS Profile-custom_google_maps_api_key"):
        return

    create_custom_field(
        "POS Profile",
        {
            "fieldname": "custom_google_maps_api_key",
            "label": "Google Maps API Key",
            "fieldtype": "Data",
            "insert_after": "print_format",
            "module": "KLiK PoS",
            "description": "Google Maps JavaScript API key for the Live Delivery Map. Restrict this key to your site's domain(s) in Google Cloud Console.",
        },
        ignore_validate=True,
    )


def after_install():
    ensure_sales_invoice_reserve_stock_field()
    ensure_stock_reservation_is_enabled()
    ensure_az_coil_custom_fields()
    ensure_pos_print_format_field()
    ensure_delivery_reconciliation_fields()
    ensure_google_maps_api_key_field()
