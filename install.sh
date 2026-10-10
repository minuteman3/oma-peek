#!/bin/bash
# Build oma-peek and install it for the current user:
#   ~/.local/share/oma-peek/                 viewer page, CAD converter, uninstall script
#   ~/.local/share/sushi/viewers/oma-peek.js  Sushi (Nautilus spacebar) viewer module
#   ~/.local/share/thumbnailers/oma-peek.thumbnailer
#
# The gnome-desktop thumbnailer sandbox only exposes /usr plus the input and
# output files, so nothing in ~/.local can be executed from inside it. Instead
# the Exec line runs the system python3 with thumbnailer.py and the native
# libraries embedded (zlib + base64); the libraries are loaded from memfds.
#
#   install.sh                  build and install
#   install.sh --if-changed     same, but do nothing if this source is already installed
#   install.sh --notify         also send a desktop notification on install / failure
#   install.sh --uninstall      remove everything installed above
#   install.sh --payload FILE   only write the thumbnailer's python -c code to FILE (benchmarks)
#
# The Omarchy plugin (Service.qml) runs `install.sh --if-changed --notify` at shell start.
# Nothing is ever written next to this script: the shell reloads a plugin whenever its
# folder changes, so build outputs go to ~/.cache/oma-peek/build instead.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
runtime="$data/oma-peek"
thumbnailers="$data/thumbnailers"
viewers="$data/sushi/viewers"
build="${XDG_CACHE_HOME:-$HOME/.cache}/oma-peek/build"

if_changed=0 notify=0 payload_file=""
while (($#)); do
    case "$1" in
    --if-changed) if_changed=1 ;;
    --notify) notify=1 ;;
    --uninstall) exec "$here/uninstall.sh" ;;
    --payload) payload_file="$2"; shift ;;
    *) echo "usage: install.sh [--if-changed] [--notify] [--uninstall] [--payload FILE]" >&2; exit 2 ;;
    esac
    shift
done

notify() {
    ((notify)) && command -v notify-send >/dev/null && notify-send -a oma-peek "$@" || true
}

# Everything that affects what gets installed.
fingerprint() {
    (cd "$here" && cat install.sh uninstall.sh raster.c cad.cpp thumbnailer.py cflags ldlibs cad_ldlibs \
        sushi/oma-peek.js $(find web -type f | sort)) | sha1sum | cut -d' ' -f1
}
stamp="$runtime/.installed"
if ((if_changed)) && [ -z "$payload_file" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(fingerprint)" ]; then
    exit 0
fi

# One install at a time (a shell reload could start another while this one builds).
mkdir -p "$build"
exec 9>"$build/.lock"
flock -n 9 || { echo "another oma-peek install is running" >&2; exit 0; }

trap 'notify -u critical "oma-peek install failed" "Run $here/install.sh in a terminal to see why."' ERR

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

# Runtime files: real copies, so the plugin checkout can move or be removed freely.
mkdir -p "$runtime" "$viewers"
rm -rf "$runtime/web"
cp -r "$here/web" "$runtime/web"
if [ -f "$build/oma-peek-cad" ]; then
    install -m755 "$build/oma-peek-cad" "$runtime/oma-peek-cad"
else
    rm -f "$runtime/oma-peek-cad"
fi
install -m755 "$here/uninstall.sh" "$runtime/uninstall.sh"
install -m644 "$here/sushi/oma-peek.js" "$viewers/oma-peek.js"

# Let Nautilus retry files it previously failed to thumbnail; restart the previewer so
# Sushi loads the new viewer module next time.
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/thumbnails/fail/gnome-thumbnail-factory"
pkill -f '^/usr/bin/gjs /usr/lib/org.gnome.NautilusPreviewer' 2>/dev/null || true

fingerprint >"$stamp"
echo "installed oma-peek"
notify "oma-peek installed" "3D previews updated. Run 'nautilus -q' to load new thumbnails."
