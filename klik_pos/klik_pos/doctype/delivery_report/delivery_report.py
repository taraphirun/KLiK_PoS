# Copyright (c) 2026, Beveren Sooftware Inc and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

DELIVERY_REALTIME_EVENT = "delivery_report_update"


class DeliveryReport(Document):
	def on_update(self):
		"""Push a minimal realtime update for the live map (Todo 031/032). Fires on every save -
		covers ingestion (insert) and every reconcile action (confirm/reject/re-match all end in a
		report.save()) with one hook, no need to emit separately from klik_pos/api/delivery.py.

		Skipped when there's no GPS to plot - nothing for the map to do with it. Broadcast to all
		logged-in sessions (no room/user scoping) - matches this module's existing authorization
		posture: the reconciliation/driver APIs already don't enforce a role check beyond "logged
		in" (decided with the user 2026-07-31, see phase-12.md).
		"""
		if self.gps_latitude is None or self.gps_longitude is None:
			return

		frappe.publish_realtime(
			DELIVERY_REALTIME_EVENT,
			{
				"name": self.name,
				"gps_latitude": self.gps_latitude,
				"gps_longitude": self.gps_longitude,
				"delivery_driver_name": self.delivery_driver_name or self.reported_driver_name,
				"completion_status": self.completion_status,
				"payment_status": self.payment_status,
				"reconciliation_status": self.reconciliation_status,
				"matched_invoice": self.matched_invoice,
				"reported_invoice_no": self.reported_invoice_no,
				"delivery_timestamp": str(self.delivery_timestamp) if self.delivery_timestamp else None,
			},
			after_commit=True,
		)
