#!/bin/bash
# Remove what install.sh put in place. Installed as ~/.local/share/oma-peek/uninstall.sh,
# so it still works after the Omarchy plugin itself has been removed. Takes the same lock as
# install.sh, so it never removes files an install is writing.
#
#   uninstall.sh                         remove everything
#   uninstall.sh --if-inactive [--after N]
#       wait N seconds, then remove only if this is an Omarchy-managed install whose plugin
#       is no longer active. Run by the plugin's service whenever the shell drops it (disable,
#       remove, but also shell restart), so the decision comes from Omarchy's saved state:
#         plugin folder gone, or shell.json lists it nowhere / in disabledPlugins  -> remove
#         still enabled                                                            -> keep
#         shell.json missing or unreadable                                         -> keep
#         manual install (no record from install.sh --managed)                     -> keep
#       The state is read under the install lock, so a re-enable racing with it wins.
#   uninstall.sh --service-stopped
#       what the Omarchy plugin runs when the shell drops it: --if-inactive --after 3.
set -euo pipefail
data="${XDG_DATA_HOME:-$HOME/.local/share}"
lock="${XDG_STATE_HOME:-$HOME/.local/state}/oma-peek/install.lock"

if_inactive=0 after=0
while (($#)); do
    case "$1" in
    --if-inactive) if_inactive=1 ;;
    --service-stopped) if_inactive=1 after=3 ;;
    --after) after="$2"; shift ;;
    *) echo "usage: uninstall.sh [--service-stopped | --if-inactive [--after SECONDS]]" >&2; exit 2 ;;
    esac
    shift
done
((after > 0)) && sleep "$after"

mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -w 300 9 || { echo "oma-peek: timed out waiting for an install to finish" >&2; exit 1; }

if ((if_inactive)); then
    state="$(python3 -I - "$data/oma-peek/.managed" <<'PY'
import json, os, sys
try:
    record = json.load(open(sys.argv[1]))
except FileNotFoundError:
    print('manual'); sys.exit()
except ValueError:
    print('unknown'); sys.exit()
plugin_id = record.get('plugin_id')
if not os.path.isdir(record.get('plugin_dir', '')):
    print('inactive'); sys.exit()
try:
    config = json.load(open(record['shell_config']))
except (OSError, ValueError, KeyError):
    print('unknown'); sys.exit()
if not isinstance(config, dict):
    print('unknown'); sys.exit()
entries = config.get('plugins') if isinstance(config.get('plugins'), list) else []
listed = any((e.get('id') if isinstance(e, dict) else e) == plugin_id for e in entries)
disabled = plugin_id in (config.get('disabledPlugins') or [])
print('active' if listed and not disabled else 'inactive')
PY
)"
    if [ "$state" != inactive ]; then
        echo "oma-peek: kept ($state)"
        exit 0
    fi
fi

rm -f "$data/thumbnailers/oma-peek.thumbnailer" "$data/sushi/plugins-1/oma-peek.js" \
    "$data/sushi/viewers/oma-peek.js"
rm -rf "$data/oma-peek" "$data/oma-peek.new" "$data/oma-peek.old" "${XDG_CACHE_HOME:-$HOME/.cache}/oma-peek" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/strata/actions/oma-peek"
pkill -f '^/usr/bin/gjs( -m)? /usr/lib/org\.gnome\.NautilusPreviewer( |$)' 2>/dev/null || true
echo "oma-peek removed (run 'nautilus -q' so Nautilus forgets the thumbnailer)"
