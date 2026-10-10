#!/bin/bash
# Build oma-peek's native helpers and (re)generate the Nautilus thumbnailer entry.
#
# The gnome-desktop thumbnailer sandbox only exposes /usr plus the input and
# output files, so nothing in ~/.local can be executed from inside it. Instead
# the Exec line runs the system python3 with this directory's thumbnailer.py
# and libmeshraster.so embedded (zlib + base64); the library is loaded from a memfd.
#
#   install.sh                  build and install the thumbnailer entry
#   install.sh --payload FILE   only write the Exec's python -c code to FILE (for benchmarks)
set -euo pipefail
payload_only="${1:-}"
[ "$payload_only" = --payload ] && payload_file="$2"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_dir="${XDG_DATA_HOME:-$HOME/.local/share}/thumbnailers"
mkdir -p "$out_dir"

gcc $(cat "$here/cflags") -shared -s -o "$here/libmeshraster.so" "$here/raster.c" $(cat "$here/ldlibs")

python3 -I - "$here" "$out_dir/oma-peek.thumbnailer" "${payload_file:-}" <<'EOF'
import base64, sys, zlib
here, dest, payload_file = sys.argv[1], sys.argv[2], sys.argv[3]
so = base64.b64encode(zlib.compress(open(f'{here}/libmeshraster.so', 'rb').read(), 9)).decode()
src = open(f'{here}/thumbnailer.py').read().replace('_NATIVE_SO = None', f'_NATIVE_SO = {so!r}', 1)
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
open(dest, 'w').write(
    '[Thumbnailer Entry]\n'
    'TryExec=/usr/bin/python3\n'
    f'Exec=/usr/bin/python3 -I -c "{code}" %i %o %s\n'
    f'MimeType={";".join(mimes)};\n')
print(f'wrote {dest} ({len(code)} byte payload)')
EOF

[ -n "${payload_file:-}" ] && exit 0

# Let Nautilus retry files it previously failed to thumbnail.
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/thumbnails/fail/gnome-thumbnail-factory"
