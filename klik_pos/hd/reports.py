"""Manager reporting endpoints for klik_pos.

New functionality kept in its own module (fork discipline). Everything here is read-only
aggregation - pure SELECTs, no document writes.
"""

import frappe
from frappe import _
from frappe.utils import flt, nowdate


@frappe.whitelist()
def get_seller_day_summary(from_date=None, to_date=None, pos_profile=None):
	"""Per-seller day overview for managers: each seller's net sales, transaction count, and
	drawer variance for a date range (default: today), optionally scoped to one POS Profile
	(default: all profiles).

	Admin-gated (Administrator / Sales Manager / System Manager). Read-only.

	Returns {"success": True, "data": [{user, seller_name, sales, transactions, variance,
	closed}], ...} sorted by sales desc. `variance` is None (and closed False) for a seller
	whose shift has no submitted POS Closing Entry in range yet ("Open").
	"""
	from klik_pos.api.payment import _check_admin_privileges

	if not _check_admin_privileges():
		frappe.throw(_("You are not permitted to view the seller overview."), frappe.PermissionError)

	from_date = from_date or nowdate()
	to_date = to_date or from_date

	from klik_pos.api.sql_builder import apply_sql_permissions

	# --- Net sales + transaction count per seller (owner) ---
	conditions = (
		"si.posting_date BETWEEN %s AND %s AND si.docstatus = 1 "
		"AND si.custom_pos_opening_entry IS NOT NULL AND si.custom_pos_opening_entry != ''"
	)
	params = [from_date, to_date]
	if pos_profile:
		conditions += " AND si.pos_profile = %s"
		params.append(pos_profile)

	sales_sql = apply_sql_permissions(
		"SELECT si.owner AS owner, SUM(si.grand_total) AS sales, "
		"COUNT(DISTINCT si.name) AS transactions "
		"FROM `tabSales Invoice` si "
		f"WHERE {conditions} "
		"GROUP BY si.owner"
	)
	sales_rows = frappe.db.sql(sales_sql, tuple(params), as_dict=True)

	# --- Drawer variance per seller from their POS Closing Entries (counted - expected) ---
	var_conditions = "pce.posting_date BETWEEN %s AND %s AND pce.docstatus = 1"
	var_params = [from_date, to_date]
	if pos_profile:
		var_conditions += " AND pce.pos_profile = %s"
		var_params.append(pos_profile)

	var_rows = frappe.db.sql(
		"SELECT pce.user AS user, SUM(pcd.difference) AS variance "
		"FROM `tabPOS Closing Entry` pce "
		"JOIN `tabPOS Closing Entry Detail` pcd ON pcd.parent = pce.name "
		f"WHERE {var_conditions} "
		"GROUP BY pce.user",
		tuple(var_params),
		as_dict=True,
	)
	variance_map = {r.user: flt(r.variance) for r in var_rows}

	# --- Display names ---
	from klik_pos.api.sales_invoice import _batch_fetch_cashier_names

	owners = [r.owner for r in sales_rows]
	names = _batch_fetch_cashier_names(owners) if owners else {}

	data = []
	for r in sales_rows:
		closed = r.owner in variance_map
		data.append(
			{
				"user": r.owner,
				"seller_name": names.get(r.owner, r.owner),
				"sales": flt(r.sales),
				"transactions": int(r.transactions or 0),
				"variance": variance_map.get(r.owner) if closed else None,
				"closed": closed,
			}
		)

	data.sort(key=lambda x: x["sales"], reverse=True)
	return {
		"success": True,
		"data": data,
		"from_date": from_date,
		"to_date": to_date,
		"pos_profile": pos_profile,
	}
