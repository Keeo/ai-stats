# Cloud Cost for GNOME

A GNOME Shell 50 top-bar extension showing **OpenRouter** and **RunPod** credit and spending over the last hour. Click the indicator for details and errors.

![Cloud Cost indicator in the GNOME top bar](image.png)

## Install

Download the ZIP from [GitHub Releases](https://github.com/Keeo/gnome-ai-cloud-cost/releases) or a [GitHub Actions](https://github.com/Keeo/gnome-ai-cloud-cost/actions) build. To build it yourself, run `bash ./pack.sh`; the ZIP will be in `dist/`.

```sh
gnome-extensions install dist/cloud-cost@keeo.github.io.shell-extension.zip
gnome-extensions enable cloud-cost@keeo.github.io
```

On Wayland, log out and back in if GNOME does not discover the new extension. Requires GNOME Shell 50, GJS with Secret 1 and Soup 3 typelibs, and GNOME Keyring (or another Secret Service).

## Add API keys

Run these commands **interactively**; `secret-tool` prompts for each key. Do not put keys on the command line or in tracked files.

```sh
secret-tool store --label='Cloud Cost: OpenRouter' service gnome-cloud-cost provider openrouter
secret-tool store --label='Cloud Cost: RunPod' service gnome-cloud-cost provider runpod
```

OpenRouter requires a [management key](https://openrouter.ai/settings/management-keys), not an inference key. Configure either or both providers; providers without keys are hidden. If neither is configured, the indicator shows “Cloud Cost” with setup instructions in its menu. Updates arrive within three minutes.

The bundled collector runs in a separate GJS process so API keys never enter GNOME Shell. It writes a private, key-free cache at `~/.cache/gnome-cloud-cost/`. Unavailable or stale values show `-`, not zero. If RunPod billing is unavailable, spending may show **≈** after an hour of balance samples; this is only an estimate.

## Add a provider

Create `extension/providers/<id>/` (lowercase letter followed by lowercase letters, digits, `_` or `-`) containing:

- `icon-symbolic.svg`: the top-bar icon. Use a GNOME symbolic SVG (for example, strokes and fills in `#2e3436`) so Shell recolors it for light and dark panels.
- `provider.js`: an ES module exporting `name` (display name), `balance(key, fetch)` (remaining credit in USD), and `spend(key, now, fetch)` (USD spent during the preceding hour). `now` is a `Date`; `fetch(url, key, payload?)` returns parsed JSON and uses POST when given a payload. See the existing folders for examples. Optionally export `estimateFromBalance = true` to fall back to an hour of balance samples when billing fails.

Store its key with `secret-tool store --label='Cloud Cost: <name>' service gnome-cloud-cost provider <id>` (run interactively), then run `bash ./pack.sh` and reinstall the ZIP. The collector discovers valid provider folders and publishes their results; the panel builds its rows and loads each folder's icon from the collector's key-free status. Neither collector nor panel nor pack script needs a per-provider edit. Avoid including keys or raw API responses in errors; unexpected errors are hidden from the status cache.

Development: `gjs -m tests/test_collector.js` runs the collector tests. Source is [GPL-3.0-or-later](LICENSE). GitHub Actions builds the ZIP on PRs and pushes; `v*` tags attach it to a GitHub Release. Publishing to extensions.gnome.org is separate.
