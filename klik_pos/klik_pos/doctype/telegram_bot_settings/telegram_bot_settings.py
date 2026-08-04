# Copyright (c) 2026, Beveren Sooftware Inc and contributors
# For license information, please see license.txt

import json

import frappe
import requests
from frappe.model.document import Document
from frappe.utils import cint


class TelegramBotSettings(Document):
	def on_update(self):
		"""Pushes reporting_chat_id/reporting_topic_id into the same KV namespace used for the
		driver cache (`config:reporting` key), so the Worker never has to call klik_pos live for a
		value that changes about as rarely as the KV namespace id itself - same push-not-poll
		pattern as driver.py's push_driver_cache, just simpler (no has_value_changed guard: this
		whole doctype is a handful of rarely-touched settings, not a delivery-driver list with
		routine, frequent saves, so there's no meaningful "unrelated save" case to filter out).

		Only *decides and enqueues* here, synchronously inside the save transaction - same
		reasoning as push_driver_cache: a Cloudflare outage or bad token must never block or roll
		back a Settings save, and the enqueue call itself is try/excepted for the same reason.
		"""
		try:
			frappe.enqueue(
				"klik_pos.klik_pos.doctype.telegram_bot_settings.telegram_bot_settings.push_reporting_config_job",
				queue="short",
				enqueue_after_commit=True,
			)
		except Exception:
			frappe.log_error(title="Failed to enqueue reporting-config push")


def push_reporting_config_job():
	"""Background job (runs post-commit). Full replace of the single `config:reporting` KV key -
	`{"chat_id": ..., "topic_id": ...}`, or a delete if reporting_chat_id was cleared (the Worker
	reads a missing key as "forwarding disabled", src/klikpos/config.ts - same fail-closed shape
	as the driver cache).
	"""
	settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
	if not settings.enabled:
		return

	account_id = settings.cloudflare_account_id
	namespace_id = settings.cloudflare_kv_namespace_id
	api_token = settings.get_password("cloudflare_api_token")
	if not (account_id and namespace_id and api_token):
		return

	url = (
		f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/"
		f"namespaces/{namespace_id}/values/config:reporting"
	)

	if not settings.reporting_chat_id:
		try:
			response = requests.delete(url, headers={"Authorization": f"Bearer {api_token}"}, timeout=15)
			response.raise_for_status()
		except Exception:
			frappe.log_error(title="Reporting-config KV delete failed")
		return

	# reporting_topic_id is a Frappe Data field (always a string, e.g. "671") but Telegram's
	# message_thread_id Bot API parameter is an Integer - found live (2026-08-04): pushing the raw
	# string landed in KV as JSON `"671"`, which the Worker's ReportingConfig type declares as
	# `number | null`. cint() here is what actually makes that type honest.
	payload = {
		"chat_id": settings.reporting_chat_id,
		"topic_id": cint(settings.reporting_topic_id) if settings.reporting_topic_id else None,
	}
	try:
		response = requests.put(
			url,
			headers={"Authorization": f"Bearer {api_token}"},
			files={"value": (None, json.dumps(payload))},
			timeout=15,
		)
		response.raise_for_status()
		body = response.json()
		if not body.get("success"):
			raise Exception(f"Cloudflare API returned success=false: {body.get('errors')}")
	except Exception:
		frappe.log_error(title="Reporting-config push to Cloudflare KV failed")
