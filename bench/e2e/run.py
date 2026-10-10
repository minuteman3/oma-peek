"""End-to-end thumbnailer benchmark: runs the exact embedded Exec payload that
install.sh produces (python3 -I -c CODE IN OUT SIZE) over bench/e2e/data.

usage: run.py CODE_FILE OUT_DIR [reps]
Prints per-file best-of-reps wall time and METRIC lines.
"""
import os, subprocess, sys, time

code = open(sys.argv[1]).read()
out_dir = sys.argv[2]
reps = int(sys.argv[3]) if len(sys.argv) > 3 else 3
data = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(out_dir, exist_ok=True)

# Thumbnail sizes Nautilus requests: 256 (large) is the default grid view.
# .mtl files are OBJ side files, not test cases.
cases = [(f, 256) for f in sorted(os.listdir(data)) if not f.endswith('.mtl')] + [('big.3mf', 512), ('typical.stl', 512)]
total = big = small = 0.0
for name, size in cases:
    best = float('inf')
    for _ in range(reps):
        out = os.path.join(out_dir, f'{name}.{size}.png')
        t = time.perf_counter()
        subprocess.run(['/usr/bin/python3', '-I', '-c', code, os.path.join(data, name), out, str(size)],
                       check=True, stdout=subprocess.DEVNULL)
        best = min(best, (time.perf_counter() - t) * 1000)
    print(f'{name}@{size} {best:.1f} ms')
    total += best
    if name.startswith('big'):
        big += best
    else:
        small += best
print(f'METRIC total_ms={total:.1f}\nMETRIC big_ms={big:.1f}\nMETRIC small_ms={small:.1f}')
