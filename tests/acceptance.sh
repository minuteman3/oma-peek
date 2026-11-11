#!/bin/bash
# T9: acceptance in a private nested Hyprland. Starts its own Hyprland as a window of the
# current Wayland session, then drives the real Sushi previewer (on a private session bus) and
# the standalone viewer inside it: screenshots, and real key presses through wtype.
#
# Isolation from the user's session:
# - everything runs in a fresh user + PID namespace (killed and reaped as a whole at the end)
#   with a minimal environment: no host DISPLAY, WAYLAND_*, HYPRLAND_* or session bus, a
#   private HOME and config directory, and GSettings kept in memory, so nothing can change
#   the user's settings (dconf) or dotfiles;
# - the private session bus and every client use a private runtime directory, so they can only
#   find the nested compositor; D-Bus activated services get the nested environment too;
# - the nested Hyprland reaches the user's compositor only as a Wayland client (one window),
#   and is denied a seat (no DRM, no physical input): checked in its log before anything runs.
#   Xwayland is off (it would inspect the shared /tmp/.X11-unix locks).
#
# run: XDG_DATA_HOME=<install> XDG_CACHE_HOME=<cache> FIXTURES=<dir> [CAD_FIXTURES=<dir>] bash tests/acceptance.sh
# Exit 77 = skipped (no Wayland session to nest in, or a tool is missing).
set -uo pipefail

if [ "${1:-}" != --inner ]; then
    for tool in Hyprland hyprctl grim wtype dbus-run-session dbus-update-activation-environment gdbus python3 unshare; do
        command -v "$tool" >/dev/null || { echo "# skip: $tool not installed"; exit 77; }
    done
    host_runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    host_wayland="${WAYLAND_DISPLAY:-}"
    [ -n "$host_wayland" ] ||
        host_wayland="$(cd "$host_runtime" && ls wayland-* 2>/dev/null | grep -v lock | head -1)"
    case "$host_wayland" in /*) ;; *) host_wayland="$host_runtime/$host_wayland" ;; esac
    [ -S "$host_wayland" ] || { echo "# skip: no Wayland session to nest a compositor in"; exit 77; }
    unshare --map-current-user --pid --fork --mount-proc true 2>/dev/null ||
        { echo "# skip: unprivileged user/PID namespaces unavailable"; exit 77; }
    # Private runtime directory (short path: Unix socket paths are limited to 108 bytes). The
    # host socket path is handed over in a file, so it is in no process environment.
    RUN="$(mktemp -d /tmp/opk.XXXXXX)"
    chmod 700 "$RUN"
    mkdir -p "$RUN/home/.config" "$RUN/home/.local/state"
    printf '%s' "$host_wayland" >"$RUN/.host-wayland"
    exec env -i HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_STATE_HOME="$RUN/home/.local/state" \
        GSETTINGS_BACKEND=memory PATH="$PATH" USER="${USER:-}" LANG="${LANG:-C.UTF-8}" \
        TMPDIR="${TMPDIR:-/tmp}" XDG_RUNTIME_DIR="$RUN" \
        XDG_DATA_HOME="$XDG_DATA_HOME" XDG_CACHE_HOME="$XDG_CACHE_HOME" \
        FIXTURES="$FIXTURES" CAD_FIXTURES="${CAD_FIXTURES:-}" OMA_PEEK_KEEP="${OMA_PEEK_KEEP:-}" \
        unshare --map-current-user --pid --fork --kill-child --mount-proc \
        dbus-run-session -- bash "${BASH_SOURCE[0]}" --inner
fi

RUN="$XDG_RUNTIME_DIR"
host_wayland="$(cat "$RUN/.host-wayland")"
rm -f "$RUN/.host-wayland"
W="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-accept-XXXXXX")"
nested=""
# Everything in this PID namespace is ours: stop all of it (the private bus's init process,
# PID 1, excepted), wait until it is gone, then remove our files.
cleanup() {
    trap - EXIT
    kill -TERM -1 2>/dev/null
    # kill -0 -1 (a builtin) succeeds while any other process we can signal is left.
    for _ in $(seq 50); do
        kill -0 -1 2>/dev/null || break
        python3 -c 'import time; time.sleep(0.1)'
    done
    kill -KILL -1 2>/dev/null
    while kill -0 -1 2>/dev/null; do wait 2>/dev/null; python3 -c 'import time; time.sleep(0.05)'; done
    rm -rf "$RUN"
    [ -n "${OMA_PEEK_KEEP:-}" ] && echo "# kept $W" || rm -rf "$W"
}
trap cleanup EXIT
fails=0
check() {
    local name="$1"; shift
    if "$@"; then echo "ok - $name"; return 0; fi
    echo "not ok - $name"; fails=$((fails + 1)); return 1
}
pause() { python3 -c "import time; time.sleep($1)"; }

# --- the nested compositor ----------------------------------------------------------------
# Defaults otherwise: no autostart, no user bindings.
cat >"$W/hyprland.lua" <<'LUA'
hl.config({
  xwayland = { enabled = false },
  cursor = { sync_gsettings_theme = false },
  ecosystem = { no_update_news = true, no_donation_nag = true },
})
LUA
# Only this process is given the user's compositor socket. LIBSEAT_BACKEND names no real
# backend, so it can't open a seat (no DRM, no physical input devices).
LIBSEAT_BACKEND=oma-peek-no-seat WAYLAND_DISPLAY="$host_wayland" \
    Hyprland --config "$W/hyprland.lua" >"$W/hyprland.log" 2>&1 &
nested=$!
sig="" sock=""
for _ in $(seq 100); do
    read -r sig sock < <(hyprctl -j instances 2>/dev/null | python3 -c '
import json, sys
for i in json.load(sys.stdin):
    if i["pid"] == int(sys.argv[1]):
        print(i["instance"], i["wl_socket"])' "$nested")
    [ -n "$sig" ] && [ -S "$RUN/$sock" ] && break
    pause 0.1
done
[ -n "$sig" ] && [ -S "$RUN/$sock" ] || { echo "# skip: could not start a nested Hyprland"; exit 77; }
hlog="$RUN/hypr/$sig/hyprland.log"
if ! { grep -q 'libseat: failed to open a seat' "$hlog" && grep -q 'Starting the Wayland backend' "$hlog" &&
       ! grep -q 'Starting the DRM backend' "$hlog" && ! grep -qi 'xwayland' "$hlog"; }; then
    echo "not ok - nested Hyprland runs without a seat or Xwayland, on the Wayland backend only"
    exit 1
fi
echo "ok - nested Hyprland runs without a seat or Xwayland, on the Wayland backend only"
export WAYLAND_DISPLAY="$sock" HYPRLAND_INSTANCE_SIGNATURE="$sig"
# Services the private bus starts on demand (portals, GVfs, dconf, accessibility) get the same.
dbus-update-activation-environment XDG_RUNTIME_DIR WAYLAND_DISPLAY HYPRLAND_INSTANCE_SIGNATURE \
    HOME XDG_CONFIG_HOME XDG_STATE_HOME GSETTINGS_BACKEND
nested_alive() { kill -0 "$nested" 2>/dev/null; }
nested_only() {
    [ -z "${WAYLAND_SOCKET:-}" ] && [ -z "${DISPLAY:-}" ] && [ "$XDG_RUNTIME_DIR" = "$RUN" ] &&
        [ "$WAYLAND_DISPLAY" = "$sock" ] && [ "$HYPRLAND_INSTANCE_SIGNATURE" = "$sig" ] && nested_alive
}
timeout 10 grim "$W/probe.png" 2>/dev/null ||
    { echo "# skip: the nested compositor is not drawing (is the display asleep?)"; exit 77; }

# Fails (non-zero) when the compositor can't be asked, so a dead or unreachable compositor
# never looks like "no windows".
clients() { # clients PID [TITLE] -> one "address x,y wxh" line per window of that process
    [ -n "${1:-}" ] || return 1
    nested_alive || return 1
    local json
    json="$(hyprctl clients -j)" || return 1
    python3 -c '
import json, sys
pid, title = int(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else None
for c in json.load(sys.stdin):
    if c["pid"] == pid and (title is None or c["title"] == title):
        (x, y), (w, h) = c["at"], c["size"]
        print(c["address"], "%d,%d %dx%d" % (x, y, w, h))' "$@" <<<"$json"
}
wait_windows() { # wait_windows PID COUNT [seconds]
    local out
    for _ in $(seq $((${3:-10} * 10))); do
        out="$(clients "$1")" || return 1
        [ "$(grep -c . <<<"$out")" -eq "$2" ] && return 0
        pause 0.1
    done
    return 1
}
bus_owner_pid() { # bus_owner_pid NAME: PID owning NAME on our private bus
    gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
        -m org.freedesktop.DBus.GetConnectionUnixProcessID "$1" 2>/dev/null | sed -n 's/^(uint32 \([0-9]*\),)$/\1/p'
}
# A model is drawn: in the viewer area (right of any sidebar, below the header), at least 10%
# of pixels differ clearly from the area's most common colour (the background). A progress
# or error page is background plus a line of text.
drawn() { # drawn "x,y wxh" PNG
    grim -g "$1" "$2" 2>/dev/null && python3 -I - "$2" <<'PY'
import sys
from collections import Counter
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); w, h = im.size
pts = [im.getpixel((x, y)) for x in range(int(w * .45), int(w * .95), 3) for y in range(int(h * .2), int(h * .9), 3)]
bg = Counter(pts).most_common(1)[0][0]
diff = sum(1 for p in pts if sum(abs(a - b) for a, b in zip(p, bg)) > 60)
sys.exit(0 if diff > len(pts) * 0.10 else 1)
PY
}
# Hyprland 0.56+ takes Lua dispatcher calls.
focus_window() { hyprctl dispatch "hl.dsp.focus({ window = \"address:$1\" })" >/dev/null; }
close_window() { hyprctl dispatch "hl.dsp.window.close({ window = \"address:$1\" })" >/dev/null; }
# Maximize a window and screenshot it once its size has settled: tiling and late resizes
# otherwise make the captured area depend on timing.
shown() { # shown PID ADDRESS PNG: the window's model is drawn
    hyprctl dispatch "hl.dsp.window.fullscreen({ mode = \"maximized\", action = \"set\", window = \"address:$2\" })" >/dev/null
    local geom prev=""
    for _ in $(seq 20); do
        pause 0.25
        geom="$(clients "$1" | awk -v a="$2" '$1 == a {print $2, $3}')" || return 1
        [ -n "$geom" ] && [ "$geom" = "$prev" ] && break
        prev="$geom"
    done
    pause 0.5
    drawn "$geom" "$3"
}
press() { # press ADDRESS KEY: focus the window, then type KEY (into the nested compositor only)
    nested_only || { echo "# refusing to type outside the nested compositor"; return 1; }
    focus_window "$1"
    pause 0.3
    [ "$(hyprctl -j activewindow | python3 -c 'import json,sys; print(json.load(sys.stdin).get("address",""))')" = "$1" ] ||
        return 1
    nested_only && wtype -k "$2"
}

# --- Sushi: model shown, closes on Space and Escape with the 3D view focused -----------------
PREVIEWER=org.gnome.NautilusPreviewer
show() { # show FILE: ask our previewer to show FILE
    gdbus call --session -d $PREVIEWER -o /org/gnome/NautilusPreviewer \
        -m org.gnome.NautilusPreviewer2.ShowFile "file://$1" "" false "" >/dev/null
}
/usr/lib/org.gnome.NautilusPreviewer >"$W/previewer.log" 2>&1 &
sushi=$!
gdbus wait --session --timeout 15 $PREVIEWER
check "Sushi: our previewer owns its bus name" test "$(bus_owner_pid $PREVIEWER)" = "$sushi"

for key in space Escape; do
    show "$FIXTURES/box-binary.stl"
    check "Sushi ($key): preview window opens" wait_windows "$sushi" 1 || continue
    pause 2.5
    read -r addr geom < <(clients "$sushi")
    check "Sushi ($key): model drawn" shown "$sushi" "$addr" "$W/sushi-$key.png"
    check "Sushi ($key): key delivered" press "$addr" "$key" || continue
    check "Sushi: $key closes the preview" wait_windows "$sushi" 0 5
done
if [ -n "${CAD_FIXTURES:-}" ] && [ -x "$XDG_DATA_HOME/oma-peek/oma-peek-cad" ]; then
    show "$CAD_FIXTURES/assembly.step"
    if check "Sushi: STEP preview opens" wait_windows "$sushi" 1; then
        pause 4
        read -r addr geom < <(clients "$sushi")
        check "Sushi: STEP converted and drawn" shown "$sushi" "$addr" "$W/sushi-step.png"
        check "Sushi (STEP): Escape delivered" press "$addr" Escape &&
            check "Sushi: Escape closes the STEP preview" wait_windows "$sushi" 0 5
    fi
fi
check "Sushi: plugin loaded without errors" bash -c '! grep -E "oma-peek|JS ERROR" "$1"' _ "$W/previewer.log"

# --- standalone viewer (Strata action) ------------------------------------------------------
APP=io.github.minuteman3.OmaPeek
open_cmd="$XDG_DATA_HOME/oma-peek/oma-peek-open"
viewer_pid() { # wait for the viewer app on our bus and print its PID
    local p=""
    for _ in $(seq 50); do p="$(bus_owner_pid $APP)"; [ -n "$p" ] && break; pause 0.1; done
    echo "$p"
}
fake_converter() { # gated: each run logs "pid file", then waits on $W/gate-<file>
    printf '%s\n' '#!/bin/bash' \
        "echo \"\$\$ \$(basename \"\$1\")\" >>'$W/conv.log'" \
        "read -r _ <\"$W/gate-\$(basename \"\$1\")\"" \
        "cp '$FIXTURES/assembly.mpk' \"\$2\"" >"$XDG_DATA_HOME/oma-peek/oma-peek-cad"
    chmod +x "$XDG_DATA_HOME/oma-peek/oma-peek-cad"
}
standalone() {
    local app addr geom
    "$open_cmd" "$FIXTURES/box-binary.stl" "$FIXTURES/generic.3mf"
    app="$(viewer_pid)"
    check "standalone: viewer starts on our bus" test -n "$app" || return
    check "standalone: two files open two windows" wait_windows "$app" 2 || return
    "$open_cmd" "$FIXTURES/two-groups.obj"
    check "standalone: a second launch opens in the running instance" wait_windows "$app" 3 || return
    check "standalone: still one viewer process" test "$(bus_owner_pid $APP)" = "$app"
    read -r addr geom < <(clients "$app" | head -1)
    check "standalone: model drawn" shown "$app" "$addr" "$W/standalone.png"
    check "standalone: Q delivered" press "$addr" q || return
    check "standalone: Q closes one window" wait_windows "$app" 2 5 || return

    # Closing a window stops its own conversion only. The viewer exits with its last window,
    # so after closing everything it is started again and found again by its bus name.
    cp "$XDG_DATA_HOME/oma-peek/oma-peek-cad" "$W/real-cad" 2>/dev/null
    fake_converter
    for f in a b; do echo fake >"$W/$f.step"; mkfifo "$W/gate-$f.step"; done
    while read -r a _; do close_window "$a"; done < <(clients "$app")
    check "standalone: all windows closed" wait_windows "$app" 0 5 || return
    for _ in $(seq 50); do [ "$(bus_owner_pid $APP)" != "$app" ] && break; pause 0.1; done
    "$open_cmd" "$W/a.step" "$W/b.step"
    app="$(viewer_pid)"
    check "standalone: viewer starts again" test -n "$app" || return
    check "standalone: two converting windows open" wait_windows "$app" 2 || return
    for _ in $(seq 50); do [ "$(wc -l <"$W/conv.log" 2>/dev/null || echo 0)" -eq 2 ] && break; pause 0.1; done
    local pid_a pid_b win_a
    pid_a="$(awk '$2 == "a.step" {print $1}' "$W/conv.log")"
    pid_b="$(awk '$2 == "b.step" {print $1}' "$W/conv.log")"
    read -r win_a _ < <(clients "$app" a.step)
    check "standalone: both conversions started" test -n "$pid_a" -a -n "$pid_b" -a -n "$win_a" || return
    close_window "$win_a"
    check "standalone: closing a window kills its conversion" \
        bash -c 'for _ in $(seq 30); do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.1; done; exit 1' _ "$pid_a"
    check "standalone: the other window's conversion continues" kill -0 "$pid_b"
    echo go >"$W/gate-b.step"
    pause 2
    read -r addr geom < <(clients "$app")
    check "standalone: the other window shows its model" shown "$app" "$addr" "$W/standalone-b.png"
    [ -f "$W/real-cad" ] && cp "$W/real-cad" "$XDG_DATA_HOME/oma-peek/oma-peek-cad"
    check "standalone: Escape delivered" press "$addr" Escape || return
    check "standalone: Escape closes the last window" wait_windows "$app" 0 5
}
standalone

exit $((fails ? 1 : 0))
