#!/bin/bash
# T7 + T7r: install state machine (install.sh / uninstall.sh) and the previewer restart.
# Runs a copy of the sources against temporary XDG directories, inside user + PID namespaces
# so the restart's pkill can only see processes started by this test.
# run: bash tests/install.test.sh     Exit 77 = skipped (no unprivileged namespaces).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-install-XXXXXX")"
trap 'chmod -R u+w "$W" 2>/dev/null; rm -rf "$W"' EXIT

ns() { unshare --user --map-root-user --pid --fork --mount-proc "$@"; }
ns true 2>/dev/null || { echo "# skip: unprivileged user/PID namespaces unavailable"; exit 77; }

fails=0
check() { # check NAME COMMAND...
    local name="$1"; shift
    if "$@"; then echo "ok - $name"; else echo "not ok - $name"; fails=$((fails + 1)); fi
}

src="$W/src"
mkdir -p "$src"
(cd "$repo" && cp -r install.sh uninstall.sh raster.c cad.cpp thumbnailer.py cflags ldlibs cad_ldlibs \
    sushi gjs strata web "$src/")
export XDG_DATA_HOME="$W/data" XDG_CACHE_HOME="$W/cache" XDG_STATE_HOME="$W/state" XDG_CONFIG_HOME="$W/config"
data="$XDG_DATA_HOME"
run() { ns bash "$src/install.sh" "$@" >"$W/out" 2>&1; }
uninstall() { ns bash "$src/uninstall.sh" >"$W/out" 2>&1; }
installed() { grep -q '^installed oma-peek' "$W/out"; }
mtime() { stat -c %Y.%y "$1"; }

# --- fresh install ------------------------------------------------------------------------
mkdir -p "$data/sushi/viewers"
echo '// legacy' >"$data/sushi/viewers/oma-peek.js"
run
check "fresh install succeeds" installed
check "plugin installed for Sushi 51" test -f "$data/sushi/plugins-1/oma-peek.js"
check "runtime has host and viewer page" test -f "$data/oma-peek/host.js" -a -f "$data/oma-peek/web/index.html"
check "stamp written" test -s "$data/oma-peek/.installed"
check "legacy Sushi 50 module removed" test ! -e "$data/sushi/viewers/oma-peek.js"
check "no staging directories left" test ! -e "$data/oma-peek.new" -a ! -e "$data/oma-peek.old"
mimes="$(grep '^MimeType=' "$data/thumbnailers/oma-peek.thumbnailer")"
check "thumbnailer registers STL and 3MF" grep -q 'model/stl;.*model/3mf' <<<"$mimes"
if [ -x "$data/oma-peek/oma-peek-cad" ]; then
    check "thumbnailer registers STEP when the CAD converter is built" grep -q 'model/step' <<<"$mimes"
else
    check "thumbnailer omits STEP without the CAD converter" bash -c '! grep -q model/step <<<"$1"' _ "$mimes"
fi

# --- --if-changed -------------------------------------------------------------------------
before="$(mtime "$data/sushi/plugins-1/oma-peek.js")"
run --if-changed
check "--if-changed is a no-op when nothing changed" bash -c '! grep -q "^installed" "$1"' _ "$W/out"
check "--if-changed left installed files alone" test "$(mtime "$data/sushi/plugins-1/oma-peek.js")" = "$before"

echo '// edited' >>"$src/web/viewer.js"
run --if-changed
check "a content change reinstalls" installed
check "the edit is installed" grep -q '// edited' "$data/oma-peek/web/viewer.js"

echo 'same content' >"$src/web/a.txt"
run --if-changed
mv "$src/web/a.txt" "$src/web/b.txt"
run --if-changed
check "a rename with identical content reinstalls" installed
check "the renamed file is installed" test -f "$data/oma-peek/web/b.txt" -a ! -e "$data/oma-peek/web/a.txt"

mkdir -p "$XDG_CONFIG_HOME/strata"
run --if-changed
check "Strata appearing reinstalls" installed
check "Strata action written" test -f "$XDG_CONFIG_HOME/strata/actions/oma-peek/action.toml"

# --- failure and repair (a failed forced reinstall must not leave a valid-looking stamp) ----
mv "$data/sushi/plugins-1" "$W/plugins-1.saved"
touch "$data/sushi/plugins-1"            # a file where the directory should be: mkdir fails
run
check "a failing reinstall fails" bash -c '! grep -q "^installed" "$1"' _ "$W/out"
check "a failed install leaves no stamp" test ! -e "$data/oma-peek/.installed"
rm "$data/sushi/plugins-1"
mv "$W/plugins-1.saved" "$data/sushi/plugins-1"
run --if-changed
check "--if-changed repairs after a failed install" installed

# Failure after the thumbnailer entry was rewritten but before the runtime was replaced, with
# unchanged sources: the next --if-changed must still redo the install. Runs as the real user
# (no root inside the namespace) so the read-only data directory is enforced.
userns() { unshare --map-current-user --pid --fork --mount-proc "$@"; }
chmod a-w "$data"
userns bash "$src/install.sh" >"$W/out" 2>&1
chmod u+w "$data"
check "a reinstall failing before the runtime swap fails" bash -c '! grep -q "^installed" "$1"' _ "$W/out"
check "the thumbnailer entry was already rewritten" test "$data/thumbnailers/oma-peek.thumbnailer" -nt "$data/oma-peek/host.js"
run --if-changed
check "--if-changed redoes an install that failed before the swap" installed

# An install that arrives while an uninstall holds the lock waits, then builds from scratch
# (the uninstall removed the build directory under the lock).
lockfile="$XDG_STATE_HOME/oma-peek/install.lock"
exec 8>"$lockfile"
flock 8
echo '// arrives during uninstall' >>"$src/web/viewer.js"
run --if-changed 8>&- &
ipid=$!
sleep 1
check "an install waits for an uninstall in progress" kill -0 "$ipid"
rm -rf "$XDG_CACHE_HOME/oma-peek"         # what uninstall.sh removes while holding the lock
exec 8>&-
wait "$ipid"
check "the waiting install succeeds after the uninstall" installed

# --- sources changing during the build ------------------------------------------------------
# The raster build reads cflags; -include of a FIFO makes gcc wait until the test lets it go.
gate="$W/gate.h"
mkfifo "$gate"
cp "$src/cflags" "$W/cflags.saved"
echo "$(cat "$W/cflags.saved") -include $gate" >"$src/cflags"
run --if-changed &
pid=$!
exec 3>"$gate"                           # returns once gcc has opened the gate: build underway
echo '// changed mid-build' >>"$src/web/viewer.js"
exec 3>&-
# Release the second attempt only once it has started (the first gcc may still hold the FIFO).
for _ in $(seq 100); do grep -q 'attempt 1' "$W/out" && break; sleep 0.1; done
exec 3>"$gate"; exec 3>&-
wait "$pid"
check "a mid-build change triggers a second attempt" grep -q 'sources changed during install (attempt 1)' "$W/out"
check "the final install has the mid-build change" grep -q 'changed mid-build' "$data/oma-peek/web/viewer.js"
check "and is stamped" test -s "$data/oma-peek/.installed"

# --- install and uninstall serialize on one lock --------------------------------------------
echo '// trigger' >>"$src/web/viewer.js"
run --if-changed &
ipid=$!
exec 3>"$gate"                           # install is now mid-build, holding the lock
ns bash "$src/uninstall.sh" >"$W/out.uninstall" 2>&1 3>&- &   # must not inherit the gate writer
upid=$!
sleep 1
check "uninstall waits while an install runs" kill -0 "$upid"
check "nothing removed during the install" test -f "$data/sushi/plugins-1/oma-peek.js"
exec 3>&-
wait "$ipid"
wait "$upid"
cp "$W/cflags.saved" "$src/cflags"
check "uninstall ran after the install" grep -q 'oma-peek removed' "$W/out.uninstall"
left="$(find "$data" -name '*oma-peek*' | sed "s|$W/||")"
check "uninstall removes every installed file" test -z "$left"
check "uninstall removes the Strata action" test ! -e "$XDG_CONFIG_HOME/strata/actions/oma-peek"
check "uninstall removes the cache" test ! -e "$XDG_CACHE_HOME/oma-peek"

# --- T7r: previewer restart matches Sushi 51 and older, nothing else ----------------------------
restart_case() { # restart_case SCRIPT
    ns bash -c '
        fake() { perl -e "\$0 = shift; sleep 60" "$1" >/dev/null 2>&1 & echo $!; }
        new=$(fake "/usr/bin/gjs -m /usr/lib/org.gnome.NautilusPreviewer")
        old=$(fake "/usr/bin/gjs /usr/lib/org.gnome.NautilusPreviewer")
        other=$(fake "/usr/bin/gjs -m /usr/lib/org.gnome.NautilusPreviewerHelper")
        script=$(fake "/usr/bin/gjs -m /tmp/notes.js")
        sleep 0.3
        bash "$1" >/dev/null 2>&1
        sleep 0.3
        alive() { kill -0 "$1" 2>/dev/null && echo alive || echo dead; }
        echo "$(alive "$new") $(alive "$old") $(alive "$other") $(alive "$script")"
    ' _ "$1"
}
check "uninstall restarts Sushi 51 and older previewers only" test "$(restart_case "$src/uninstall.sh")" = "dead dead alive alive"
check "install restarts Sushi 51 and older previewers only" test "$(restart_case "$src/install.sh")" = "dead dead alive alive"

exit $((fails ? 1 : 0))
