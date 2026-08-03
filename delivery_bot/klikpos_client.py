"""Shared KlikPOS (Frappe) HTTP client config, used by sync_worker.py (delivery sync, Todo 034)
and driver_sync.py (driver sync, Phase 10 addendum). Just config + small helpers - each caller
still builds and sends its own requests with its own httpx.AsyncClient, since call patterns
(multipart uploads vs plain JSON, batch vs single) differ enough that a shared request wrapper
would just be indirection.
"""

from __future__ import annotations

import os

BASE_URL = os.getenv("KLIKPOS_BASE_URL", "").rstrip("/")
API_KEY = os.getenv("KLIKPOS_API_KEY", "")
API_SECRET = os.getenv("KLIKPOS_API_SECRET", "")


def is_configured() -> bool:
    return bool(BASE_URL and API_KEY)


def headers() -> dict[str, str]:
    return {"Authorization": f"token {API_KEY}:{API_SECRET}"}


def method_url(method_path: str) -> str:
    return f"{BASE_URL}/api/method/{method_path}"
