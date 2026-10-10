"""oma-peek thumbnailer: STL / 3MF / OBJ / SCAD -> PNG for Nautilus.

Usage: thumbnailer.py INPUT OUTPUT.png SIZE

Runs inside the gnome-desktop thumbnailer sandbox, which only exposes /usr,
the input file and the output directory, so this file must stay
self-contained (stdlib + numpy; Pillow only for the embedded-thumbnail
fallback). install.sh embeds it into the .thumbnailer Exec line.

Images are numpy RGBA arrays throughout and are written with a small zlib PNG
encoder: importing Pillow costs ~50 ms of every thumbnail's startup.
"""

import math
import os
import sys

import numpy as np


class _Lazy:
    """Import a module on first use: STL/OBJ thumbnails never need re, json,
    zipfile or subprocess, and every import is paid per thumbnail process."""

    def __init__(self, name):
        self._name = name

    def __getattr__(self, attr):
        import importlib
        mod = importlib.import_module(self._name)
        globals()[self._name] = mod
        return getattr(mod, attr)


json = _Lazy('json')
re = _Lazy('re')
subprocess = _Lazy('subprocess')
zipfile = _Lazy('zipfile')

DEFAULT_COLOUR = (185, 192, 200)

# Compressed libmeshraster.so (base64 of zlib), filled in by install.sh.
_NATIVE_SO = None
VIEW_DIR = np.array([0.75, -1.05, 0.62])   # printer coords, Z up: front-right, above
LIGHT = np.array([0.35, -0.55, 0.9])


# --- geometry loaders: return list of parts {tris: (n,3,3) float32, colour, plate} ---

def load_stl(data):
    if len(data) >= 84:
        n = int.from_bytes(data[80:84], 'little')
        if n and len(data) == 84 + 50 * n:
            rec = np.frombuffer(data, dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]),
                                count=n, offset=84)
            return [dict(tris=rec['v'].astype(np.float32), colour=None, plate=0)]
    nums = re.findall(rb'vertex\s+(\S+)\s+(\S+)\s+(\S+)', data)
    v = np.array(nums, dtype=np.float64).astype(np.float32).reshape(-1, 3, 3)
    return [dict(tris=v, colour=None, plate=0)]


def load_obj(data):
    verts, faces = [], []
    for line in data.decode('utf-8', 'replace').splitlines():
        if line.startswith('v '):
            p = line.split()
            verts.append((float(p[1]), float(p[2]), float(p[3])))
        elif line.startswith('f '):
            ids = [int(t.split('/')[0]) for t in line.split()[1:]]
            ids = [i - 1 if i > 0 else len(verts) + i for i in ids]
            for k in range(1, len(ids) - 1):
                faces.append((ids[0], ids[k], ids[k + 1]))
    v = np.array(verts, dtype=np.float32)
    if not len(v) or not faces:
        return []
    v = v[:, [0, 2, 1]] * np.array([1, -1, 1], dtype=np.float32)   # Y-up -> Z-up
    return [dict(tris=v[np.array(faces)], colour=None, plate=0)]


ATTR = r'([\w:]+)\s*=\s*"([^"]*)"'


def attrs(s):
    return dict(re.findall(ATTR, s))


def transform(s):
    try:
        t = [float(x) for x in (s or '').split()]
    except ValueError:
        t = []
    if len(t) != 12:
        return np.eye(4)
    m = np.eye(4)
    m[:3, :3] = np.array(t[:9]).reshape(3, 3)   # row-vector convention
    m[3, :3] = t[9:]
    return m


def norm_colour(c):
    m = re.match(r'#?([0-9a-fA-F]{6})', (c or '').strip().strip('"'))
    return tuple(int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4)) if m else None


def colour_list(v):
    if not v:
        return []
    items = v if isinstance(v, list) else str(v).split(';')
    return [norm_colour(str(x)) for x in items]


def merge(a, b):
    return [(a[i] if i < len(a) else None) or (b[i] if i < len(b) else None) for i in range(max(len(a), len(b)))]


def find_key(node, key):
    if isinstance(node, dict):
        if key in node:
            return node[key]
        node = list(node.values())
    if isinstance(node, list):
        for n in node:
            r = find_key(n, key)
            if r is not None:
                return r
    return None


VERTEX_FAST = r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"'
TRI_FAST = r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"'


def iter_objects(data):
    """Yield (attribute bytes, body bytes) per <object>, without regex-scanning huge meshes."""
    i = 0
    while True:
        s = data.find(b'<object', i)
        if s < 0:
            return
        e = data.find(b'>', s)
        if e < 0:
            return
        head = data[s + 7:e]
        if head[:1] not in (b' ', b'\t', b'\n', b'\r', b'/'):
            i = e + 1
            continue
        if head.endswith(b'/'):
            yield head[:-1], b''
            i = e + 1
            continue
        c = data.find(b'</object>', e)
        if c < 0:
            c = len(data)
        yield head, data[e + 1:c]
        i = c + 9


def parse_model(data):
    objects = {}
    for head, body in iter_objects(data):
        a = attrs(head.decode('utf-8', 'replace'))
        obj = dict(mesh=None, comps=[])
        has_mesh = b'<mesh' in body
        native = parse_mesh_native(body) if has_mesh else None
        if native is not None:
            if len(native[0]) and len(native[1]):
                obj['mesh'] = native
        elif has_mesh:
            text = body.decode('utf-8', 'replace')
            vs = re.findall(VERTEX_FAST, text)
            if not vs:
                vs = [(re.search(r'\bx="([^"]*)"', s).group(1), re.search(r'\by="([^"]*)"', s).group(1),
                       re.search(r'\bz="([^"]*)"', s).group(1)) for s in re.findall(r'<vertex\b([^>]*)>', text)]
            ts = re.findall(TRI_FAST, text)
            if not ts:
                ts = [(re.search(r'\bv1="(\d+)"', s).group(1), re.search(r'\bv2="(\d+)"', s).group(1),
                       re.search(r'\bv3="(\d+)"', s).group(1)) for s in re.findall(r'<triangle\b([^>]*)>', text)]
            if vs and ts:
                obj['mesh'] = (np.array(vs, dtype=np.float64), np.array(ts, dtype=np.int64))
        if b'<component' in body:
            for c in re.finditer(rb'<component\b([^>]*)/?>', body):
                ca = attrs(c.group(1).decode('utf-8', 'replace'))
                obj['comps'].append((ca.get('objectid'), ca.get('p:path'), transform(ca.get('transform'))))
        objects[a.get('id')] = obj
    build = []
    s = data.rfind(b'<build')
    if s >= 0:
        e = data.find(b'</build>', s)
        for it in re.finditer(rb'<item\b([^>]*)/?>', data[s:e if e > 0 else None]):
            ia = attrs(it.group(1).decode('utf-8', 'replace'))
            build.append((ia.get('objectid'), ia.get('p:path'), transform(ia.get('transform'))))
    return objects, build


def load_3mf(path):
    z = zipfile.ZipFile(path)
    names = {n.lower(): n for n in z.namelist()}

    def read(p):
        n = names.get(p.lstrip('/').lower())
        return z.read(n) if n else None

    root_path = '3D/3dmodel.model'
    rels = read('_rels/.rels')
    if rels:
        m = re.search(rb'Target="([^"]+\.model)"', rels, re.I)
        if m:
            root_path = m.group(1).decode().lstrip('/')
    models = {}

    def model(p):
        p = (p or root_path).lstrip('/')
        if p not in models:
            data = read(p)
            models[p] = parse_model(data) if data else ({}, [])
        return models[p]

    objects, build = model(root_path)

    obj_ext, colours, plates, beds = {}, [], None, None
    pj = read('Metadata/PrusaSlicer3_project.json')
    if pj:
        try:
            j = json.loads(pj)
            for o in j.get('objects', []):
                e = (o.get('object_settings') or {}).get('extruder')
                if e:
                    obj_ext[str(o.get('id'))] = e
            colours = merge(colour_list(find_key(j, 'extruder_colour')), colour_list(find_key(j, 'filament_colour')))
            cc = j.get('config_containers')
            cc = cc[0] if isinstance(cc, list) and cc else cc
            if isinstance(cc, dict) and len(cc.get('beds') or []) > 1:
                beds = [(b.get('position_x', 0), b.get('position_y', 0)) for b in cc['beds']]
        except (ValueError, AttributeError):
            pass
    cfg = read('Metadata/Slic3r_PE.config')
    if cfg and not any(colours):
        t = cfg.decode('utf-8', 'replace')
        e = re.search(r'^;\s*extruder_colour\s*=\s*(.*)$', t, re.M)
        f = re.search(r'^;\s*filament_colour\s*=\s*(.*)$', t, re.M)
        colours = merge(colour_list(e and e.group(1)), colour_list(f and f.group(1)))
    pm = read('Metadata/Slic3r_PE_model.config')
    if pm:
        for m in re.finditer(r'<object\b([^>]*)>(.*?)</object>', pm.decode('utf-8', 'replace'), re.S):
            e = re.search(r'type="object"\s+key="extruder"\s+value="(\d+)"', m.group(2))
            if e and int(e.group(1)):
                obj_ext[attrs(m.group(1)).get('id')] = int(e.group(1))
    bm = read('Metadata/model_settings.config')
    if bm:
        t = bm.decode('utf-8', 'replace')
        for m in re.finditer(r'<object\b([^>]*)>(.*?)</object>', t, re.S):
            own = re.sub(r'<part.*?</part>', '', m.group(2), flags=re.S)
            e = re.search(r'key="extruder"\s+value="(\d+)"', own)
            if e and int(e.group(1)):
                obj_ext[attrs(m.group(1)).get('id')] = int(e.group(1))
        pl = []
        for m in re.finditer(r'<plate>(.*?)</plate>', t, re.S):
            members = set()
            for mi in re.finditer(r'<model_instance>(.*?)</model_instance>', m.group(1), re.S):
                o = re.search(r'key="object_id"\s+value="(\d+)"', mi.group(1))
                i = re.search(r'key="instance_id"\s+value="(\d+)"', mi.group(1))
                if o:
                    members.add(f'{o.group(1)}#{i.group(1) if i else 0}')
            pid = re.search(r'key="plater_id"\s+value="(\d+)"', m.group(1))
            pl.append((int(pid.group(1)) if pid else len(pl) + 1, members))
        if pl:
            plates = [m for _, m in sorted(pl, key=lambda p: p[0])]
    pc = read('Metadata/project_settings.config')
    if pc and not any(colours):
        try:
            colours = colour_list(json.loads(pc).get('filament_colour'))
        except ValueError:
            pass

    def emit(out, p, oid, m):
        objs, _ = model(p)
        obj = objs.get(oid)
        if not obj:
            return
        if obj['mesh'] is not None:
            v, f = obj['mesh']
            vh = np.c_[v, np.ones(len(v))] @ m
            ok = (f < len(v)).all(axis=1)
            out.append(vh[:, :3][f[ok]].astype(np.float32))
        for cid, cp, ct in obj['comps']:
            emit(out, cp or p, cid, ct @ m)

    parts, seen = [], {}
    for oid, p, m in build:
        k = seen.get(oid, 0)
        seen[oid] = k + 1
        out = []
        emit(out, p, oid, m)
        if not out:
            continue
        e = obj_ext.get(oid) or 1
        colour = colours[e - 1] if e - 1 < len(colours) else None
        plate = 0
        if plates:
            plate = next((i for i, s in enumerate(plates) if f'{oid}#{k}' in s), 0)
        parts.append(dict(tris=np.concatenate(out), colour=colour, plate=plate))
    if beds and parts:
        for part in parts:
            c = part['tris'].reshape(-1, 3).mean(axis=0)
            d = [((c[0] - x) ** 2 + (c[1] - y) ** 2) + (1e12 if c[0] < x - 1 or c[1] < y - 1 else 0) for x, y in beds]
            part['plate'] = int(np.argmin(d))
    return parts


def load_scad(path, workdir):
    out = os.path.join(workdir, '.oma-peek-scad.stl')
    try:
        subprocess.run(['openscad', '-o', out, path], timeout=60, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(out, 'rb') as f:
            return load_stl(f.read())
    finally:
        if os.path.exists(out):
            os.unlink(out)


# --- software renderer ---------------------------------------------------------

_lib = []


def native_lib():
    """Load the C helpers from memory (the sandbox can't see ~/.local), or None."""
    if _lib:
        return _lib[0]
    import ctypes
    _lib.append(None)
    try:
        if _NATIVE_SO:
            import base64
            import zlib
            fd = os.memfd_create('meshraster', 0)
            os.write(fd, zlib.decompress(base64.b64decode(_NATIVE_SO)))
            lib = ctypes.CDLL(f'/proc/self/fd/{fd}')
        else:
            here = os.path.dirname(os.path.abspath(globals().get('__file__', '')))
            lib = ctypes.CDLL(os.path.join(here, 'libmeshraster.so'))
    except (OSError, AttributeError, ValueError) as e:
        print(f'oma-peek: native helpers unavailable ({e}), using numpy', file=sys.stderr)
        return None
    lib.mp_raster.restype = ctypes.c_int
    lib.mp_raster.argtypes = [ctypes.c_int] + [ctypes.c_void_p] * 4 + [ctypes.c_int, ctypes.c_int] + [ctypes.c_void_p] * 2
    lib.mp_render.restype = ctypes.c_int
    lib.mp_render.argtypes = [ctypes.c_int] + [ctypes.c_void_p] * 3 + [ctypes.c_int] + [ctypes.c_void_p] * 4
    lib.mp_parse_mesh.restype = ctypes.c_int
    lib.mp_parse_mesh.argtypes = [ctypes.c_char_p, ctypes.c_long] + [ctypes.c_void_p] * 4
    _lib[0] = lib
    return lib


def native_raster():
    lib = native_lib()
    return lib.mp_raster if lib else None


def parse_mesh_native(body):
    import ctypes
    lib = native_lib()
    if not lib:
        return None
    raw = body
    nv, nt = ctypes.c_long(), ctypes.c_long()
    lib.mp_parse_mesh(raw, len(raw), None, ctypes.byref(nv), None, ctypes.byref(nt))
    v = np.empty((nv.value, 3), dtype=np.float32)
    t = np.empty((nt.value, 3), dtype=np.int64)
    lib.mp_parse_mesh(raw, len(raw), v.ctypes.data, ctypes.byref(nv), t.ctypes.data, ctypes.byref(nt))
    return v.astype(np.float64), t


def raster_native(fn, px, py, sz, rgb, res):
    xs = np.ascontiguousarray(px, dtype=np.float32)
    ys = np.ascontiguousarray(py, dtype=np.float32)
    zs = np.ascontiguousarray(sz, dtype=np.float32)
    cols = np.ascontiguousarray(rgb, dtype=np.uint8)
    out = np.zeros((res, res, 4), dtype=np.uint8)
    zbuf = np.full(res * res, -np.finfo(np.float32).max, dtype=np.float32)
    fn(len(xs), xs.ctypes.data, ys.ctypes.data, zs.ctypes.data, cols.ctypes.data,
       res, res, out.ctypes.data, zbuf.ctypes.data)
    return out


def lift(rgb):
    """Brighten very dark filament so it reads against a dark file-manager background."""
    r, g, b = (c / 255 for c in rgb)
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if l >= 0.45:
        return rgb
    k = 0.45 - l
    return tuple(min(255, int((c + k) * 255)) for c in (r, g, b))


def render_native(lib, parts, size):
    """Project, shade and rasterise in C (3x supersampled), then downsample."""
    ss = 3
    res = size * ss
    tris = np.ascontiguousarray(np.concatenate([p['tris'] for p in parts]), dtype=np.float32)
    counts = np.array([len(p['tris']) for p in parts], dtype=np.int32)
    colours = np.array([lift(p['colour'] or DEFAULT_COLOUR) for p in parts], dtype=np.uint8)
    view = np.ascontiguousarray(VIEW_DIR, dtype=np.float64)
    light = np.ascontiguousarray(LIGHT, dtype=np.float64)
    out = np.zeros((res, res, 4), dtype=np.uint8)
    zbuf = np.full(res * res, -np.finfo(np.float32).max, dtype=np.float32)
    r = lib.mp_render(len(parts), counts.ctypes.data, colours.ctypes.data, tris.ctypes.data, res,
                      view.ctypes.data, light.ctypes.data, out.ctypes.data, zbuf.ctypes.data)
    if r == -1:
        return None
    if r < 0:
        raise MemoryError('mp_render')
    return downsample(out, size)


def render(parts, size):
    """Orthographic, z-buffered, flat-shaded render via barycentric point sampling."""
    lib = native_lib()
    if lib:
        return render_native(lib, parts, size)
    tris = np.concatenate([p['tris'] for p in parts]).astype(np.float64)
    cols = np.concatenate([np.tile(np.array(lift(p['colour'] or DEFAULT_COLOUR), np.float64), (len(p['tris']), 1))
                           for p in parts])
    d = VIEW_DIR / np.linalg.norm(VIEW_DIR)
    right = np.cross(np.array([0, 0, 1.0]), d)
    right /= np.linalg.norm(right)
    up = np.cross(d, right)

    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    nl = np.linalg.norm(n, axis=1)
    keep = nl > 0
    tris, cols, n = tris[keep], cols[keep], n[keep] / nl[keep, None]
    if not len(tris):
        return None

    light = LIGHT / np.linalg.norm(LIGHT)
    facing = np.where((n @ d)[:, None] < 0, -n, n)            # treat faces as double-sided
    diffuse = np.clip(facing @ light, 0, 1)
    rim = np.clip(facing @ d, 0, 1)
    shade = 0.42 + 0.48 * diffuse + 0.12 * rim
    rgb = np.clip(cols * shade[:, None], 0, 255)

    fn = native_raster()
    ss = 3 if fn else 2
    res = size * ss
    sx, sy, sz = tris @ right, tris @ up, tris @ d
    x0, x1, y0, y1 = sx.min(), sx.max(), sy.min(), sy.max()
    span = max(x1 - x0, y1 - y0) or 1.0
    scale = res * 0.9 / span
    px = (sx - (x0 + x1) / 2) * scale + res / 2
    py = res / 2 - (sy - (y0 + y1) / 2) * scale

    if fn:
        out = raster_native(fn, px, py, sz, rgb, res)
        return downsample(out, size)

    # Sample density per triangle from its longest edge, in pixels.
    e = np.stack([np.hypot(px[:, i] - px[:, (i + 1) % 3], py[:, i] - py[:, (i + 1) % 3]) for i in range(3)], 1)
    levels = np.clip(np.ceil(e.max(1) / 0.7), 1, 600).astype(np.int64)

    zbuf = np.full(res * res, -np.inf)
    img = np.zeros((res * res, 3))

    def samples(sel, s):
        i, j = np.meshgrid(np.arange(s + 1), np.arange(s + 1), indexing='ij')
        mask = i + j <= s
        w1, w2 = i[mask] / s, j[mask] / s
        w0 = 1 - w1 - w2
        X = px[sel, 0, None] * w0 + px[sel, 1, None] * w1 + px[sel, 2, None] * w2
        Y = py[sel, 0, None] * w0 + py[sel, 1, None] * w1 + py[sel, 2, None] * w2
        Z = sz[sel, 0, None] * w0 + sz[sel, 1, None] * w1 + sz[sel, 2, None] * w2
        xi = np.clip(X.astype(np.int64), 0, res - 1)
        yi = np.clip(Y.astype(np.int64), 0, res - 1)
        tri = np.broadcast_to(sel[:, None], X.shape)
        return (yi * res + xi).ravel(), Z.ravel(), tri.ravel()

    groups = []
    for s in np.unique(levels):
        sel = np.nonzero(levels == s)[0]
        # Bound memory: chunk so each batch has <= ~4M samples.
        per = (s + 1) * (s + 2) // 2
        step = max(1, 4_000_000 // per)
        for k in range(0, len(sel), step):
            groups.append((sel[k:k + step], int(s)))
    for sel, s in groups:
        p, z, _ = samples(sel, s)
        np.maximum.at(zbuf, p, z)
    for sel, s in groups:
        p, z, t = samples(sel, s)
        win = z >= zbuf[p]
        img[p[win]] = rgb[t[win]]

    alpha = np.isfinite(zbuf).astype(np.uint8) * 255
    out = np.dstack([img.reshape(res, res, 3).astype(np.uint8), alpha.reshape(res, res)])
    return downsample(out, size)


def downsample(out, size):
    """Premultiplied box filter from the supersampled render (res = size * k) to size."""
    k = out.shape[0] // size
    pre = out[:size * k, :size * k].astype(np.float32)
    pre[..., :3] *= pre[..., 3:] / 255
    small = pre.reshape(size, k, size, k, 4).mean(axis=(1, 3))
    a = small[..., 3:]
    small[..., :3] = np.where(a > 0, small[..., :3] * 255 / np.maximum(a, 1), 0)
    return np.clip(small + 0.5, 0, 255).astype(np.uint8)


def render_plates(parts, size):
    plates = sorted({p['plate'] for p in parts})
    if len(plates) <= 1:
        return render(parts, size)
    cols = math.ceil(math.sqrt(len(plates)))
    rows = math.ceil(len(plates) / cols)
    cell = size // cols
    canvas = np.zeros((size, size, 4), np.uint8)
    top = (size - rows * cell) // 2
    for i, pl in enumerate(plates):
        im = render([p for p in parts if p['plate'] == pl], max(16, cell - 4))
        if im is not None:
            x, y = i % cols * cell + 2, top + i // cols * cell + 2
            h, w = im.shape[:2]
            canvas[y:y + h, x:x + w] = im      # cells don't overlap
    return canvas


def with_background(im):
    """Nautilus draws a checkerboard behind transparent thumbnails; use a soft neutral backdrop."""
    h, w = im.shape[:2]
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    top, bottom = np.array([58, 58, 62], np.float32), np.array([34, 34, 38], np.float32)
    bg = top * (1 - t) + bottom * t
    a = im[..., 3:].astype(np.float32) / 255
    rgb = im[..., :3] * a + bg * (1 - a)
    return np.clip(rgb + 0.5, 0, 255).astype(np.uint8)


def write_png(path, rgb):
    """Minimal 8-bit RGB PNG writer (zlib + struct)."""
    import struct
    import zlib
    h, w = rgb.shape[:2]
    raw = np.zeros((h, w * 3 + 1), np.uint8)          # filter byte 0 per row
    raw[:, 1:] = rgb.reshape(h, w * 3)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw.tobytes(), 6)) + chunk(b'IEND', b''))


def embedded_thumbnail(path, size):
    from PIL import Image
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.lower() in ('metadata/thumbnail.png', 'metadata/plate_1.png'):
                import io
                im = Image.open(io.BytesIO(z.read(n))).convert('RGBA')
                im.thumbnail((size, size))
                return np.asarray(im)
    return None


def main(argv):
    src, dst = argv[1], argv[2]
    size = int(argv[3]) if len(argv) > 3 else 256
    size = max(32, min(size, 1024))
    ext = os.path.splitext(src)[1].lower()
    im = None
    try:
        if ext == '.3mf':
            parts = load_3mf(src)
            im = render_plates(parts, size) if parts else None
        elif ext == '.scad':
            im = render(load_scad(src, os.path.dirname(os.path.abspath(dst))), size)
        else:
            with open(src, 'rb') as f:
                data = f.read()
            parts = load_obj(data) if ext == '.obj' else load_stl(data)
            im = render(parts, size) if parts else None
    except Exception as e:
        print(f'oma-peek: render failed: {e}', file=sys.stderr)
        if ext != '.3mf':
            raise
    if im is None and ext == '.3mf':
        im = embedded_thumbnail(src, size)
    if im is None:
        sys.exit(1)
    write_png(dst, with_background(im))


if __name__ == '__main__':
    main(sys.argv)
