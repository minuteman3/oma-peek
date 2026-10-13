#!/bin/bash
# Remove what install.sh put in place. Installed as ~/.local/share/oma-peek/uninstall.sh,
# so it still works after the Omarchy plugin itself has been removed.
set -euo pipefail
data="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -f "$data/thumbnailers/oma-peek.thumbnailer" "$data/sushi/viewers/oma-peek.js"
rm -rf "$data/oma-peek" "${XDG_CACHE_HOME:-$HOME/.cache}/oma-peek" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/strata/actions/oma-peek"
pkill -f '^/usr/bin/gjs /usr/lib/org.gnome.NautilusPreviewer' 2>/dev/null || true
echo "oma-peek removed (run 'nautilus -q' so Nautilus forgets the thumbnailer)"
