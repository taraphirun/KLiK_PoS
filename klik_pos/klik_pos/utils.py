import frappe
from frappe import _

# Performance optimization: Cache frequently accessed data per user and opening entry
# Key: f"{user}|{opening_entry or 'none'}", Value: POS Profile name (identity only)
_cached_pos_profiles = {}
_cached_company_data = {}


def get_current_pos_profile():
	"""Get the active POS Profile with identity-only caching keyed by user and opening entry.

	Returns a fresh POS Profile Doc each call to avoid stale field values.
	"""
	user = frappe.session.user

	from klik_pos.api.sales_invoice import get_current_pos_opening_entry

	current_opening_entry = get_current_pos_opening_entry()
	cache_key = f"{user}|{current_opening_entry or 'none'}"

	# Resolve POS Profile name using cache identity
	if cache_key in _cached_pos_profiles:
		pos_profile_name = _cached_pos_profiles[cache_key]
	else:
		if current_opening_entry:
			opening_doc = frappe.get_doc("POS Opening Entry", current_opening_entry)
			pos_profile_name = opening_doc.pos_profile
		else:
			pos_profile_name = frappe.get_value("POS Profile User", {"user": user}, "parent")
			if not pos_profile_name:
				frappe.throw(_("No POS Profile found for user {0}").format(user))

		# Cache identity (name) only
		_cached_pos_profiles[cache_key] = pos_profile_name

	# Mania: Always fetch a fresh doc to ensure latest fields -> Issue reported 04/11/2025
	pos_profile_doc = frappe.get_doc("POS Profile", pos_profile_name)
	return pos_profile_doc


def clear_pos_profile_cache(user=None):
	"""Clear cached POS Profile identities. If user provided, clear all entries for that user."""
	global _cached_pos_profiles

	if user:
		# Clear all cache entries matching the user prefix
		keys_to_delete = [k for k in list(_cached_pos_profiles.keys()) if k.startswith(f"{user}|")]
		for k in keys_to_delete:
			del _cached_pos_profiles[k]
		if keys_to_delete:
			frappe.logger().info(
				f"🧹 POS Profile cache cleared for user: {user} ({len(keys_to_delete)} entries)"
			)
	else:
		# Clear cache for current user
		current_user = frappe.session.user
		keys_to_delete = [k for k in list(_cached_pos_profiles.keys()) if k.startswith(f"{current_user}|")]
		for k in keys_to_delete:
			del _cached_pos_profiles[k]
		if keys_to_delete:
			frappe.logger().info(
				f"🧹 POS Profile cache cleared for user: {current_user} ({len(keys_to_delete)} entries)"
			)


def get_user_default_company():
	user = frappe.session.user
	return frappe.defaults.get_user_default(user, "Company")


def get_customer_credit_summary(customer, company=None):
	"""Exposed to print-format Jinja templates (see hooks.py `jinja.methods`).

	Reuses the same credit_limit/outstanding source as the POS credit-limit check
	(klik_pos.api.customer._get_customer_credit_info) so the numbers shown on a printed
	invoice always agree with what is enforced on submit. Lazy import to avoid a circular
	import (api.customer already imports get_current_pos_profile from this module).
	"""
	if not customer:
		return {}

	from klik_pos.api.customer import _get_customer_credit_info

	company = company or get_user_default_company()
	if not company:
		return {}

	return _get_customer_credit_info([customer], company).get(customer, {})


def get_invoice_qr_png(invoice_name):
	"""Exposed to print-format Jinja templates (see hooks.py `jinja.methods`).

	Encodes just the Sales Invoice name as plain text - deliberately not a URL or JSON blob, so
	the delivery bot can scan the printed invoice and look the record up directly by name.
	Reuses frappe's own pyqrcode dependency (already used for 2FA, see frappe/twofactor.py) so no
	new package is needed. Generated fresh at print time - not stored on the doc.

	PNG rather than SVG-in-<img>: the invoice print format is rendered by three different
	engines (cashier's browser, server-side PDF, and Telegram's PDF->PNG conversion) and SVG
	rasterization inside <img> is unreliable under wkhtmltopdf - PNG is safe everywhere.
	"""
	if not invoice_name:
		return ""

	from base64 import b64encode
	from io import BytesIO

	from pyqrcode import create as qrcreate

	stream = BytesIO()
	try:
		qrcreate(invoice_name, error="M").png(stream, scale=6, module_color="#000", background="#fff")
		png = stream.getvalue()
	finally:
		stream.close()

	return f"data:image/png;base64,{b64encode(png).decode()}"


def paginate_invoice_items(items, page_size=14):
	"""Exposed to print-format Jinja templates (see hooks.py `jinja.methods`).

	Splits Sales Invoice items into fixed-size pages for the A5 print format ("Invoice Khmer A5"),
	whose table box is a fixed physical size on the paper form it mirrors - 14 rows, always. Real
	items come first, then None padding, so the table is the same size on every page whether it
	holds 1 item or 14. Row numbers continue across pages instead of restarting at 1. Always
	returns at least one page (of all-blank rows) even for an empty item list, so the template
	never has to special-case zero items.
	"""
	items = list(items or [])
	total_pages = max(1, -(-len(items) // page_size))  # ceil division

	pages = []
	for p in range(total_pages):
		chunk = items[p * page_size : (p + 1) * page_size]
		rows = [
			{"no": p * page_size + i + 1, "item": chunk[i] if i < len(chunk) else None}
			for i in range(page_size)
		]
		pages.append(
			{
				"page_no": p + 1,
				"total_pages": total_pages,
				"rows": rows,
				"is_last": p == total_pages - 1,
			}
		)
	return pages
