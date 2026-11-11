#!/bin/bash
# T9: acceptance on a real Hyprland session. Drives the real Sushi previewer (on a private
# session bus) and the standalone viewer window against an isolated install, takes
# screenshots, and closes windows with real key presses (wtype). Windows appear briefly on
# the current workspace and take focus.
#
# run: XDG_DATA_HOME=<install> XDG_CACHE_HOME=<cache> FIXTURES=<dir> [CAD_FIXTURES=<dir>] bash tests/acceptance.sh
# Exit 77 = skipped (not in a Hyprland session, or a tool is missing).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
# Screen capture waits for a frame, which never comes while the monitors sleep.
hyprctl monitors -j | python3 -c 'import json,sys; sys.exit(0 if any(m["dpmsStatus"] for m in json.load(sys.stdin)) else 1)' ||
    { echo "# skip: the display is asleep (DPMS off); wake it and run again"; exit 77; }

if [ "${1:-}" != --inner ]; then
    # Private session bus: our previewer and viewer app never meet the user's real ones.
    exec dbus-run-session -- bash "${BASH_SOURCE[0]}" --inner
fi

W="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-accept-XXXXXX")"
pids=()
trap 'for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; rm -rf "$W"' EXIT
fails=0
check() {
    local name="$1"; shift
    if "$@"; then echo "ok - $name"; else echo "not ok - $name"; fails=$((fails + 1)); fi
}
pause() { python3 -c "import time; time.sleep($1)"; }

clients() { # clients CLASS -> one "address x,y wxh" line per window
    hyprctl clients -j | python3 -c '
import json, sys
for c in json.load(sys.stdin):
    if c["class"] == sys.argv[1]:
        (x, y), (w, h) = c["at"], c["size"]
        print(c["address"], "%d,%d %dx%d" % (x, y, w, h))' "$1"
}
wait_windows() { # wait_windows CLASS COUNT [seconds]
    for _ in $(seq $((${3:-10} * 10))); do
        [ "$(clients "$1" | wc -l)" -eq "$2" ] && return 0
        pause 0.1
    done
    return 1
}
# The centre of the window differs clearly from its top-left content corner.
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
press() { # press ADDRESS KEY: focus the window and type KEY into it, only if focus landed
    focus_window "$1"
    pause 0.4
    local active
    active="$(hyprctl -j activewindow | python3 -c 'import json,sys; print(json.load(sys.stdin).get("address",""))')"
    [ "$active" = "$1" ] && wtype -k "$2"
}

PREVIEWER=org.gnome.NautilusPreviewer
show() { # show FILE: ask the previewer to show FILE (it is activated on our private bus)
    gdbus call --session -d $PREVIEWER -o /org/gnome/NautilusPreviewer \
        -m org.gnome.NautilusPreviewer2.ShowFile "file://$1" "" false "" >/dev/null
}
/usr/lib/org.gnome.NautilusPreviewer >"$W/previewer.log" 2>&1 &
pids+=($!)
gdbus wait --session --timeout 15 $PREVIEWER

# --- Sushi: model shown, closes on Space and Escape with the 3D view focused -----------------
for key in space Escape; do
    show "$FIXTURES/box-binary.stl"
    check "Sushi ($key): preview window opens" wait_windows $PREVIEWER 1
    pause 2.5
    read -r addr geom < <(clients $PREVIEWER)
    check "Sushi ($key): model drawn" drawn "$geom" "$W/sushi-$key.png"
    press "$addr" "$key"
    check "Sushi: $key closes the preview" wait_windows $PREVIEWER 0 5
done
if [ -n "${CAD_FIXTURES:-}" ] && [ -x "$XDG_DATA_HOME/oma-peek/oma-peek-cad" ]; then
    show "$CAD_FIXTURES/assembly.step"
    wait_windows $PREVIEWER 1
    pause 4
    read -r addr geom < <(clients $PREVIEWER)
    check "Sushi: STEP converted and drawn" drawn "$geom" "$W/sushi-step.png"
    press "$addr" Escape
    wait_windows $PREVIEWER 0 5
fi
check "Sushi: plugin loaded without errors" bash -c '! grep -E "oma-peek|JS ERROR" "$1"' _ "$W/previewer.log"

# --- standalone viewer (Strata action) ------------------------------------------------------
APP=io.github.minuteman3.OmaPeek
open_cmd="$XDG_DATA_HOME/oma-peek/oma-peek-open"
"$open_cmd" "$FIXTURES/box-binary.stl" "$FIXTURES/generic.3mf"
check "standalone: two files open two windows" wait_windows $APP 2
"$open_cmd" "$FIXTURES/two-groups.obj"
check "standalone: a second launch opens in the running instance" wait_windows $APP 3
pause 1
check "standalone: one viewer process" test "$(pgrep -fc 'gjs -m .*oma-peek-open\.js')" -eq 1
read -r addr geom < <(clients $APP | head -1)
check "standalone: model drawn" drawn "$geom" "$W/standalone.png"
press "$addr" q
check "standalone: Q closes one window" wait_windows $APP 2 5

# Closing a window stops its own conversion only (fake converter, gated).
cp "$XDG_DATA_HOME/oma-peek/oma-peek-cad" "$W/real-cad" 2>/dev/null
cat >"$XDG_DATA_HOME/oma-peek/oma-peek-cad" <<EOF
#!/bin/bash
echo "\$\$ \$1" >>"$W/conv.log"
cat "$W/gate-\$(basename "\$1")" >/dev/null
cp "$FIXTURES/assembly.mpk" "\$2"
EOF
chmod +x "$XDG_DATA_HOME/oma-peek/oma-peek-cad"
for n in a b; do echo fake >"$W/$n.step"; mkfifo "$W/gate-$n.step"; done
for _ in 1 2; do read -r a _ < <(clients $APP); close_window "$a"; pause 0.3; done
"$open_cmd" "$W/a.step" "$W/b.step"
wait_windows $APP 2
for _ in $(seq 50); do [ "$(wc -l <"$W/conv.log" 2>/dev/null || echo 0)" -eq 2 ] && break; pause 0.1; done
pid_a="$(awk '/a.step/ {print $1}' "$W/conv.log")"
pid_b="$(awk '/b.step/ {print $1}' "$W/conv.log")"
title_a="$(hyprctl clients -j | python3 -c 'import json,sys; print(next(c["address"] for c in json.load(sys.stdin) if c["title"]=="a.step"))')"
close_window "$title_a"
pause 1
check "standalone: closing a window kills its conversion" bash -c '! kill -0 "$1" 2>/dev/null' _ "$pid_a"
check "standalone: the other window's conversion continues" kill -0 "$pid_b"
: >"$W/gate-b.step"
pause 2
read -r addr geom < <(clients $APP)
check "standalone: the other window shows its model" drawn "$geom" "$W/standalone-b.png"
[ -f "$W/real-cad" ] && cp "$W/real-cad" "$XDG_DATA_HOME/oma-peek/oma-peek-cad"
press "$addr" Escape
check "standalone: Escape closes the last window" wait_windows $APP 0 5

exit $((fails ? 1 : 0))
