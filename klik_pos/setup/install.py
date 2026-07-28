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

def after_install():
    ensure_sales_invoice_reserve_stock_field()
    ensure_stock_reservation_is_enabled()
    ensure_az_coil_custom_fields()
