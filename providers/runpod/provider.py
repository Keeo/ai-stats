"""RunPod billing, with a balance-history estimate if minutely billing fails."""

from datetime import timedelta
from decimal import Decimal
import json

from collector.common import ProviderError, iso, money, parse_utc, publish

NAME = "RunPod"
ESTIMATE_NOTE = "Estimate from balance changes; small refills may be missed"
PENDING_NOTE = "RunPod billing unavailable; collecting ~1h of balance history"
AMOUNTS = (
    "gpuCloudAmount", "cpuCloudAmount", "serverlessAmount",
    "storageAmount", "runpodEndpointAmount",
)


def query(key, graphql, fetch):
    response = fetch("https://api.runpod.io/graphql", key, {"query": graphql})
    if response.get("errors"):
        # GraphQL error text can contain user-provided data. Keep cache generic.
        raise ProviderError("RunPod GraphQL query rejected")
    return response["data"]["myself"]


def balance(key, fetch):
    obj = query(key, "query { myself { clientBalance } }", fetch)
    return money(obj["clientBalance"])


def spend(key, now, fetch):
    graphql = "query { myself { billing(input: {granularity: MINUTELY}) { summary { time gpuCloudAmount cpuCloudAmount serverlessAmount storageAmount runpodEndpointAmount } } } }"
    rows = query(key, graphql, fetch)["billing"]["summary"]
    if not isinstance(rows, list):
        raise ProviderError("RunPod billing summary unavailable")
    start = now - timedelta(hours=1)
    total = Decimal(0)
    for row in rows:
        timestamp = parse_utc(row["time"])
        if start <= timestamp <= now:
            total += sum((money(row.get(field) or 0) for field in AMOUNTS), Decimal(0))
    return total


def record_balance(now, amount, destination):
    """Return approximate trailing-hour balance delta, or None until covered.

    A detected increase invalidates the entire window. Small refills masked
    by charges between samples cannot be detected.
    """
    try:
        samples = json.loads(destination.read_text(encoding="utf-8"))
        if not isinstance(samples, list):
            raise ValueError("Invalid sample history")
        samples = [(parse_utc(row["time"]), money(row["balance"])) for row in samples]
    except (OSError, ValueError, KeyError, TypeError):
        samples = []
    samples = [(time, value) for time, value in samples
               if now - timedelta(hours=2) <= time <= now]
    if samples and (now <= samples[-1][0] or amount > samples[-1][1] + Decimal("0.01")):
        samples = []  # Clock moved backwards or credits were added.
    samples.append((now, amount))
    publish([{"time": iso(time), "balance": str(value)} for time, value in samples],
            destination)
    target = now - timedelta(hours=1)
    nearest = min(samples, key=lambda row: abs((row[0] - target).total_seconds()))
    if abs((nearest[0] - target).total_seconds()) > 240:
        return None
    return max(Decimal(0), nearest[1] - amount)


def estimate_spend(now, balance, cache_dir):
    """Called on each successful balance poll, even when billing is available."""
    return record_balance(now, balance, cache_dir / "runpod-samples.json")
