#!/usr/bin/env bash
# Prepare a fresh import path to reload modified GNOME Shell JavaScript without
# logging out. Paste the printed command into Alt+F2 → lg → Evaluator.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid='cloud-cost@local'
preview="$HOME/.cache/gnome-cloud-cost/shell-preview/$(date +%s)-$$/$uuid"
install -d -m 700 "$preview"
install -m 644 "$root/extension/extension.js" "$root/extension/metadata.json" \
    "$root/extension/stylesheet.css" "$preview/"
for folder in "$root/providers/"*; do
    [[ -f "$folder/provider.py" && -f "$folder/icon.svg" ]] || continue
    id="${folder##*/}"
    install -d "$preview/providers/$id"
    install -m 644 "$folder/icon.svg" "$preview/providers/$id/icon.svg"
done

python3 - "$preview" <<'PY'
import json
import sys

path = json.dumps(sys.argv[1])
print("const m=Main.extensionManager,u='cloud-cost@local',e=m.lookup(u); "
      f"e.dir=Gio.File.new_for_path({path}); "
      'await m.reloadExtension(e); m.lookup(u).state')
PY
