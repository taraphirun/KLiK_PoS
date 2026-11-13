# Copyright (c) 2026, Beveren Sooftware Inc and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class DeliveryReportPayment(Document):
	"""One payment a driver collected, as reported by the delivery app (Delivery Report child
	table). `mode` is kept as the app sends it ("cash", "aba", "acleda", ...) so a new bank needs
	no change here; the reconciliation page maps it to a display name."""

	pass
