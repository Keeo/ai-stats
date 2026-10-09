"""Shared provider helpers. No credentials are persisted or included in errors."""

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import os
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class ProviderError(ValueError):
    """A deliberately safe, user-visible error message (never include secrets)."""


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def money(value):
    """Preserve decimal precision in JSON; reject missing/non-finite amounts."""
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("Missing or invalid monetary amount") from exc
    if not amount.is_finite():
        raise ValueError("Non-finite monetary amount")
    return amount


def parse_utc(timestamp):
    dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("Billing timestamp has no time zone")
    return dt.astimezone(timezone.utc)


def publish(status, destination):
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(destination.parent, 0o700)
    fd, name = tempfile.mkstemp(prefix=".status-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(status, file, separators=(",", ":"))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def fetch_json(url, key, payload=None):
    # RunPod's Cloudflare rejects urllib's default Python-urllib User-Agent (1010).
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json",
               "User-Agent": "CloudCost/0.1"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, headers=headers)
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as exc:
        # Do not print response bodies, headers, or secrets to the journal/cache.
        raise ProviderError(f"HTTP {exc.code} from provider") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ProviderError("Provider request failed (network or timeout)") from exc
    except (ValueError, UnicodeError) as exc:
        raise ProviderError("Provider returned invalid JSON") from exc
