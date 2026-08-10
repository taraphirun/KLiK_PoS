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


def get_plain_item_description(description_html):
	"""Convert a Sales Invoice Item's rich-text `description` field to plain text for the A5
	print format's per-item spec line (e.g. a roofing sheet's custom cutting order - the whole
	point of showing it is so the workshop can prepare from it, so it must never be silently
	dropped or garbled). Block-level tags become newlines so multi-line specs ("Size: ...",
	"Color: ...") keep their line structure; everything else is stripped - rich formatting
	(bold/bullets) isn't preserved by design, see the print format's own notes on why. Returns
	"" for an empty/whitespace-only description.
	"""
	import html as html_module
	import re

	if not description_html:
		return ""

	text = re.sub(r"(?i)<br\s*/?>", "\n", description_html)
	text = re.sub(r"(?i)</(p|div|li|h[1-6])>", "\n", text)
	text = re.sub(r"(?i)<[^>]+>", "", text)
	text = html_module.unescape(text)

	lines = [ln.strip() for ln in text.split("\n")]
	lines = [ln for ln in lines if ln]
	return "\n".join(lines)


def estimate_description_slots(plain_text, chars_per_line=36, lines_per_slot=2):
	"""Rough, deliberately conservative estimate of how many item-row "slots" (see
	paginate_invoice_items) a plain-text description will need once wrapped in the print format.

	chars_per_line=36 matches the description cell's 12px font (same size as the item name) and
	12mm left indent (132mm width minus 12mm left / 4mm right padding). Used ONLY to decide how
	many items fit on a page - never
	to truncate the actual text. Business requirement: a description (e.g. a custom roofing-sheet
	cutting spec the workshop prepares from) must never be cut off, so undercounting
	characters-per-line here is the safe direction - worst case it wastes a little blank space on
	the page (an explicitly accepted tradeoff - a very long description occasionally using up a
	whole page's worth of slots is fine), it never causes real content to not fit where the layout
	expected it.
	"""
	import math

	if not plain_text:
		return 0

	total_lines = 0
	for line in plain_text.split("\n"):
		total_lines += max(1, math.ceil(len(line) / chars_per_line))
	return math.ceil(total_lines / lines_per_slot)


def paginate_invoice_items(items, slots_per_page=14):
	"""Exposed to print-format Jinja templates (see hooks.py `jinja.methods`).

	Splits Sales Invoice items into pages for the A5 print format ("Invoice Khmer A5"), whose
	table box is a fixed physical size on the paper form it mirrors - 14 row-slots per page.

	Most items cost exactly 1 slot (their own row) and this behaves exactly like the old fixed
	14-items-per-page chunking. An item with a populated `description` (used for a handful of
	customized-order products, e.g. a roofing sheet's cutting spec - NOT the common case, most
	items have no description at all) costs 1 slot for its own row plus more for however many
	wrapped lines the description is estimated to need, and is rendered as a second, full-width
	row directly beneath it. Items are packed greedily - if the next item wouldn't fit in the
	slots remaining on the current page, it starts a new page instead, so a described item's row
	is never split across a page break. Blank rows pad every page out to exactly 14 slots with
	continuously-numbered rows, matching the old behaviour. Always returns at least one page (of
	all-blank rows) even for an empty item list.

	A description is deliberately never truncated (see estimate_description_slots) - the estimate
	just decides pagination, so the print format's own CSS must not clip it either (no
	overflow:hidden on anything a description can land in).
	"""
	import html as html_module

	items = list(items or [])
	prepared = []
	for it in items:
		plain_desc = get_plain_item_description(getattr(it, "description", None))
		# ERPNext often defaults an item's description to its item_name verbatim - only show it
		# when it actually adds information beyond the name already printed in this row.
		if plain_desc and plain_desc.strip() == (it.item_name or "").strip():
			plain_desc = ""
		# Numbered "1. 2. 3. ..." per line, e.g. a roofing spec's rows - each line is one
		# distinct measurement/instruction, so a number ties the printed line back to the row
		# the cashier entered it as.
		display_desc = (
			"<br>".join(
				f"{i}. {html_module.escape(ln)}" for i, ln in enumerate(plain_desc.split("\n"), start=1)
			)
			if plain_desc
			else ""
		)
		prepared.append(
			{"item": it, "description": display_desc, "slots": 1 + estimate_description_slots(plain_desc)}
		)

	pages = []
	page_rows = []
	page_slots_used = 0
	running_no = 0

	def flush_page():
		nonlocal page_rows, page_slots_used, running_no
		remaining = slots_per_page - page_slots_used
		while remaining > 0:
			running_no += 1
			page_rows.append({"no": running_no, "item": None, "description": ""})
			remaining -= 1
		pages.append(page_rows)
		page_rows = []
		page_slots_used = 0

	for entry in prepared:
		if page_rows and page_slots_used + entry["slots"] > slots_per_page:
			flush_page()
		running_no += 1
		page_rows.append({"no": running_no, "item": entry["item"], "description": entry["description"]})
		page_slots_used += entry["slots"]

	if page_rows or not pages:
		flush_page()

	total_pages = len(pages)
	return [
		{"page_no": i + 1, "total_pages": total_pages, "rows": rows, "is_last": i == total_pages - 1}
		for i, rows in enumerate(pages)
	]
