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

OpenRouter requires a [management key](https://openrouter.ai/settings/management-keys), not an inference key. Configure either or both providers; missing keys are shown in the menu. Updates arrive within three minutes.

The bundled collector runs in a separate GJS process so API keys never enter GNOME Shell. It writes a private, key-free cache at `~/.cache/gnome-cloud-cost/`. Unavailable or stale values show `-`, not zero. If RunPod billing is unavailable, spending may show **≈** after an hour of balance samples; this is only an estimate.

Development: `gjs -m tests/test_collector.js` runs the collector tests. Source is [GPL-3.0-or-later](LICENSE). GitHub Actions builds the ZIP on PRs and pushes; `v*` tags attach it to a GitHub Release. Publishing to extensions.gnome.org is separate.
