#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ext="$HOME/.local/share/gnome-shell/extensions/cloud-cost@local"
lib="$HOME/.local/libexec/gnome-cloud-cost"
units="$HOME/.config/systemd/user"

install -d "$ext" "$lib" "$units"
install -m 644 "$root/extension/extension.js" "$root/extension/metadata.json" \
    "$root/extension/stylesheet.css" "$ext/"
install -d "$lib/collector"
install -m 644 "$root/collector/"*.py "$lib/collector/"
# Replace the provider set so deleted plugins do not linger after upgrades.
rm -rf -- "$ext/providers" "$lib/providers"
for folder in "$root/providers/"*; do
    [[ -f "$folder/provider.py" && -f "$folder/icon.svg" ]] || continue
    id="${folder##*/}"
    install -d "$ext/providers/$id" "$lib/providers/$id"
    install -m 644 "$folder/icon.svg" "$ext/providers/$id/icon.svg"
    install -m 644 "$folder/provider.py" "$lib/providers/$id/provider.py"
done
install -m 644 "$root/systemd/gnome-cloud-cost.service" \
    "$root/systemd/gnome-cloud-cost.timer" "$units/"
systemctl --user daemon-reload
systemctl --user enable --now gnome-cloud-cost.timer

# GNOME Shell may not discover a newly copied local extension until the next
# session on Wayland. Enable its UUID persistently so it loads at next login.
python3 - <<'PY'
from gi.repository import Gio

settings = Gio.Settings.new('org.gnome.shell')
uuid = 'cloud-cost@local'
enabled = settings.get_strv('enabled-extensions')
if uuid not in enabled and not settings.set_strv('enabled-extensions', [*enabled, uuid]):
    raise SystemExit('Could not enable the Cloud Cost extension in GNOME settings')
PY

printf '%s\n' 'Installed: timer enabled, extension enabled in GNOME settings.' \
    'If the extension is not visible yet on Wayland, log out and back in to load it.' \
    'Check: gnome-extensions info cloud-cost@local'
