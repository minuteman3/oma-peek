#!/bin/bash
# raster.c unit correctness vs bench/ref (from the raster track), then a thumbnailer smoke test.
set -euo pipefail
cd "$(dirname "$0")/.."
gcc $(cat cflags) -o bench/bench bench/bench.c raster.c $(cat ldlibs)
out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
./bench/bench bench/data "$out" >/dev/null
python3 -I - "$out" bench/ref <<'PY'
import sys, numpy as np
out, ref = sys.argv[1], sys.argv[2]
ok = True
for c in range(4):
    a = np.fromfile(f'{out}/raster{c}.rgba', np.uint8).reshape(-1, 4)
    b = np.fromfile(f'{ref}/raster{c}.rgba', np.uint8).reshape(-1, 4)
    diff = np.any(a != b, axis=1).mean()
    cover = (a[:, 3] > 0).mean(), (b[:, 3] > 0).mean()
    # Edge-rule / rounding changes may flip a few boundary pixels; nothing more.
    if diff > 0.002 or abs(cover[0] - cover[1]) > 0.001:
        print(f'raster{c}: {diff:.4%} pixels differ, coverage {cover}'); ok = False
for c in range(2):
    va = np.fromfile(f'{out}/mesh{c}.v', np.float32); vb = np.fromfile(f'{ref}/mesh{c}.v', np.float32)
    ta = np.fromfile(f'{out}/mesh{c}.t', np.int64); tb = np.fromfile(f'{ref}/mesh{c}.t', np.int64)
    if va.shape != vb.shape or ta.shape != tb.shape or not np.array_equal(ta, tb):
        print(f'mesh{c}: shape/triangle mismatch'); ok = False; continue
    err = np.abs(va - vb) / np.maximum(np.abs(vb), 1e-3)
    if err.max() > 1e-6:
        print(f'mesh{c}: vertex rel err {err.max()}'); ok = False
sys.exit(0 if ok else 1)
PY
# End-to-end: thumbnailer with this library.
gcc $(cat cflags) -shared -s -o libmeshraster.so raster.c -lm -lpthread
python3 -I thumbnailer.py ~/Downloads/frame_set_black1.3mf "$out/a.png" 256
python3 -I thumbnailer.py ~/Downloads/stand_V3.stl "$out/b.png" 128
python3 -I -c "from PIL import Image; import sys; [Image.open(p).verify() for p in sys.argv[1:]]" "$out/a.png" "$out/b.png"
echo checks ok
