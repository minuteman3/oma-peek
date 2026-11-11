#!/bin/bash
# Remove what install.sh put in place. Installed as ~/.local/share/oma-peek/uninstall.sh,
# so it still works after the Omarchy plugin itself has been removed. Takes the same lock as
# install.sh, so it never removes files an install is writing.
set -euo pipefail
data="${XDG_DATA_HOME:-$HOME/.local/share}"
lock="${XDG_STATE_HOME:-$HOME/.local/state}/oma-peek/install.lock"
mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -w 300 9 || { echo "oma-peek: timed out waiting for an install to finish" >&2; exit 1; }
rm -f "$data/thumbnailers/oma-peek.thumbnailer" "$data/sushi/plugins-1/oma-peek.js" \
    "$data/sushi/viewers/oma-peek.js"
rm -rf "$data/oma-peek" "$data/oma-peek.new" "$data/oma-peek.old" "${XDG_CACHE_HOME:-$HOME/.cache}/oma-peek" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/strata/actions/oma-peek"
pkill -f '^/usr/bin/gjs( -m)? /usr/lib/org\.gnome\.NautilusPreviewer( |$)' 2>/dev/null || true
echo "oma-peek removed (run 'nautilus -q' so Nautilus forgets the thumbnailer)"
