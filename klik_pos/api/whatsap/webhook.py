"""Webhook."""

import hashlib
import hmac
import json

import frappe
import requests
from werkzeug.wrappers import Response


# Will check on this later just Incase we want to receive messaged from customers: Mania
@frappe.whitelist(allow_guest=True)
def webhook():
	"""Meta webhook."""
	if frappe.request.method == "GET":
		return get()
	return post()


def get():
	"""Get."""
	hub_challenge = frappe.form_dict.get("hub.challenge")
	# Read from the doctype this app actually ships ("WhatsApp Setup"); the old lookup used a
	# non-existent "WhatsApp Settings" doctype, so get_single_value returned None and a caller
	# omitting hub.verify_token matched None == None and passed. Also reject an unconfigured
	# (empty) token instead of treating it as a valid match. (Audit 2026-08-18, finding F2.)
	webhook_verify_token = frappe.db.get_single_value("WhatsApp Setup", "webhook_verify_token")
	provided = frappe.form_dict.get("hub.verify_token")

	if not webhook_verify_token or provided != webhook_verify_token:
		frappe.throw("Verify token does not match")

	return Response(hub_challenge, status=200)


def _verify_meta_signature():
	"""Authenticate an inbound POST as genuinely from Meta by validating the
	X-Hub-Signature-256 HMAC over the raw request body. The webhook previously inserted
	documents (ignore_permissions) from any unauthenticated caller with no signature check
	at all. (Audit 2026-08-18, finding F1.)

	The HMAC key is Meta's App Secret, held in site config as `whatsapp_app_secret` (not in
	the WhatsApp Setup doctype, which has no such field). This webhook is opt-in / speculative,
	so if no secret is configured we fail closed rather than accept forgeable payloads.
	"""
	app_secret = frappe.conf.get("whatsapp_app_secret")
	if not app_secret:
		frappe.throw("WhatsApp webhook secret is not configured", frappe.PermissionError)

	signature = frappe.get_request_header("X-Hub-Signature-256") or ""
	body = frappe.request.get_data() or b""
	expected = "sha256=" + hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
	if not hmac.compare_digest(expected, signature):
		frappe.throw("Invalid webhook signature", frappe.PermissionError)


def post():
	"""Post."""
	_verify_meta_signature()
	data = frappe.local.form_dict
	# frappe.get_doc({
	# 	"doctype": "WhatsApp Notification Log",
	# 	"template": "Webhook",
	# 	"meta_data": json.dumps(data)
	# }).insert(ignore_permissions=True)

	messages = []
	try:
		messages = data["entry"][0]["changes"][0]["value"].get("messages", [])
	except KeyError:
		messages = data["entry"]["changes"][0]["value"].get("messages", [])
	sender_profile_name = next(
		(
			contact.get("profile", {}).get("name")
			for entry in data.get("entry", [])
			for change in entry.get("changes", [])
			for contact in change.get("value", {}).get("contacts", [])
		),
		None,
	)

	if messages:
		for message in messages:
			message_type = message["type"]
			is_reply = True if message.get("context") and "forwarded" not in message.get("context") else False
			reply_to_message_id = message["context"]["id"] if is_reply else None
			if message_type == "text":
				frappe.get_doc(
					{
						"doctype": "WhatsApp Chat",
						"type": "Incoming",
						"from": message["from"],
						"message": message["text"]["body"],
						"message_id": message["id"],
						"reply_to_message_id": reply_to_message_id,
						"is_reply": is_reply,
						"content_type": message_type,
						"profile_name": sender_profile_name,
					}
				).insert(ignore_permissions=True)
			elif message_type == "reaction":
				frappe.get_doc(
					{
						"doctype": "WhatsApp Chat",
						"type": "Incoming",
						"from": message["from"],
						"message": message["reaction"]["emoji"],
						"reply_to_message_id": message["reaction"]["message_id"],
						"message_id": message["id"],
						"content_type": "reaction",
						"profile_name": sender_profile_name,
					}
				).insert(ignore_permissions=True)
			elif message_type == "interactive":
				frappe.get_doc(
					{
						"doctype": "WhatsApp Chat",
						"type": "Incoming",
						"from": message["from"],
						"message": message["interactive"]["nfm_reply"]["response_json"],
						"message_id": message["id"],
						"content_type": "flow",
						"profile_name": sender_profile_name,
					}
				).insert(ignore_permissions=True)
			elif message_type in ["image", "audio", "video", "document"]:
				settings = frappe.get_doc(
					"WhatsApp Settings",
					"WhatsApp Setup",
				)
				token = settings.get_password("token")
				url = f"{settings.url}/{settings.version}/"

				media_id = message[message_type]["id"]
				headers = {"Authorization": "Bearer " + token}
				response = requests.get(f"{url}{media_id}/", headers=headers)

				if response.status_code == 200:
					media_data = response.json()
					media_url = media_data.get("url")
					mime_type = media_data.get("mime_type")
					file_extension = mime_type.split("/")[1]

					media_response = requests.get(media_url, headers=headers)
					if media_response.status_code == 200:
						file_data = media_response.content
						file_name = f"{frappe.generate_hash(length=10)}.{file_extension}"

						message_doc = frappe.get_doc(
							{
								"doctype": "WhatsApp Chat",
								"type": "Incoming",
								"from": message["from"],
								"message_id": message["id"],
								"reply_to_message_id": reply_to_message_id,
								"is_reply": is_reply,
								"message": message[message_type].get("caption", f"/files/{file_name}"),
								"content_type": message_type,
								"profile_name": sender_profile_name,
							}
						).insert(ignore_permissions=True)

						file = frappe.get_doc(
							{
								"doctype": "File",
								"file_name": file_name,
								"attached_to_doctype": "WhatsApp Chat",
								"attached_to_name": message_doc.name,
								"content": file_data,
								"attached_to_field": "attach",
							}
						).save(ignore_permissions=True)

						message_doc.attach = file.file_url
						message_doc.save()
			elif message_type == "button":
				frappe.get_doc(
					{
						"doctype": "WhatsApp Chat",
						"type": "Incoming",
						"from": message["from"],
						"message": message["button"]["text"],
						"message_id": message["id"],
						"reply_to_message_id": reply_to_message_id,
						"is_reply": is_reply,
						"content_type": message_type,
						"profile_name": sender_profile_name,
					}
				).insert(ignore_permissions=True)
			else:
				frappe.get_doc(
					{
						"doctype": "WhatsApp Chat",
						"type": "Incoming",
						"from": message["from"],
						"message_id": message["id"],
						"message": message[message_type].get(message_type),
						"content_type": message_type,
						"profile_name": sender_profile_name,
					}
				).insert(ignore_permissions=True)

	else:
		changes = None
		try:
			changes = data["entry"][0]["changes"][0]
		except KeyError:
			changes = data["entry"]["changes"][0]
		update_status(changes)
	return


def update_status(data):
	"""Update status hook."""
	if data.get("field") == "message_template_status_update":
		update_template_status(data["value"])

	elif data.get("field") == "messages":
		update_message_status(data["value"])


def update_template_status(data):
	"""Update template status."""
	frappe.db.sql(
		"""UPDATE `tabWhatsApp Message Templates`
		SET status = %(event)s
		WHERE id = %(message_template_id)s""",
		data,
	)


# UPdate
def update_message_status(data):
	"""Update message status."""
	id = data["statuses"][0]["id"]
	status = data["statuses"][0]["status"]
	conversation = data["statuses"][0].get("conversation", {}).get("id")
	name = frappe.db.get_value("WhatsApp Chat", filters={"message_id": id})

	doc = frappe.get_doc("WhatsApp Chat", name)
	doc.status = status
	if conversation:
		doc.conversation_id = conversation
	doc.save(ignore_permissions=True)
