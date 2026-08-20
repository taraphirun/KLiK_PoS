import functools

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


def estimate_description_slots(plain_text, chars_per_line=30, lines_per_slot=2):
	"""Rough, deliberately conservative estimate of how many item-row "slots" (see
	paginate_invoice_items) a plain-text description will need once wrapped in the print format.

	chars_per_line=30 matches the description cell's 14px font (same size as the item name) and
	12mm left indent (132mm width minus 12mm left / 4mm right padding). Keep this in step with
	that font-size: it was 36 while the cell was 12px, and scales inversely (36 * 12/14 ~= 30),
	so bumping the font without dropping this number silently makes the estimate optimistic - the
	one direction this must never err in, per the note below. Used ONLY to decide how
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


# --- Item-name shrink-to-fit -------------------------------------------------------------------
# Geometry of the A5 print format's item-name cell, mirrored from its CSS. Keep in step with
# .table-container (width: 132mm), .col-name (width: 38%) and the "table.items th, table.items td"
# padding rule (0 4px) in the "Invoice Khmer A5" print format.
_A5_TABLE_WIDTH_MM = 132
_A5_COL_NAME_FRACTION = 0.38
_A5_CELL_PADDING_PX = 4
_PX_PER_MM = 96 / 25.4

ITEM_NAME_MAX_FONT_PX = 14
ITEM_NAME_MIN_FONT_PX = 8
# PIL measures raw glyph advances; a browser adds its own hinting/subpixel rounding, so shave a
# couple of px off the real cell width. Erring small means we shrink one step early (harmless),
# rather than declaring a fit that the renderer then ellipsizes (the failure this exists to stop).
_ITEM_NAME_SAFETY_PX = 2

_ITEM_NAME_FONT = "KhmerOSbattambang.ttf"


def _item_name_cell_width_px():
	width_mm = _A5_TABLE_WIDTH_MM * _A5_COL_NAME_FRACTION
	return width_mm * _PX_PER_MM - (2 * _A5_CELL_PADDING_PX) - _ITEM_NAME_SAFETY_PX


@functools.lru_cache(maxsize=32)
def _load_name_font(size_px):
	"""Cached PIL font handle at one pixel size, or None if measurement isn't possible here.

	Pillow ships with Frappe and this bench's build has raqm, so Khmer clusters (stacked vowel
	signs/subscript consonants) shape and measure correctly rather than being counted as separate
	advances. Returns None - never raises - if Pillow or the vendored font is unavailable, so a
	print silently falls back to the plain 14px CSS rather than failing outright.
	"""
	try:
		from PIL import ImageFont

		return ImageFont.truetype(
			frappe.get_app_path("klik_pos", "public", "fonts", _ITEM_NAME_FONT), size_px
		)
	except Exception:
		return None


@functools.lru_cache(maxsize=512)
def fit_item_name_font_size(item_name):
	"""Largest font size (px) at which `item_name` fits the A5 invoice's name cell on one line.

	Steps down 14px -> 8px in 1px increments and returns the first size that fits, or None when the
	name already fits at the default (the common case - the template then emits no inline style at
	all and the plain .td-box CSS applies).

	Measured against the real vendored font the print format loads, NOT estimated from character
	count: these names mix Khmer with Latin/digits ("3.0c ... ISI Palm 50"), whose per-character
	widths differ by more than 2x, so a character count is not a usable proxy for width here.

	Returns ITEM_NAME_MIN_FONT_PX when even the floor doesn't fit - the name then still ellipsizes
	via .td-box's existing overflow/text-overflow, which stays as the last-resort behaviour. This is
	deliberately the only place that truncation can still happen, and only below 8px, where Khmer
	subscript consonants stop being legible in print anyway.
	"""
	name = (item_name or "").strip()
	if not name:
		return None

	limit = _item_name_cell_width_px()
	for size in range(ITEM_NAME_MAX_FONT_PX, ITEM_NAME_MIN_FONT_PX - 1, -1):
		font = _load_name_font(size)
		if font is None:
			return None  # no measurement available - leave the CSS default alone
		box = font.getbbox(name)
		if (box[2] - box[0]) <= limit:
			return None if size == ITEM_NAME_MAX_FONT_PX else size
	return ITEM_NAME_MIN_FONT_PX


def _get_az_coil_item_groups(pos_profile):
	"""AZ Coil item groups configured on POS Profile.custom_az_coil_item_groups - the same table
	cartStore.ts reads client-side (as `isAZCoilItem`) to decide which items get the roofing-spec
	cart flow. Reused here so the print format's "only AZ Coil items get a description line" rule
	agrees with what actually produced that description in the first place. Falls back to {"zn"}
	when nothing is configured, matching cartStore.ts's own fallback.
	"""
	groups = set()
	if pos_profile:
		rows = frappe.get_all(
			"KLiK AZ Coil Item Group", filters={"parent": pos_profile}, fields=["item_group"]
		)
		groups = {row.item_group.strip().lower() for row in rows if row.item_group}
	return groups or {"zn"}


def paginate_invoice_items(items, slots_per_page=14, pos_profile=None):
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

	`pos_profile` (the invoice's own `doc.pos_profile`, passed by the print format) gates the
	description line to AZ Coil items only - business requirement: every other item just shows its
	name, even if some other flow ever populates its `description` field. Pass None (e.g. from a
	caller with no POS Profile in scope) to fall back to the {"zn"} default in
	_get_az_coil_item_groups rather than showing no descriptions at all.

	Each row also carries `name_font_size` - a px size for that row's item name when it is too wide
	for the name cell at the default 14px, else None. See fit_item_name_font_size. Shrinking is
	per-row by design (a single long name does not pull the rest of the table down with it) and
	never changes row height, so it has no effect on the slot math above.
	"""
	import html as html_module

	az_coil_groups = _get_az_coil_item_groups(pos_profile)

	items = list(items or [])
	prepared = []
	for it in items:
		plain_desc = ""
		if (it.item_group or "").strip().lower() in az_coil_groups:
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
		# Per-line tax-inclusive gross-up factor (1 + the line's OWN tax %). The print format
		# multiplies net_rate/net_amount by this so a taxed row prints its tax-inclusive price
		# while an untaxed row is unchanged (factor 1). Exact for On-Net-Total item taxes.
		tax_map = getattr(it, "item_tax_rate", None)
		if isinstance(tax_map, str):
			try:
				tax_map = frappe.parse_json(tax_map or "{}")
			except Exception:
				tax_map = {}
		line_incl = 1 + (sum(frappe.utils.flt(v) for v in (tax_map or {}).values()) / 100.0)

		prepared.append(
			{
				"item": it,
				"description": display_desc,
				"slots": 1 + estimate_description_slots(plain_desc),
				# None for the overwhelming majority of names (they fit at the default) - the
				# template then emits no inline style and .td-box's own font-size applies.
				"name_font_size": fit_item_name_font_size(getattr(it, "item_name", "")),
				"line_incl": line_incl,
			}
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
			page_rows.append({"no": running_no, "item": None, "description": "", "name_font_size": None, "line_incl": 1})
			remaining -= 1
		pages.append(page_rows)
		page_rows = []
		page_slots_used = 0

	for entry in prepared:
		if page_rows and page_slots_used + entry["slots"] > slots_per_page:
			flush_page()
		running_no += 1
		page_rows.append(
			{
				"no": running_no,
				"item": entry["item"],
				"description": entry["description"],
				"name_font_size": entry["name_font_size"],
				"line_incl": entry["line_incl"],
			}
		)
		page_slots_used += entry["slots"]

	if page_rows or not pages:
		flush_page()

	total_pages = len(pages)
	return [
		{"page_no": i + 1, "total_pages": total_pages, "rows": rows, "is_last": i == total_pages - 1}
		for i, rows in enumerate(pages)
	]
