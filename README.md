# Cloud Cost for GNOME

See your OpenRouter and RunPod credit and spending over the last hour from the GNOME top bar.

![GNOME top bar showing provider credit and trailing-hour spend](image.png)

Minimal GNOME Shell 50 top-bar indicator: **provider mark + credit · trailing-hour spend** for each installed provider (initially OpenRouter and RunPod). Click for provider details, errors and data age. Each credit is floored to a whole dollar and each trailing-hour spend is rounded **up** to the first decimal (`$0.9/h` means *spent in the last hour*, not a projected instantaneous hourly rate). Top-bar spend (and its middle dot) is hidden when the last-hour amount is below $0.001; unknown or stale values instead show `-`, never a misleading zero. The dropdown still shows the provider's spending status. Spend over $1 turns orange; spend over 5% of that provider's current credit turns red (red takes priority). The subtle, monochrome SVG marks are cropped from each provider's official logo.

## Install

Requires GNOME Shell 50, Python 3 (with GNOME's `python3-gi` bindings for the installer), `secret-tool` (libsecret / GNOME Keyring), and a systemd user session. The collector itself needs no third-party Python packages.

```sh
bash ./install.sh
```

Add keys to GNOME Keyring **interactively** (do not put keys on a command line, in shell history, or in a tracked file):

```sh
secret-tool store --label='Cloud Cost: OpenRouter' service gnome-cloud-cost provider openrouter
secret-tool store --label='Cloud Cost: RunPod' service gnome-cloud-cost provider runpod
```

`secret-tool store` reads the secret from its prompt/stdin. Use an [OpenRouter management key](https://openrouter.ai/settings/management-keys), not a regular inference key: the credits and analytics APIs require it. Create a RunPod API key in your RunPod account. Either provider can be omitted.

Fetch data immediately and inspect the **secret-free** result:

```sh
systemctl --user start gnome-cloud-cost.service
python3 -m collector.cloud_cost --print
```

`install.sh` enables the timer and persists the extension UUID in GNOME's `enabled-extensions` setting. **Log out and back in once** to load a newly installed extension on Wayland; it should then appear in the top bar and remain enabled across logins. Check with `gnome-extensions info cloud-cost@local`; if it reports `State: DISABLED`, run `gnome-extensions enable cloud-cost@local`. After changing extension code, rerun `bash ./install.sh`. GNOME caches loaded JavaScript modules: disabling/re-enabling alone will not pick up new code. To update **without closing your apps**, run `bash ./preview.sh` and paste its one-line command into GNOME Looking Glass (`Alt+F2`, `lg`, Enter, paste into Evaluator, Enter). This uses GNOME Shell 50's internal reload API; the preview path is temporary, while the installed code loads normally next login.

The timer refreshes every three minutes; the indicator reads the cached data every 30 seconds. Data older than ten minutes is clearly marked **stale**. Provider failures are shown in the dropdown instead of being treated as zero. The cache is `$XDG_CACHE_HOME/gnome-cloud-cost/` (normally `~/.cache/gnome-cloud-cost/`): `status.json` plus RunPod's balance history in `runpod-samples.json`. Both are private and contain **no API keys**.

## What is measured

- **OpenRouter:** `GET /api/v1/credits` → purchased credits minus cumulative usage; `POST /api/v1/analytics/query` → sum `total_usage` **minute buckets** for `[now − 60 minutes, now]`. Specifying `granularity: minute` is essential: without it, OpenRouter aggregates the whole UTC day even when given hour/minute timestamps. Truncated analytics responses are rejected. The daily `/activity` endpoint cannot answer a trailing-hour question.
- **RunPod:** GraphQL `myself.clientBalance` for credit; `myself.billing(input: {granularity: MINUTELY}).summary` for spend, summing GPU, CPU, serverless, storage and endpoint charges with timestamps in the trailing hour. If minutely billing is unavailable, the fallback keeps balance snapshots every three minutes. After about an hour, it displays **≈ spend** calculated from the balance change; until then, it displays `-`. A detected credit top-up or clock reset clears the history and starts a new hour. Smaller refills hidden by charges between polls cannot be detected, so this is explicitly an *estimate*, not a billing statement.

Provider billing data may arrive late, so these are the latest **reported** charges, not a hard real-time cap. The RunPod billing schema does not offer a time-range filter; the collector requests the summary and filters its timestamps locally. When falling back to balance snapshots, coverage is within about four minutes of an hour and may be distorted by undetected refills or account adjustments. All amounts are USD; totals add *available credit* across configured providers, not cash in a bank account.

**Security:** The collector reads credentials from GNOME Keyring; the Shell extension never receives them. OpenRouter management keys and RunPod API keys may have powerful account permissions. Keep the workstation/keyring secure, rotate keys if compromised, and avoid committing the cache or collector logs containing account data.

## Adding a provider

Create `providers/<id>/provider.py` and `providers/<id>/icon.svg` (a symbolic SVG). The ID must match `[a-z][a-z0-9_-]*` and is also the `secret-tool` provider attribute and the status JSON key. The Python module exports:

```python
NAME = "Example"                 # label in the menu

def balance(key, fetch):          # return USD balance (Decimal, number or numeric string)
    return fetch("https://example.com/balance", key)["balance"]

def spend(key, now, fetch):       # return USD spent in [now - 1h, now]
    return fetch("https://example.com/spend", key)["spent"]
```

`fetch(url, key, payload=None)` makes authenticated JSON requests (POST when payload is provided); `now` is a timezone-aware UTC datetime. For exact decimal arithmetic and timestamp formatting, use `money`, `iso`, or `parse_utc` from `collector.common`. Raise `collector.common.ProviderError` with a **safe, constant** message for errors that should appear in the menu; other provider exceptions become a generic error. If billing can fail, optionally export `estimate_spend(now, balance, cache_dir)` to record balance samples **on every successful balance poll**, returning a USD estimate or `None` until enough history exists. Optionally set `ESTIMATE_NOTE` and `PENDING_NOTE` strings for the menu. The collector runs each provider independently, loads credentials from Keyring, and writes the secret-free result; Shell discovers providers from that result and loads their icons from `extension/providers/<id>/icon.svg` in the installed extension. Never include keys or raw response bodies in error messages. Provider modules are trusted local code with access to the provider's key.

Run `bash ./install.sh` after adding/removing a folder, store its key with `secret-tool store --label='Cloud Cost: Example' service gnome-cloud-cost provider <id>`, and start the collector with `systemctl --user start gnome-cloud-cost.service`. The indicator will update on its next refresh (within 30 seconds); `preview.sh` is only needed to reload **changed JavaScript**. Deleting a folder and reinstalling removes the installed provider; the next collector run removes it from the cache and panel.

## Development and troubleshooting

Read the last cached values without contacting providers (`-` means unknown):

```sh
jq -r '.providers | to_entries[] | "\(.key): credit=\(.value.balance // "-")  1h=\(.value.last_hour_spend // "-")  issue=\(.value.spend_error // .value.balance_error // "-")"' \
  ~/.cache/gnome-cloud-cost/status.json
```

If `jq` is not installed, use `python3 -m json.tool ~/.cache/gnome-cloud-cost/status.json` instead. Refresh immediately with `systemctl --user start gnome-cloud-cost.service`, or run `python3 -m collector.cloud_cost --print` from this repository to fetch and print the full secret-free status. `journalctl` shows service execution, not balances or detailed API errors; those are in the cache.

```sh
python3 -m unittest discover -s tests -v
node --check extension/extension.js
# Packaging manually? Include providers/<id>/icon.svg in the extension package.
journalctl --user -u gnome-cloud-cost.service -n 30
systemctl --user status gnome-cloud-cost.timer
```

The collector is `collector/cloud_cost.py`; provider-specific fetches are independent, so a failed provider or missing key won't prevent the other one from updating. The top bar only reads the JSON cache and never performs network calls. To remove the installation: disable the extension, run `systemctl --user disable --now gnome-cloud-cost.timer`, remove the copied extension, collector and systemd units, and optionally clear keys with `secret-tool clear service gnome-cloud-cost provider openrouter` (similarly for `runpod`).

API references: [OpenRouter credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits), [analytics query](https://openrouter.ai/docs/api/api-reference/analytics/query-analytics-data), [RunPod GraphQL schema](https://graphql-spec.runpod.io/).
