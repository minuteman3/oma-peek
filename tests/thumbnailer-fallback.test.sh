#!/bin/bash
# T6b: the thumbnailer's pure-Python (numpy) path, used when its native library can't load,
# reads the same STLs as the native path and the viewer (tests/fixtures/models.py).
# Runs thumbnailer.py from a copy without the native library, so the fallback is the real path.
# run: FIXTURES=<dir> bash tests/thumbnailer-fallback.test.sh     Exit 77 = skipped.
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -I -c 'import numpy, PIL' 2>/dev/null || { echo "# skip: python numpy and pillow are needed"; exit 77; }
W="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-fallback-XXXXXX")"
trap 'rm -rf "$W"' EXIT
cp "$repo/thumbnailer.py" "$W/"
fails=0
for f in box-binary box-ascii count-zero padded truncated solid-header-binary crlf-ascii garbage notes; do
    rm -f "$W/out.png"
    python3 -I "$W/thumbnailer.py" "$FIXTURES/$f.stl" "$W/out.png" 128 >"$W/log" 2>&1
    case "$f" in garbage | notes) want=none ;; *) want=image ;; esac
    if [ "$want" = image ]; then
        [ -s "$W/out.png" ] && python3 -I - "$W/out.png" <<'PY' && ok=1 || ok=0
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
bg = im.getpixel((0, 0))
diff = sum(1 for x in range(0, im.width, 4) for y in range(0, im.height, 4)
           if sum(abs(a - b) for a, b in zip(im.getpixel((x, y)), bg)) > 30)
sys.exit(0 if max(im.size) == 128 and diff > 20 else 1)
PY
    else
        [ ! -s "$W/out.png" ] && ok=1 || ok=0
    fi
    grep -q 'using numpy' "$W/log" || ok=0       # must really be the fallback path
    if ((ok)); then echo "ok - fallback: $f.stl -> $want"; else echo "not ok - fallback: $f.stl -> $want"; fails=$((fails + 1)); fi
done
exit $((fails ? 1 : 0))
