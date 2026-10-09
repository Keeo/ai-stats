"""OpenRouter credit and minute-bucket trailing-hour analytics."""

from datetime import timedelta
from decimal import Decimal

from collector.common import ProviderError, iso, money

NAME = "OpenRouter"


def balance(key, fetch):
    obj = fetch("https://openrouter.ai/api/v1/credits", key)["data"]
    return money(obj["total_credits"]) - money(obj["total_usage"])


def spend(key, now, fetch):
    obj = fetch("https://openrouter.ai/api/v1/analytics/query", key, {
        "metrics": ["total_usage"],
        # Without granularity OpenRouter aggregates entire UTC dates, even if
        # time_range contains hour/minute timestamps. Sum minute buckets instead.
        "granularity": "minute",
        "time_range": {"start": iso(now - timedelta(hours=1)), "end": iso(now)},
    })["data"]
    if obj["metadata"]["truncated"] or obj.get("warnings"):
        raise ProviderError("OpenRouter analytics response is incomplete")
    rows = obj["data"]
    if not isinstance(rows, list):
        raise ProviderError("OpenRouter analytics rows missing")
    return sum((money(row["total_usage"]) for row in rows), Decimal(0))
