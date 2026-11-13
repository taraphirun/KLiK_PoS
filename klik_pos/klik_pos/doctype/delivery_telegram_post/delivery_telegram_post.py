# Copyright (c) 2026, Beveren Sooftware Inc and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class DeliveryTelegramPost(Document):
	"""Which of a delivery app report's photos and voice note have been posted to the Telegram
	reporting group, and the id of the report's text message they reply to. Written only by
	klik_pos/api/delivery_app_media.py. Kept apart from Delivery Report on purpose: a stale
	report.save() elsewhere would write these columns back and lose them."""

	pass
