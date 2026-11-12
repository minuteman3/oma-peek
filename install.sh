#!/bin/bash
# Build oma-peek and install it for the current user:
#   ~/.local/share/oma-peek/                    viewer page, host, CAD converter, uninstall script
#   ~/.local/share/sushi/plugins-1/oma-peek.js   Sushi 51+ (Nautilus spacebar) plugin
#   ~/.local/share/thumbnailers/oma-peek.thumbnailer
#   ~/.config/strata/actions/oma-peek/        Strata "Preview in oma-peek" action (if Strata is installed)
#
# The gnome-desktop thumbnailer sandbox only exposes /usr plus the input and
# output files, so nothing in ~/.local can be executed from inside it. Instead
# the Exec line runs the system python3 with thumbnailer.py and the native
# libraries embedded (zlib + base64); the libraries are loaded from memfds.
#
#   install.sh                  build and install
#   install.sh --if-changed     same, but do nothing if this source is already installed
#   install.sh --notify         also send a desktop notification on install / failure
#   install.sh --managed        installed by the Omarchy plugin (Service.qml): the previews then
#                               follow the plugin, and are removed when it is disabled or removed
#                               (uninstall.sh --if-inactive); without it the install is manual
#   install.sh --uninstall      remove everything installed above
#   install.sh --payload FILE   only write the thumbnailer's python -c code to FILE (benchmarks)
#
# The Omarchy plugin (Service.qml) runs `install.sh --if-changed --notify` at shell start.
# Nothing is ever written next to this script: the shell reloads a plugin whenever its
# folder changes, so build outputs go to ~/.cache/oma-peek/build instead.
#
# Install state: the stamp ($runtime/.installed) holds the fingerprint of the inputs that were
# installed. It is deleted before anything is replaced and written last, so an interrupted or
# failed install is always retried by the next --if-changed run. install.sh and uninstall.sh
# serialize on one lock outside every directory they remove.
set -eEuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
runtime="$data/oma-peek"
thumbnailers="$data/thumbnailers"
plugins="$data/sushi/plugins-1"
legacy_viewer="$data/sushi/viewers/oma-peek.js"
strata_config="${XDG_CONFIG_HOME:-$HOME/.config}/strata"
build="${XDG_CACHE_HOME:-$HOME/.cache}/oma-peek/build"
lock="${XDG_STATE_HOME:-$HOME/.local/state}/oma-peek/install.lock"

if_changed=0 notify=0 managed=0 payload_file=""
while (($#)); do
    case "$1" in
    --if-changed) if_changed=1 ;;
    --notify) notify=1 ;;
    --managed) managed=1 ;;
    --uninstall) exec "$here/uninstall.sh" ;;
    --payload) payload_file="$2"; shift ;;
    *) echo "usage: install.sh [--if-changed] [--notify] [--managed] [--uninstall] [--payload FILE]" >&2; exit 2 ;;
    esac
    shift
done

notify() {
    ((notify)) && command -v notify-send >/dev/null && notify-send -a oma-peek "$@" || true
}

# Everything that affects what gets installed: every source file (by relative name and
# content), plus the parts of the system the install adapts to. WebKit 6 counts only as
# present/absent: the plugin checks for it at run time, but the previewer must be restarted
# (by a reinstall) to pick up a newly installed WebKit. openscad is looked up at preview time
# and changes nothing installed, so it is not part of the fingerprint.
fingerprint() {
    (
        cd "$here"
        find . -maxdepth 1 -type f \( -name '*.sh' -o -name '*.c' -o -name '*.cpp' -o -name '*.py' \
            -o -name cflags -o -name ldlibs -o -name cad_ldlibs \) -print
        find sushi gjs strata web -type f -print
    ) | LC_ALL=C sort | while read -r f; do
        printf '%s %s\n' "$f" "$(sha1sum <"$here/$f" | cut -d' ' -f1)"
    done
    printf 'arch %s\n' "$(uname -m)"
    printf 'occt %s\n' "$(readlink -f /usr/lib/libTKernel.so 2>/dev/null || echo none)"
    printf 'webkit6 %s\n' "$([ -e /usr/lib/girepository-1.0/WebKit-6.0.typelib ] && echo yes || echo no)"
    printf 'strata %s\n' "$({ command -v strata >/dev/null || [ -d "$strata_config" ]; } && echo yes || echo no)"
    printf 'managed %s %s\n' "$managed" "$( ((managed)) && echo "$here" || true)"
}
fingerprint_id() { fingerprint | sha1sum | cut -d' ' -f1; }

stamp="$runtime/.installed"
installed_ok() {
    [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$1" ] &&
        [ -f "$runtime/host.js" ] && [ -f "$runtime/web/index.html" ] &&
        [ -f "$plugins/oma-peek.js" ] && [ -f "$thumbnailers/oma-peek.thumbnailer" ]
}

# Sushi builds its renderer table once per process, so a running previewer must restart to
# pick up a new or removed plugin. Sushi 51 runs as `gjs -m`; older releases as plain `gjs`.
restart_previewer() {
    pkill -f '^/usr/bin/gjs( -m)? /usr/lib/org\.gnome\.NautilusPreviewer( |$)' 2>/dev/null || true
}

# One install or uninstall at a time. A second request waits, then re-checks the state, so
# it is never dropped while the first one installs older sources.
# Only the lock's own directory is created before locking: an uninstall holding the lock may
# be removing everything else (the build directory included).
mkdir -p "$(dirname "$lock")"
exec 9>"$lock"
flock -w 300 9 || { echo "oma-peek: timed out waiting for another install" >&2; exit 1; }
mkdir -p "$build"

if ((if_changed)) && [ -z "$payload_file" ] && installed_ok "$(fingerprint_id)"; then
    exit 0
fi

trap 'notify -u critical "oma-peek install failed" "Run $here/install.sh in a terminal to see why."' ERR

install_once() {
fp_start="$(fingerprint_id)"
[ -z "$payload_file" ] && rm -f "$stamp"

gcc $(cat "$here/cflags") -shared -s -o "$build/libmeshraster.so" "$here/raster.c" $(cat "$here/ldlibs")
# OpenCASCADE-backed readers (STEP/IGES/glTF/OBJ): a library for the thumbnailer and a
# converter for the Sushi viewer. Skipped (with a warning) if OpenCASCADE isn't installed.
if [ -f /usr/include/opencascade/STEPCAFControl_Reader.hxx ]; then
    g++ -O2 -std=c++17 -fPIC -shared -s -I/usr/include/opencascade \
        -o "$build/libmeshcad.so" "$here/cad.cpp" $(cat "$here/cad_ldlibs")
    g++ -O2 -std=c++17 -s -DOMA_PEEK_CAD_MAIN -I/usr/include/opencascade \
        -o "$build/oma-peek-cad" "$here/cad.cpp" $(cat "$here/cad_ldlibs")
else
    echo "warning: OpenCASCADE headers not found; STEP/IGES/glTF previews disabled" >&2
    rm -f "$build/libmeshcad.so" "$build/oma-peek-cad"
fi

mkdir -p "$thumbnailers"
python3 -I - "$here" "$build" "$thumbnailers/oma-peek.thumbnailer" "$payload_file" <<'EOF'
import base64, os, sys, zlib
here, build, dest, payload_file = sys.argv[1:5]
def embed(lib):
    return base64.b64encode(zlib.compress(open(f'{build}/{lib}', 'rb').read(), 9)).decode()
src = open(f'{here}/thumbnailer.py').read().replace('_NATIVE_SO = None', f'_NATIVE_SO = {embed("libmeshraster.so")!r}', 1)
if os.path.exists(f'{build}/libmeshcad.so'):
    src = src.replace('_NATIVE_CAD_SO = None', f'_NATIVE_CAD_SO = {embed("libmeshcad.so")!r}', 1)
payload = base64.b64encode(zlib.compress(src.encode(), 9)).decode()
code = f"import base64,zlib;exec(zlib.decompress(base64.b64decode('{payload}')))"
if len(code) > 120_000:
    sys.exit(f'payload too large for one argv entry: {len(code)} bytes')
if payload_file:
    open(payload_file, 'w').write(code)
    sys.exit(0)
mimes = ['model/stl', 'model/x.stl-ascii', 'model/x.stl-binary', 'application/sla',
         'model/3mf', 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
         'model/obj', 'application/x-openscad']
if os.path.exists(f'{build}/libmeshcad.so'):
    mimes += ['model/step', 'model/iges', 'model/gltf+json', 'model/gltf-binary']
open(dest, 'w').write(
    '[Thumbnailer Entry]\n'
    'TryExec=/usr/bin/python3\n'
    f'Exec=/usr/bin/python3 -I -c "{code}" %i %o %s\n'
    f'MimeType={";".join(mimes)};\n')
print(f'wrote {dest} ({len(code)} byte payload)')
EOF
[ -n "$payload_file" ] && exit 0

# Runtime files: real copies, so the plugin checkout can move or be removed freely. Staged
# next to the live directory and swapped in, so a failed copy never leaves a half runtime.
stage="$runtime.new"
rm -rf "$stage" "$runtime.old"
mkdir -p "$stage"
cp -r "$here/web" "$stage/web"
[ -f "$build/oma-peek-cad" ] && install -m755 "$build/oma-peek-cad" "$stage/oma-peek-cad"
install -m755 "$here/uninstall.sh" "$stage/uninstall.sh"
install -m644 "$here/gjs/host.js" "$here/gjs/oma-peek-open.js" "$stage/"
install -m755 "$here/strata/oma-peek-open" "$stage/oma-peek-open"
[ -d "$runtime" ] && mv "$runtime" "$runtime.old"
mv "$stage" "$runtime"
rm -rf "$runtime.old"

mkdir -p "$plugins"
install -m644 "$here/sushi/oma-peek.js" "$plugins/oma-peek.js.new"
mv "$plugins/oma-peek.js.new" "$plugins/oma-peek.js"
# Sushi 50 and older read viewers/; this release needs Sushi 51 (GTK4), so drop the old module.
rm -f "$legacy_viewer"

# Installed by the Omarchy plugin: record which plugin and which shell config decide whether
# it is still wanted (read by uninstall.sh --if-inactive). A manual install has no record.
if ((managed)); then
    python3 -I - "$here/manifest.json" "$here" "${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/shell.json" \
        "$runtime/.managed" <<'PY'
import json, sys
manifest, plugin_dir, shell_config, dest = sys.argv[1:]
plugin_id = json.load(open(manifest))['id']
json.dump({'plugin_id': plugin_id, 'plugin_dir': plugin_dir, 'shell_config': shell_config}, open(dest, 'w'))
PY
fi

# Strata has no preview plugins, so oma-peek joins its file menu as a custom action that
# opens the viewer in its own window. Strata reads actions from disk when it builds a menu.
if command -v strata >/dev/null || [ -d "$strata_config" ]; then
    exts='"stl", "3mf", "obj", "scad"'
    [ -f "$build/oma-peek-cad" ] && exts+=', "step", "stp", "iges", "igs", "gltf", "glb"'
    mkdir -p "$strata_config/actions/oma-peek"
    cat >"$strata_config/actions/oma-peek/action.toml" <<TOML
# Written by oma-peek's install.sh; reinstalling overwrites it.
schema_version = 1
id = "oma-peek"
name = "Preview in oma-peek"
description = "Open the model in oma-peek's 3D viewer, with its plates and objects."
icon = "search"
enabled = true
menu = "top"

[when]
kinds = ["file"]
extensions = [$exts]
min_items = 1
max_items = 16

[run]
runtime = "command"
program = "$runtime/oma-peek-open"
args = ["{paths}"]
mode = "whole-selection"
working_directory = "parent"
confirm = false
TOML
fi

# Let Nautilus retry files it previously failed to thumbnail; restart the previewer so
# Sushi loads the new plugin next time.
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/thumbnails/fail/gnome-thumbnail-factory"
restart_previewer

# Stamp only the inputs that were actually installed: if a source changed while building,
# leave the install unstamped (stale) and let the caller try again.
if [ "$(fingerprint_id)" = "$fp_start" ]; then
    echo "$fp_start" >"$stamp"
    changed=0
else
    changed=1
fi
}

# Called as a plain command (not in an `if`), so set -e still stops on any failure inside.
for attempt in 1 2; do
    install_once
    ((changed)) || break
    echo "oma-peek: sources changed during install (attempt $attempt)" >&2
done
if ((changed)); then
    echo "oma-peek: sources keep changing; install left unstamped" >&2
    exit 1
fi
echo "installed oma-peek"
if [ -e /usr/lib/girepository-1.0/WebKit-6.0.typelib ]; then
    notify "oma-peek installed" "3D previews updated. Run 'nautilus -q' to load new thumbnails."
else
    echo "warning: webkitgtk-6.0 is not installed; thumbnails work but spacebar previews need it" >&2
    notify "oma-peek installed (thumbnails only)" "Install webkitgtk-6.0 for spacebar 3D previews."
fi
