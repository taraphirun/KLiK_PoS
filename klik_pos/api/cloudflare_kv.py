"""Shared Cloudflare Workers KV REST plumbing. Two independent call sites need this, against two
*different* KV namespaces on the same Cloudflare account/token: driver.py's push_driver_cache_job
(the DRIVERS namespace: `drivers:approved`/`drivers:all`) and Phase 7's ack writes (the ACKS
namespace: `delivery:<bot_delivery_id>`/`registration:<telegram_user_id>`). Both reuse the same
Cloudflare account id + API token (ARCHITECTURE.md: "reusing the same Cloudflare API token it
already needs for the driver-cache push, so this adds no new credential") - only the namespace id
and the actual key/value differ per call.
"""

import json

import frappe
import requests

PUT_TIMEOUT = 15


def get_cloudflare_credentials():
    """(account_id, api_token) if Telegram Bot Settings is enabled and both are configured, else
    None. Deliberately excludes any specific namespace id - callers pass the namespace id they
    need (DRIVERS vs. ACKS), since those are genuinely different KV resources, not a shared secret.
    """
    settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
    if not settings.enabled:
        return None
    account_id = settings.cloudflare_account_id
    api_token = settings.get_password("cloudflare_api_token", raise_exception=False)
    if not (account_id and api_token):
        return None
    return account_id, api_token


def put_kv(namespace_id, key_name, value):
    """One KV write. Cloudflare's "Write key-value pair" endpoint: PUT .../values/:key_name,
    Bearer auth, multipart/form-data with a `value` field - not a raw JSON body (verified against
    current API docs, 2026-08-04, when this was first wired up in driver.py).

    `value` is JSON-encoded unless already a plain string - the driver-cache callers pass a list of
    dicts (needs encoding); the ack callers just need a presence marker (a plain string is enough
    and avoids a pointless JSON-decode step on a Worker-side reader that only checks `!== null`).

    Raises on any failure (missing settings, HTTP error, `success: false` in Cloudflare's response)
    rather than swallowing it - unlike the old inline version in driver.py, which logged and
    continued for its own reasons. Callers here decide what a failure means for them: a driver-cache
    push failure and an ack-write failure have very different blast radii (the former leaves the
    approval gate briefly stale; the latter just means the Worker's ledger sweep re-POSTs an
    already-successful write a bit longer than necessary, which is safe by design), so the decision
    of "log and continue" vs. anything stricter belongs at the call site, not buried in here.
    """
    creds = get_cloudflare_credentials()
    if not creds:
        raise Exception("Telegram Bot Settings is disabled or missing cloudflare_account_id/cloudflare_api_token")
    account_id, api_token = creds

    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/storage/kv/"
        f"namespaces/{namespace_id}/values/{key_name}"
    )
    encoded = value if isinstance(value, str) else json.dumps(value, default=str)
    response = requests.put(
        url,
        headers={"Authorization": f"Bearer {api_token}"},
        files={"value": (None, encoded)},
        timeout=PUT_TIMEOUT,
    )
    response.raise_for_status()
    body = response.json()
    if not body.get("success"):
        raise Exception(f"Cloudflare API returned success=false: {body.get('errors')}")


def get_acks_namespace_id():
    """None if unset - callers treat that the same as any other ack-write failure (log, don't
    block the caller's own save/response)."""
    settings = frappe.get_doc("Telegram Bot Settings", "Telegram Bot Settings")
    return settings.cloudflare_acks_namespace_id or None
