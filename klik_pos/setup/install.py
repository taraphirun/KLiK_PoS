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

def ensure_sales_invoice_return_outcome_field():
    """Marker for which return outcome (phase-17 §2c) produced a credit note. Display-only:
    the money itself lives in AR (payments rows / update_outstanding_for_self), this field
    just lets the UI and statement label store credits without inferring from GL."""
    if frappe.db.exists("Custom Field", "Sales Invoice-custom_return_outcome"):
        return

    create_custom_field(
        "Sales Invoice",
        {
            "fieldname": "custom_return_outcome",
            "label": "Return Outcome",
            "fieldtype": "Select",
            "options": "\nRefund\nReduce Bill\nStore Credit",
            "insert_after": "is_return",
            "read_only": 1,
            "depends_on": "eval:doc.is_return",
            "module": "KLiK PoS",
            "description": "How this return was settled: money refunded, original bill reduced, or kept as store credit.",
        },
        ignore_validate=True,
    )


def ensure_sales_invoice_return_funded_amount_field():
    """How much of THIS return's value was actually funded as cash or store credit at
    creation time (phase-17 §2c revision, 2026-08-15) - fixed at creation, never changed
    by later events (settling the unfunded remainder against the original, or the
    customer later redeeming spendable credit against some OTHER invoice).

    get_refundable_amount() sums this across a customer invoice's prior returns to know
    how much of the money actually received has already been committed away. Without a
    persisted field, that could only be reconstructed from payment rows (misses store
    credit entirely - it books no payment - undercounting what's already been given out
    and letting a later return over-claim "available" funds; user-reported, invoice
    00215: repeated cash+credit returns kept reporting nearly the full amount paid as
    still available on every subsequent return, because prior store-credit grants were
    invisible to the old cash-only calculation).
    """
    if frappe.db.exists("Custom Field", "Sales Invoice-custom_return_funded_amount"):
        return

    create_custom_field(
        "Sales Invoice",
        {
            "fieldname": "custom_return_funded_amount",
            "label": "Return Funded Amount",
            "fieldtype": "Currency",
            "insert_after": "custom_return_outcome",
            "read_only": 1,
            "depends_on": "eval:doc.is_return",
            "module": "KLiK PoS",
            "description": "How much of this return's value was given out as cash refund or spendable store credit (fixed at creation) - the rest settled the original invoice's own balance instead.",
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


def ensure_network_printer_field():
    """Create the POS Profile field that lets a register print silently to a network/USB
    printer registered in Frappe core's own "Network Printer Settings" (CUPS-backed,
    frappe.utils.print_format.print_by_server) instead of the browser's print dialog. Left
    blank, the POS print button keeps its existing hidden-iframe + window.print() behaviour
    unchanged - this is opt-in per profile, not a replacement.
    """
    if frappe.db.exists("Custom Field", "POS Profile-custom_network_printer"):
        return

    create_custom_field(
        "POS Profile",
        {
            "fieldname": "custom_network_printer",
            "label": "Network Printer",
            "fieldtype": "Link",
            "options": "Network Printer Settings",
            "insert_after": "custom_pos_printformat",
            "module": "KLiK PoS",
            "description": "If set, the POS print button sends the invoice straight to this printer server-side (no browser print dialog). Requires a Network Printer Settings record (Frappe core) and pycups installed on the server. Leave blank to keep the browser's own print dialog.",
        },
        ignore_validate=True,
    )


def ensure_sales_invoice_invoice_ref_field():
    """Sales Invoice field holding the physical paper invoice/booklet page number - the single
    most load-bearing field across the whole delivery/booklet feature set (Modules 15-17:
    read/written throughout klik_pos/api/booklet.py, delivery.py, sales_invoice.py) and yet, until
    this 2026-08-03 portability audit, was never created by any code in this app - it had been
    added directly on hd.phirun.me via Customize Form at some point before this project's current
    session history begins (Custom Field.creation: 2026-07-28, same day as initial site setup but
    not part of it), matching the long-standing BUG-002 note in bugs.md ("created directly on the
    site, never fully configured"). A real from-scratch install during this audit confirmed every
    booklet/reconciliation feature would silently break without this field existing at all.

    Kept as Int (decided with the user, 2026-08-03, BUG-002) - the entire booklet/daily
    reconciliation system (Module 17) is built around this being a real integer (page-range
    "between" queries, booklet-number bucket math), so converting to Data now would be a much
    larger, riskier rewrite than the field's original "free-text receipt number" framing was worth
    revisiting for. `allow_on_submit` is now explicitly 1 (BUG-002's other half) - the field is
    genuinely meant to be set after submission (that's the entire point of Daily Reconciliation's
    link/unlink actions), so this is a real fix, not a workaround. `link_invoice_to_page`/
    `unlink_invoice_page` (booklet.py) still use `frappe.db.set_value` rather than `doc.save()` for
    this field specifically - that's now a deliberate choice (a single-field admin correction
    shouldn't re-run the full Sales Invoice validate/stock chain), not a workaround for a missing
    field property.
    """
    create_custom_fields(
        {
            "Sales Invoice": [
                {
                    "fieldname": "custom_invoice_ref",
                    "label": "Invoice Ref",
                    "fieldtype": "Int",
                    "insert_after": "custom_pos_opening_entry",
                    "non_negative": 1,
                    "in_list_view": 1,
                    "in_standard_filter": 1,
                    "allow_on_submit": 1,
                    "description": "Reference number from hardcopy invoice",
                },
            ]
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
                    "options": "Pending\nDelivered\nPartially Delivered\nNot Delivered\nSelf Pickup",
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
                {
                    "fieldname": "custom_requested_delivery_date",
                    "label": "Requested Delivery Date",
                    "fieldtype": "Date",
                    "insert_after": "custom_delivery_report",
                    "read_only": 1,
                    "allow_on_submit": 1,
                    "description": "Set via Daily Reconciliation's 'Set Delivery Date' action (Module 17 follow-up, 2026-08-03) for a paper page purchased today but asked to be delivered later - e.g. a pre-order. Resolves the page on its own posting date (status 'Scheduled') but the invoice re-surfaces, actionable, on this date's own Daily Reconciliation checklist until Delivered/Self-Pickup is actually confirmed.",
                },
            ]
        },
        ignore_validate=True,
    )


def ensure_google_maps_api_key_field():
    """POS Profile fields holding Google Maps config for the Live Delivery Map (Module 13 /
    Todo 032, Map ID added as a 2026-08-03 follow-up). Both are meant to run client-side (restrict
    the API key by HTTP referrer in Google Cloud Console, not treat it as a server secret) - Data,
    not Password, so they round-trip through the existing posDetails-on-frontend pattern this app
    already uses for other POS Profile custom fields (e.g. custom_az_coil_item_groups) without
    special-casing.

    custom_google_maps_map_id is optional (unlike the API key, the map still renders without it -
    just falls back to classic raster tiles). Setting it switches Live Delivery Map to vector
    (WebGL) rendering, which is what actually makes smooth/animated zoom possible without visible
    tile-reload flicker - raster tiles are discrete images per integer zoom level, so any zoom
    change forces new tiles to load; vector rendering has no such per-level tiles. Confirmed with
    the user (2026-08-03) this tradeoff (a one-time Cloud Console Map ID setup step) is worth it -
    mirrors exactly how the companion hd-delivery-telegram bot's own live map already works
    (frontend/src/components/DeliveryMap.tsx sets a mapId + drives smooth flyTo via
    map.moveCamera(), ported into klik_spa's MapFocuser).

    custom_live_map_auto_focus (2026-08-06 follow-up, user request) - toggles whether a brand-new
    delivery reported while the Live Delivery Map is open flies the camera to it automatically
    (same MapFocuser flyTo, mirroring the companion bot's own confettiMode: "pan" behavior).
    Default checked ("1") - Frappe backfills that default onto the column for existing POS Profile
    rows too when the column is first added, not just new ones, so this doesn't silently turn off
    for sites that already had the map configured before this field existed.
    """
    create_custom_fields(
        {
            "POS Profile": [
                {
                    "fieldname": "custom_google_maps_api_key",
                    "label": "Google Maps API Key",
                    "fieldtype": "Data",
                    "insert_after": "print_format",
                    "description": "Google Maps JavaScript API key for the Live Delivery Map. Restrict this key to your site's domain(s) in Google Cloud Console.",
                },
                {
                    "fieldname": "custom_google_maps_map_id",
                    "label": "Google Maps Map ID",
                    "fieldtype": "Data",
                    "insert_after": "custom_google_maps_api_key",
                    "description": "Optional. Create one in Google Cloud Console (Google Maps Platform → Map Management), same project as the API key above, to enable smooth vector-rendered zoom on the Live Delivery Map. Leave blank to keep classic raster tiles.",
                },
                {
                    "fieldname": "custom_live_map_auto_focus",
                    "label": "Live Map Auto-Focus on New Delivery",
                    "fieldtype": "Check",
                    "default": "1",
                    "insert_after": "custom_google_maps_map_id",
                    "description": "When a new delivery is reported while the Live Delivery Map is open, automatically pan/zoom the camera to it. Uncheck to leave the camera where staff last left it.",
                },
            ]
        },
        ignore_validate=True,
    )


def ensure_warehouse_shop_location_fields():
    """Warehouse fields holding a shop's coordinates for the Live Delivery Map (2026-08-03
    follow-up) - the user wants a fixed "shop" pin shown alongside delivery pins, since most
    deliveries originate near the shop. Not every Warehouse is a shop (raw material/transit
    warehouses etc.), so get_shop_locations (klik_pos.api.delivery) doesn't use these fields
    alone - it only shows a warehouse that's also assigned to an *enabled* POS Profile (decided
    with the user: "pos profile is open per warehouse so select the address of those warehouse
    only"), which is this app's existing signal for "this warehouse is a real till/shop location."
    Manual lat/lng entry (decided with the user) rather than address-typing + geocoding, so no
    Places API is needed beyond the Maps JavaScript API already in use.
    """
    create_custom_fields(
        {
            "Warehouse": [
                {
                    "fieldname": "custom_shop_latitude",
                    "label": "Shop Latitude",
                    "fieldtype": "Float",
                    "precision": "6",
                    "insert_after": "pin",
                    "description": "Shown as a fixed shop pin on the Live Delivery Map, if this warehouse is also assigned to an enabled POS Profile.",
                },
                {
                    "fieldname": "custom_shop_longitude",
                    "label": "Shop Longitude",
                    "fieldtype": "Float",
                    "precision": "6",
                    "insert_after": "custom_shop_latitude",
                },
            ]
        },
        ignore_validate=True,
    )


def ensure_delivery_bot_role():
    """Creates the 'Delivery Bot' role and its permissions on the doctypes the companion
    hd-delivery-telegram bot's service account (delivery-bot@hd-telegram.local) needs to poll/
    write - Delivery Report, Delivery Booklet, Delivery Booklet Settings.

    Found missing from this app's own code during a 2026-08-03 portability audit (the user is
    planning to recreate their site from scratch and wanted assurance the app wouldn't silently
    depend on manual Desk configuration that only happens to exist on the current install). Both
    the role and its Custom DocPerm grants had been created directly via Desk/console at some
    point (Role.creation on the live site: 2026-07-31, well after initial site setup) - invisible
    to `bench install-app` on a fresh site, and not fixture-exported either (this app's `fixtures`
    hook in hooks.py only covers Property Setter, not Custom DocPerm or Role). Replicated here with
    the exact permission flags already verified working in production - read/write/create/export,
    deliberately no delete/submit/report/print/share, matching what's live on hd.phirun.me.

    The bot's own User account and its API key are NOT recreated here (deliberately) - a fresh
    site needs a new API key regardless (the old one is meaningless once the site is gone), so
    that step stays manual either way, same as normal ERPNext onboarding (Company/Warehouse/POS
    Profile also aren't seeded here - those are standard setup, not something this app owns).
    """
    from frappe.permissions import add_permission, update_permission_property

    if not frappe.db.exists("Role", "Delivery Bot"):
        frappe.get_doc({"doctype": "Role", "role_name": "Delivery Bot", "desk_access": 0}).insert(
            ignore_permissions=True
        )

    grants = {
        "Delivery Report": {"read": 1, "write": 1, "create": 1, "export": 1},
        "Delivery Booklet": {"read": 1, "write": 1, "create": 1, "export": 1},
        "Delivery Booklet Settings": {"read": 1, "write": 1, "create": 1, "export": 1},
    }
    for doctype, ptypes in grants.items():
        if not frappe.db.exists("Custom DocPerm", {"parent": doctype, "role": "Delivery Bot", "permlevel": 0}):
            add_permission(doctype, "Delivery Bot", 0)
        for ptype, value in ptypes.items():
            update_permission_property(doctype, "Delivery Bot", 0, ptype, value)


def after_install():
    ensure_sales_invoice_reserve_stock_field()
    ensure_stock_reservation_is_enabled()
    ensure_az_coil_custom_fields()
    ensure_pos_print_format_field()
    ensure_network_printer_field()
    ensure_sales_invoice_invoice_ref_field()
    ensure_delivery_reconciliation_fields()
    ensure_google_maps_api_key_field()
    ensure_warehouse_shop_location_fields()
    ensure_delivery_bot_role()
