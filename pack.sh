#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$root/dist}"
mkdir -p "$out"
gnome-extensions pack --force --out-dir="$out" \
    --extra-source="$root/extension/collector.js" \
    --extra-source="$root/extension/collector-core.js" \
    --extra-source="$root/extension/icons" \
    --extra-source="$root/LICENSE" \
    "$root/extension"
zip="$out/cloud-cost@keeo.github.io.shell-extension.zip"
for file in metadata.json extension.js stylesheet.css collector.js collector-core.js \
    icons/openrouter.svg icons/runpod.svg LICENSE; do
    unzip -Z1 "$zip" | grep -Fxq "$file" || { echo "Missing from ZIP: $file" >&2; exit 1; }
done
printf 'Ready: %s\n' "$zip"
