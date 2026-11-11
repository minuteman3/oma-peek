#!/bin/bash
# T9: acceptance on a real Hyprland session. Drives the real Sushi previewer (on a private
# session bus) and the standalone viewer window against an isolated install, takes
# screenshots, and closes windows with real key presses (wtype). Windows appear briefly on
# the current workspace and take focus. Only windows of processes this script started (matched
# by PID) are ever selected, focused or closed.
#
# run: XDG_DATA_HOME=<install> XDG_CACHE_HOME=<cache> FIXTURES=<dir> [CAD_FIXTURES=<dir>] bash tests/acceptance.sh
# Exit 77 = skipped (not in a Hyprland session, display asleep, or a tool is missing).
set -uo pipefail

# The display must exist before anything GTK starts: without one the previewer crashes.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -z "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]; then
    HYPRLAND_INSTANCE_SIGNATURE="$(ls -t "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | head -1)"
    export HYPRLAND_INSTANCE_SIGNATURE
fi
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
    WAYLAND_DISPLAY="$(cd "$XDG_RUNTIME_DIR" && ls wayland-* 2>/dev/null | grep -v lock | head -1)"
    export WAYLAND_DISPLAY
fi
for tool in hyprctl grim wtype dbus-run-session gdbus python3; do
    command -v "$tool" >/dev/null || { echo "# skip: $tool not installed"; exit 77; }
done
[ -n "$WAYLAND_DISPLAY" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && hyprctl version >/dev/null 2>&1 ||
    { echo "# skip: no Hyprland session"; exit 77; }
# Typing into a locked session would type into the lock screen's password field, and window
# queries cannot tell (the compositor still reports the last focused window). Omarchy's lock is
# part of its shell; logind's LockedHint covers other lockers.
session_locked() {
    if command -v omarchy-shell >/dev/null && [ "$(omarchy-shell lock isLocked 2>/dev/null)" = true ]; then
        return 0
    fi
    local s
    for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk -v u="$(id -un)" '$3 == u {print $1}'); do
        [ "$(loginctl show-session "$s" -p LockedHint --value 2>/dev/null)" = yes ] && return 0
    done
    return 1
}
session_locked && { echo "# skip: the session is locked; unlock it and run again"; exit 77; }
# Screen capture waits for a frame, which never comes while the monitors sleep.
hyprctl monitors -j | python3 -c 'import json,sys; sys.exit(0 if any(m["dpmsStatus"] for m in json.load(sys.stdin)) else 1)' ||
    { echo "# skip: the display is asleep (DPMS off); wake it and run again"; exit 77; }

if [ "${1:-}" != --inner ]; then
    # Private session bus: our previewer and viewer app never meet the user's real ones.
    exec dbus-run-session -- bash "${BASH_SOURCE[0]}" --inner
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-accept-XXXXXX")"
pids=()
trap 'for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; [ -n "${OMA_PEEK_KEEP:-}" ] && echo "# kept $W" || rm -rf "$W"' EXIT
fails=0
check() {
    local name="$1"; shift
    if "$@"; then echo "ok - $name"; return 0; fi
    echo "not ok - $name"; fails=$((fails + 1)); return 1
}
pause() { python3 -c "import time; time.sleep($1)"; }

# Window queries see the whole compositor, so every query is scoped to a process this script
# started: the user's own windows are never selected, focused or closed.
clients() { # clients PID [TITLE] -> one "address x,y wxh" line per window of that process
    [ -n "${1:-}" ] || return 0
    hyprctl clients -j | python3 -c '
import json, sys
pid, title = int(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else None
for c in json.load(sys.stdin):
    if c["pid"] == pid and (title is None or c["title"] == title):
        (x, y), (w, h) = c["at"], c["size"]
        print(c["address"], "%d,%d %dx%d" % (x, y, w, h))' "$@"
}
wait_windows() { # wait_windows PID COUNT [seconds]
    for _ in $(seq $((${3:-10} * 10))); do
        [ "$(clients "$1" | wc -l)" -eq "$2" ] && return 0
        pause 0.1
    done
    return 1
}
bus_owner_pid() { # bus_owner_pid NAME: PID owning NAME on our private bus
    gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
        -m org.freedesktop.DBus.GetConnectionUnixProcessID "$1" 2>/dev/null | sed -n 's/^(uint32 \([0-9]*\),)$/\1/p'
}
# The centre of the window differs clearly from its content's left edge.
drawn() { # drawn "x,y wxh" PNG
    grim -g "$1" "$2" 2>/dev/null && python3 -I - "$2" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); w, h = im.size
bg = im.getpixel((8, h // 3))
pts = [(x, y) for x in range(int(w * .4), int(w * .6), 4) for y in range(int(h * .4), int(h * .6), 4)]
diff = sum(1 for p in pts if sum(abs(a - b) for a, b in zip(im.getpixel(p), bg)) > 30)
sys.exit(0 if diff > len(pts) * 0.5 else 1)
PY
}
# Hyprland 0.56+ takes Lua dispatcher calls.
focus_window() { hyprctl dispatch "hl.dsp.focus({ window = \"address:$1\" })" >/dev/null; }
close_window() { hyprctl dispatch "hl.dsp.window.close({ window = \"address:$1\" })" >/dev/null; }
press() { # press ADDRESS KEY: type KEY into the window, only if it has focus and the session is unlocked
    session_locked && { echo "# refusing to type: the session is locked"; return 1; }
    focus_window "$1"
    pause 0.4
    session_locked && { echo "# refusing to type: the session is locked"; return 1; }
    local active
    active="$(hyprctl -j activewindow | python3 -c 'import json,sys; print(json.load(sys.stdin).get("address",""))')"
    [ "$active" = "$1" ] && wtype -k "$2"
}

# --- Sushi: model shown, closes on Space and Escape with the 3D view focused -----------------
PREVIEWER=org.gnome.NautilusPreviewer
show() { # show FILE: ask our previewer to show FILE
    gdbus call --session -d $PREVIEWER -o /org/gnome/NautilusPreviewer \
        -m org.gnome.NautilusPreviewer2.ShowFile "file://$1" "" false "" >/dev/null
}
/usr/lib/org.gnome.NautilusPreviewer >"$W/previewer.log" 2>&1 &
sushi=$!
pids+=("$sushi")
gdbus wait --session --timeout 15 $PREVIEWER
check "Sushi: our previewer owns its bus name" test "$(bus_owner_pid $PREVIEWER)" = "$sushi"

for key in space Escape; do
    show "$FIXTURES/box-binary.stl"
    check "Sushi ($key): preview window opens" wait_windows "$sushi" 1 || continue
    pause 2.5
    read -r addr geom < <(clients "$sushi")
    check "Sushi ($key): model drawn" drawn "$geom" "$W/sushi-$key.png"
    press "$addr" "$key"
    check "Sushi: $key closes the preview" wait_windows "$sushi" 0 5
done
if [ -n "${CAD_FIXTURES:-}" ] && [ -x "$XDG_DATA_HOME/oma-peek/oma-peek-cad" ]; then
    show "$CAD_FIXTURES/assembly.step"
    if check "Sushi: STEP preview opens" wait_windows "$sushi" 1; then
        pause 4
        read -r addr geom < <(clients "$sushi")
        check "Sushi: STEP converted and drawn" drawn "$geom" "$W/sushi-step.png"
        press "$addr" Escape
        wait_windows "$sushi" 0 5
    fi
fi
check "Sushi: plugin loaded without errors" bash -c '! grep -E "oma-peek|JS ERROR" "$1"' _ "$W/previewer.log"

# --- standalone viewer (Strata action) ------------------------------------------------------
APP=io.github.minuteman3.OmaPeek
open_cmd="$XDG_DATA_HOME/oma-peek/oma-peek-open"
fake_converter() { # gated: each run logs "pid file", then waits on $W/gate-<file>
    printf '%s\n' '#!/bin/bash' \
        "echo \"\$\$ \$(basename \"\$1\")\" >>'$W/conv.log'" \
        "read -r _ <\"$W/gate-\$(basename \"\$1\")\"" \
        "cp '$FIXTURES/assembly.mpk' \"\$2\"" >"$XDG_DATA_HOME/oma-peek/oma-peek-cad"
    chmod +x "$XDG_DATA_HOME/oma-peek/oma-peek-cad"
}
standalone() {
    local app="" addr geom
    "$open_cmd" "$FIXTURES/box-binary.stl" "$FIXTURES/generic.3mf"
    for _ in $(seq 50); do app="$(bus_owner_pid $APP)"; [ -n "$app" ] && break; pause 0.1; done
    check "standalone: viewer starts on our bus" test -n "$app" || return
    pids+=("$app")
    check "standalone: two files open two windows" wait_windows "$app" 2 || return
    "$open_cmd" "$FIXTURES/two-groups.obj"
    check "standalone: a second launch opens in the running instance" wait_windows "$app" 3 || return
    check "standalone: still one viewer process" test "$(bus_owner_pid $APP)" = "$app"
    read -r addr geom < <(clients "$app" | head -1)
    check "standalone: model drawn" drawn "$geom" "$W/standalone.png"
    press "$addr" q
    check "standalone: Q closes one window" wait_windows "$app" 2 5 || return

    # Closing a window stops its own conversion only.
    cp "$XDG_DATA_HOME/oma-peek/oma-peek-cad" "$W/real-cad" 2>/dev/null
    fake_converter
    for f in a b; do echo fake >"$W/$f.step"; mkfifo "$W/gate-$f.step"; done
    while read -r a _; do close_window "$a"; done < <(clients "$app")
    wait_windows "$app" 0 5
    "$open_cmd" "$W/a.step" "$W/b.step"
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
    check "standalone: the other window shows its model" drawn "$geom" "$W/standalone-b.png"
    [ -f "$W/real-cad" ] && cp "$W/real-cad" "$XDG_DATA_HOME/oma-peek/oma-peek-cad"
    press "$addr" Escape
    check "standalone: Escape closes the last window" wait_windows "$app" 0 5
}
standalone

exit $((fails ? 1 : 0))
