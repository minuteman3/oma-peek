#!/bin/bash
# T11: an Omarchy-managed install follows its plugin. uninstall.sh --if-inactive (run by the
# plugin's service whenever the shell drops it) removes the previews only when Omarchy's saved
# state says the plugin is disabled or gone, and never touches a manual install.
# Real install.sh / uninstall.sh against temporary XDG directories, inside user + PID
# namespaces so the previewer restart can only see this test's processes.
# run: bash tests/lifecycle.test.sh     Exit 77 = skipped (no unprivileged namespaces).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-lifecycle-XXXXXX")"
trap 'rm -rf "$W"' EXIT
ns() { unshare --user --map-root-user --pid --fork --mount-proc "$@"; }
ns true 2>/dev/null || { echo "# skip: unprivileged user/PID namespaces unavailable"; exit 77; }

fails=0
check() {
    local name="$1"; shift
    if "$@"; then echo "ok - $name"; else echo "not ok - $name"; fails=$((fails + 1)); fi
}

# The plugin checkout, as Omarchy keeps it in ~/.config/omarchy/plugins/<id>.
plugin="$W/plugins/minuteman3.oma-peek"
mkdir -p "$plugin"
(cd "$repo" && cp -r install.sh uninstall.sh raster.c cad.cpp thumbnailer.py cflags ldlibs cad_ldlibs \
    manifest.json sushi gjs strata web "$plugin/")
id="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$plugin/manifest.json")"

# One managed and one manual install, copied for every case.
install_into() { # install_into DIR [install args...]
    local dir="$1"; shift
    XDG_DATA_HOME="$dir/data" XDG_CACHE_HOME="$dir/cache" XDG_STATE_HOME="$dir/state" XDG_CONFIG_HOME="$dir/config" \
        ns bash "$plugin/install.sh" "$@" >"$dir.log" 2>&1
}
install_into "$W/managed" --managed || { echo "managed install failed"; cat "$W/managed.log"; exit 1; }
install_into "$W/manual" || { echo "manual install failed"; cat "$W/manual.log"; exit 1; }

record="$W/managed/data/oma-peek/.managed"
check "a managed install records its plugin" python3 -I - "$record" "$id" "$plugin" "$W/managed/config/omarchy/shell.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
sys.exit(0 if (r['plugin_id'], r['plugin_dir'], r['shell_config']) == tuple(sys.argv[2:5]) else 1)
PY
check "a manual install has no record" test ! -e "$W/manual/data/oma-peek/.managed"

# Switching between manual and managed is an install change, even with identical sources.
cp -a "$W/manual" "$W/switch"
install_into "$W/switch" --if-changed --managed
check "manual -> managed (--if-changed) writes the record" test -f "$W/switch/data/oma-peek/.managed"
install_into "$W/switch" --if-changed
check "managed -> manual (--if-changed) drops the record" test ! -e "$W/switch/data/oma-peek/.managed"

installed() { # installed DIR: previews still in place
    [ -f "$1/data/sushi/plugins-1/oma-peek.js" ] && [ -f "$1/data/thumbnailers/oma-peek.thumbnailer" ] &&
        [ -f "$1/data/oma-peek/host.js" ]
}
removed() { # removed DIR: nothing of the previews left
    [ ! -e "$1/data/sushi/plugins-1/oma-peek.js" ] && [ ! -e "$1/data/thumbnailers/oma-peek.thumbnailer" ] &&
        [ ! -e "$1/data/oma-peek" ]
}

# Omarchy's shell config, where the managed install recorded it (copies keep that path).
shell_json="$W/managed/config/omarchy/shell.json"
mkdir -p "$(dirname "$shell_json")"

# case NAME FROM SHELL_JSON|- PLUGIN(present|gone) EXPECT(kept|removed)
run_case() {
    local name="$1" from="$2" json="$3" dir_state="$4" expect="$5"
    local c="$W/case-${name// /_}"
    cp -a "$W/$from" "$c"
    rm -f "$shell_json"
    [ "$json" = - ] || printf '%s' "$json" >"$shell_json"
    local saved=""
    if [ "$dir_state" = gone ]; then saved="$W/plugin.saved"; mv "$plugin" "$saved"; fi
    XDG_DATA_HOME="$c/data" XDG_CACHE_HOME="$c/cache" XDG_STATE_HOME="$c/state" XDG_CONFIG_HOME="$c/config" \
        ns bash "$c/data/oma-peek/uninstall.sh" --if-inactive >"$c.log" 2>&1
    [ -n "$saved" ] && mv "$saved" "$plugin"
    if [ "$expect" = kept ]; then check "$name: previews kept" installed "$c"
    else check "$name: previews removed" removed "$c"; fi
}

enabled="{\"plugins\":[{\"id\":\"$id\"}]}"
run_case "enabled" managed "$enabled" present kept
run_case "enabled (plain id entry)" managed "{\"plugins\":[\"$id\"]}" present kept
run_case "disabled (not in plugins)" managed '{"plugins":[{"id":"someone.else"}]}' present removed
run_case "disabled (disabledPlugins)" managed "{\"plugins\":[{\"id\":\"$id\"}],\"disabledPlugins\":[\"$id\"]}" present removed
run_case "plugin removed" managed "$enabled" gone removed
run_case "shell.json missing" managed - present kept
run_case "shell.json unreadable" managed '{"plugins": [' present kept
run_case "manual install, plugin disabled" manual '{"plugins":[]}' present kept

# A re-enable that lands while the check waits for the install lock wins: the state is read
# only once the lock is held.
c="$W/case-race"
cp -a "$W/managed" "$c"
printf '%s' '{"plugins":[]}' >"$shell_json"
exec 8>"$c/state/oma-peek/install.lock"
flock 8
XDG_DATA_HOME="$c/data" XDG_CACHE_HOME="$c/cache" XDG_STATE_HOME="$c/state" XDG_CONFIG_HOME="$c/config" \
    ns bash "$c/data/oma-peek/uninstall.sh" --if-inactive >"$c.log" 2>&1 8>&- &
pid=$!
sleep 1
check "the check waits for the install lock" kill -0 "$pid"
printf '%s' "$enabled" >"$shell_json"
exec 8>&-
wait "$pid"
check "re-enabled while waiting: previews kept" installed "$c"

exit $((fails ? 1 : 0))
