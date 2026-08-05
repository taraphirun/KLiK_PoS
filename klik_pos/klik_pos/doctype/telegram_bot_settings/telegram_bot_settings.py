# Copyright (c) 2026, Beveren Sooftware Inc and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class TelegramBotSettings(Document):
	"""Settings for the Telegram delivery bot integration.

	This used to push `reporting_chat_id`/`reporting_topic_id` into the Worker's KV namespace
	(`config:reporting`) on every save, because the *Worker* owned the delivery review-chat forward
	and needed those values at the edge. As of 2026-08-05 klik_pos owns that forward itself
	(api/delivery.py's forward_delivery_to_reporting_chat_job, which reads these fields directly
	from this doc), so that push had no reader left and was removed along with the KV key.

	Note the driver cache (`drivers:approved`/`drivers:all`) is a different thing and is still
	pushed to KV - by api/driver.py's push_driver_cache, off the `Delivery Driver` doctype, not
	from here. Only the reporting-config push was retired.
	"""

	pass
