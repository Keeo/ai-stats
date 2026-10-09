#!/usr/bin/env python3
"""Discover providers, fetch balances and trailing-hour spend, publish secret-free cache."""

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

from collector.common import ProviderError, fetch_json, iso, money, publish

CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "gnome-cloud-cost"
STATUS_FILE = CACHE_DIR / "status.json"
PROVIDERS_DIR = Path(__file__).resolve().parent.parent / "providers"
PROVIDER_ID = re.compile(r"[a-z][a-z0-9_-]*\Z")


def utc_now():
    return datetime.now(timezone.utc)


def secret(provider):
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", "service", "gnome-cloud-cost", "provider", provider],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Cannot access Secret Service (is GNOME Keyring unlocked?)") from exc
    key = result.stdout.strip()
    if result.returncode != 0 or not key:
        raise RuntimeError(f"No {provider} key in GNOME Keyring")
    return key


def discover_providers(directory=PROVIDERS_DIR):
    """Yield (id, module, error) from folders containing provider.py.

    A broken plugin must not stop healthy plugins from updating. Never publish
    import exceptions: third-party code can include secrets in error messages.
    """
    if not directory.is_dir():
        return
    for folder in sorted(directory.iterdir()):
        if not folder.is_dir() or not PROVIDER_ID.fullmatch(folder.name):
            continue
        source = folder / "provider.py"
        if not source.is_file():
            continue
        try:
            if not (folder / "icon.svg").is_file():
                raise ValueError("Missing icon")
            spec = importlib.util.spec_from_file_location(f"cloud_cost_provider_{folder.name}", source)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if not isinstance(module.NAME, str) or not module.NAME.strip():
                raise ValueError("Invalid provider name")
            if not callable(module.balance) or not callable(module.spend):
                raise ValueError("Missing provider functions")
            if hasattr(module, "estimate_spend") and not callable(module.estimate_spend):
                raise ValueError("Invalid estimate_spend")
        except Exception:
            yield folder.name, None, "Provider plugin unavailable"
        else:
            yield folder.name, module, None


def error_message(exc):
    # A third-party plugin may put credentials in an exception message.
    return str(exc) if isinstance(exc, ProviderError) else "Unexpected provider response"


def collect(now=None, lookup=secret, fetch=fetch_json, cache_dir=CACHE_DIR,
            providers_dir=PROVIDERS_DIR):
    now = now or utc_now()
    status = {"updated_at": iso(now), "providers": {}}
    for provider, module, plugin_error in discover_providers(providers_dir):
        result = {"name": module.NAME if module else provider, "configured": False,
                  "balance": None, "last_hour_spend": None,
                  "balance_error": None, "spend_error": None,
                  "spend_source": None, "spend_note": None}
        if plugin_error:
            result["balance_error"] = result["spend_error"] = plugin_error
            status["providers"][provider] = result
            continue
        try:
            key = lookup(provider)
        except RuntimeError as exc:
            result["balance_error"] = result["spend_error"] = str(exc)
        else:
            result["configured"] = True
            balance = None
            try:
                balance = money(module.balance(key, fetch))
                result["balance"] = str(balance)
            except Exception as exc:
                result["balance_error"] = error_message(exc)
            estimate = None
            if balance is not None and hasattr(module, "estimate_spend"):
                try:
                    estimate = module.estimate_spend(now, balance, cache_dir)
                    if estimate is not None:
                        estimate = money(estimate)
                except Exception:
                    pass  # Billing can still work if local history cannot be written.
            try:
                value = money(module.spend(key, now, fetch))
                result["last_hour_spend"] = str(value)
                result["spend_source"] = "billing"
            except Exception as exc:
                if estimate is not None:
                    result["last_hour_spend"] = str(estimate)
                    result["spend_source"] = "balance_estimate"
                    result["spend_note"] = getattr(module, "ESTIMATE_NOTE", "Estimate from balance changes")
                elif balance is not None and hasattr(module, "estimate_spend"):
                    result["spend_error"] = getattr(module, "PENDING_NOTE", "Billing unavailable; collecting balance history")
                else:
                    result["spend_error"] = error_message(exc)
        status["providers"][provider] = result
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print", action="store_true", help="print cached values (never keys)")
    args = parser.parse_args()
    status = collect()
    publish(status, STATUS_FILE)
    if args.print:
        print(json.dumps(status, indent=2))


if __name__ == "__main__":
    main()
