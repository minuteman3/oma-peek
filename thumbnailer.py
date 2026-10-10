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


class _Lazy:
    """Import a module on first use: STL/OBJ thumbnails never need re, json,
    zipfile or subprocess, and every import is paid per thumbnail process."""

    def __init__(self, name, alias=None):
        self._name, self._alias = name, alias or name

    def __getattr__(self, attr):
        import importlib
        mod = importlib.import_module(self._name)
        globals()[self._alias] = mod
        return getattr(mod, attr)


json = _Lazy('json')
re = _Lazy('re')
subprocess = _Lazy('subprocess')
zipfile = _Lazy('zipfile')
np = _Lazy('numpy', 'np')        # binary STL thumbnails never import numpy (~90 ms)

DEFAULT_COLOUR = (185, 192, 200)

# Compressed libmeshraster.so (base64 of zlib), filled in by install.sh.
_NATIVE_SO = None
VIEW_DIR = (0.75, -1.05, 0.62)   # printer coords, Z up: front-right, above
LIGHT = (0.35, -0.55, 0.9)


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


IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)


def transform(s):
    """3MF transform attribute -> 12-tuple (row-vector convention: 3x3, then translation)."""
    try:
        t = tuple(float(x) for x in (s or '').split())
    except ValueError:
        t = ()
    return t if len(t) == 12 else IDENTITY


def compose(a, b):
    """Transform applying a first, then b."""
    c = [0.0] * 12
    for i in range(4):
        for j in range(3):
            v = sum(a[i * 3 + k] * b[k * 3 + j] for k in range(3))
            c[i * 3 + j] = v + (b[9 + j] if i == 3 else 0.0)
    return tuple(c)


def mat4(t):
    m = np.eye(4)
    m[:3, :3] = np.array(t[:9]).reshape(3, 3)
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


def make_find(data):
    """data.find, but long scans go through glibc memmem (~4x faster than bytes.find)."""
    lib = native_lib() if len(data) > (1 << 20) else None
    if not lib:
        return data.find
    import ctypes
    if isinstance(data, bytearray):
        keep = (ctypes.c_char * len(data)).from_buffer(data)
        base = ctypes.addressof(keep)
    else:
        keep = ctypes.c_char_p(data)
        base = ctypes.cast(keep, ctypes.c_void_p).value

    def find(pat, start=0, end=None):
        end = len(data) if end is None else min(end, len(data))
        if end - start < (1 << 16):
            return data.find(pat, start, end)
        return lib.mp_find(base, start, end, pat, len(pat))
    find.keep = keep        # keep the buffer export alive with the closure
    return find


def iter_objects(data, find=None):
    """Yield (attribute bytes, body start, body end) per <object>. Offsets, not
    slices: a mesh body can be ~100 MB and is parsed in place by mp_parse_mesh."""
    find = find or data.find
    i = 0
    while True:
        s = find(b'<object', i)
        if s < 0:
            return
        e = find(b'>', s)
        if e < 0:
            return
        head = data[s + 7:e]
        if head[:1] not in (b' ', b'\t', b'\n', b'\r', b'/'):
            i = e + 1
            continue
        if head.endswith(b'/'):
            yield head[:-1], e + 1, e + 1
            i = e + 1
            continue
        c = find(b'</object>', e)
        if c < 0:
            c = len(data)
        yield head, e + 1, c
        i = c + 9


def parse_model(data):
    objects = {}
    find = make_find(data)
    for head, b0, b1 in iter_objects(data, find):
        a = attrs(head.decode('utf-8', 'replace'))
        obj = dict(mesh=None, comps=[])
        has_mesh = find(b'<mesh', b0, b1) >= 0      # found near the start when present
        native = parse_mesh_native(data, b0, b1) if has_mesh else None
        if native is not None:
            if native.nv and native.nt:
                obj['mesh'] = native
        elif has_mesh:
            text = data[b0:b1].decode('utf-8', 'replace')
            vs = re.findall(VERTEX_FAST, text)
            if not vs:
                vs = [(re.search(r'\bx="([^"]*)"', s).group(1), re.search(r'\by="([^"]*)"', s).group(1),
                       re.search(r'\bz="([^"]*)"', s).group(1)) for s in re.findall(r'<vertex\b([^>]*)>', text)]
            ts = re.findall(TRI_FAST, text)
            if not ts:
                ts = [(re.search(r'\bv1="(\d+)"', s).group(1), re.search(r'\bv2="(\d+)"', s).group(1),
                       re.search(r'\bv3="(\d+)"', s).group(1)) for s in re.findall(r'<triangle\b([^>]*)>', text)]
            if vs and ts:
                obj['mesh'] = (np.array(vs, dtype=np.float32), np.array(ts, dtype=np.int64))
        # A 3MF object holds a mesh or components, never both.
        body = b'' if has_mesh else data[b0:b1]
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


def zip_member(f, info):
    """Read one member's bytes without zipfile's streaming reader and CRC pass
    (~60 ms on a 100 MB model): a thumbnail tolerates a corrupt archive."""
    import struct
    import zlib
    f.seek(info.header_offset)
    hdr = f.read(30)
    if hdr[:4] != b'PK\x03\x04':
        return None
    name_len, extra_len = struct.unpack('<HH', hdr[26:30])
    f.seek(info.header_offset + 30 + name_len + extra_len)
    raw = f.read(info.compress_size)
    if info.compress_type == 0:         # stored
        return raw
    if info.compress_type == 8:         # deflated
        lib = native_lib()
        if lib and info.file_size:
            import ctypes
            out = bytearray(info.file_size)
            buf = (ctypes.c_char * len(out)).from_buffer(out)
            if lib.mp_inflate(raw, len(raw), buf, len(out)) == len(out):
                del buf
                return out
            del buf
        return zlib.decompress(raw, -15, info.file_size or 65536)
    return None


class ZipEntry:
    __slots__ = ('compress_type', 'compress_size', 'file_size', 'header_offset')

    def __init__(self, ctype, csize, size, offset):
        self.compress_type, self.compress_size, self.file_size, self.header_offset = ctype, csize, size, offset


class MiniZip:
    """Just enough of a zip reader for 3MF: the central directory via struct.
    Importing zipfile costs ~35 ms (it pulls in shutil, pathlib, fnmatch, ...).
    Raises ValueError for anything unusual (ZIP64, damage); callers then use zipfile."""

    def __init__(self, path):
        import struct
        self.fp = open(path, 'rb')
        f = self.fp
        f.seek(0, 2)
        size = f.tell()
        tail_len = min(size, 65536 + 22)
        f.seek(size - tail_len)
        tail = f.read(tail_len)
        eocd = tail.rfind(b'PK\x05\x06')
        if eocd < 0 or eocd + 22 > len(tail):
            raise ValueError('no end of central directory')
        count, cd_size, cd_offset = struct.unpack('<HII', tail[eocd + 10:eocd + 20])
        if count == 0xFFFF or cd_offset == 0xFFFFFFFF:
            raise ValueError('zip64')
        f.seek(cd_offset)
        cd = f.read(cd_size)
        self.entries, i = {}, 0
        for _ in range(count):
            if cd[i:i + 4] != b'PK\x01\x02':
                raise ValueError('bad central directory')
            ctype, = struct.unpack('<H', cd[i + 10:i + 12])
            csize, usize, nlen, xlen, clen = struct.unpack('<IIHHH', cd[i + 20:i + 34])
            offset, = struct.unpack('<I', cd[i + 42:i + 46])
            if 0xFFFFFFFF in (csize, usize, offset):
                raise ValueError('zip64')
            name = cd[i + 46:i + 46 + nlen].decode('utf-8', 'replace')
            self.entries[name] = ZipEntry(ctype, csize, usize, offset)
            i += 46 + nlen + xlen + clen

    def namelist(self):
        return list(self.entries)

    def getinfo(self, name):
        return self.entries[name]

    def read(self, name):
        with zipfile.ZipFile(self.fp.name) as z:   # unusual compression: let zipfile handle it
            return z.read(name)


def load_3mf(path):
    try:
        z = MiniZip(path)
    except (ValueError, OSError, IndexError):
        z = zipfile.ZipFile(path)
    names = {n.lower(): n for n in z.namelist()}

    def read(p):
        n = names.get(p.lstrip('/').lower())
        if not n:
            return None
        data = zip_member(z.fp, z.getinfo(n))
        return data if data is not None else z.read(n)

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
        mesh = obj['mesh']
        if isinstance(mesh, RawMesh):
            out.append(emit_native(mesh, m))
        elif mesh is not None:
            v, f = mesh
            m4 = mat4(m)
            # float32 throughout: 3x3 + translation instead of float64 homogeneous coords.
            vt = v @ m4[:3, :3].astype(np.float32) + m4[3, :3].astype(np.float32)
            if f.size and f.max() >= len(v):
                f = f[(f < len(v)).all(axis=1)]
            out.append(np.take(vt, f, axis=0))
        for cid, cp, ct in obj['comps']:
            emit(out, cp or p, cid, compose(ct, m))

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
        if all(isinstance(o, RawTris) for o in out):
            tris = RawTris([c for o in out for c in o.chunks])     # no copies
        else:
            tris = np.concatenate([o.array() if isinstance(o, RawTris) else o for o in out])
        parts.append(dict(tris=tris, colour=colour, plate=plate))
    if beds and parts:
        for part in parts:
            t = part['tris']
            c = (t.array() if isinstance(t, RawTris) else t).reshape(-1, 3).mean(axis=0)
            d = [((c[0] - x) ** 2 + (c[1] - y) ** 2) + (1e12 if c[0] < x - 1 or c[1] < y - 1 else 0) for x, y in beds]
            part['plate'] = int(np.argmin(d))
    return parts


def scad_to_stl(path, workdir):
    """Render with OpenSCAD to binary STL bytes (binary so the C STL path can take it)."""
    out = os.path.join(workdir, '.oma-peek-scad.stl')
    try:
        subprocess.run(['openscad', '--export-format', 'binstl', '-o', out, path], timeout=60, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(out, 'rb') as f:
            return f.read()
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
    try:
        lib.mp_raster.restype = ctypes.c_int
        lib.mp_raster.argtypes = [ctypes.c_int] + [ctypes.c_void_p] * 4 + [ctypes.c_int, ctypes.c_int] + [ctypes.c_void_p] * 2
        lib.mp_render.restype = ctypes.c_int
        lib.mp_render.argtypes = [ctypes.c_int] + [ctypes.c_void_p] * 3 + [ctypes.c_int] + [ctypes.c_void_p] * 4
        lib.mp_parse_mesh.restype = ctypes.c_int
        lib.mp_parse_mesh.argtypes = [ctypes.c_void_p, ctypes.c_long] + [ctypes.c_void_p] * 4
        lib.mp_downsample.restype = None
        lib.mp_downsample.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        lib.mp_thumb_stl.restype = ctypes.c_int
        lib.mp_thumb_stl.argtypes = [ctypes.c_void_p, ctypes.c_long] + [ctypes.c_void_p] * 1 + [ctypes.c_int] + [ctypes.c_void_p] * 3
        lib.mp_render_rgba.restype = ctypes.c_int
        lib.mp_render_rgba.argtypes = [ctypes.c_int] + [ctypes.c_void_p] * 3 + [ctypes.c_int] + [ctypes.c_void_p] * 3
        lib.mp_render_rgba_parts.restype = ctypes.c_int
        lib.mp_render_rgba_parts.argtypes = [ctypes.c_int] + [ctypes.c_void_p] * 3 + [ctypes.c_int] + [ctypes.c_void_p] * 3
        lib.mp_backdrop.restype = None
        lib.mp_backdrop.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        lib.mp_emit.restype = ctypes.c_long
        lib.mp_emit.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
        lib.mp_find.restype = ctypes.c_long
        lib.mp_find.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.c_long, ctypes.c_char_p, ctypes.c_long]
        lib.mp_inflate.restype = ctypes.c_long
        lib.mp_inflate.argtypes = [ctypes.c_char_p, ctypes.c_long, ctypes.c_void_p, ctypes.c_long]
    except AttributeError as e:    # stale or partial library: use the numpy path
        print(f'oma-peek: native helpers incomplete ({e}), using numpy', file=sys.stderr)
        return None
    _lib[0] = lib
    return lib


def native_raster():
    lib = native_lib()
    return lib.mp_raster if lib else None


class RawMesh:
    """Mesh parsed by C: vertices as float32 x,y,z and triangles as int64 indices, in bytearrays."""
    __slots__ = ('v', 'nv', 't', 'nt')

    def __init__(self, v, nv, t, nt):
        self.v, self.nv, self.t, self.nt = v, nv, t, nt


class RawTris:
    """Triangles as packed float32 (9 per triangle), kept as separate chunks
    (one per mesh) so nothing is ever concatenated on the native path."""
    __slots__ = ('chunks', 'n')

    def __init__(self, chunks):
        self.chunks = [(buf, n) for buf, n in chunks if n]   # (bytes-like, triangle count)
        self.n = sum(n for _, n in self.chunks)

    def __len__(self):
        return self.n

    def array(self):
        arrays = [np.frombuffer(buf, np.float32, n * 9).reshape(-1, 3, 3) for buf, n in self.chunks]
        return np.concatenate(arrays) if len(arrays) != 1 else arrays[0]


def emit_native(mesh, m):
    import ctypes
    lib = native_lib()
    out = bytearray(mesh.nt * 36)
    vb = (ctypes.c_char * len(mesh.v)).from_buffer(mesh.v)
    tb = (ctypes.c_char * len(mesh.t)).from_buffer(mesh.t)
    ob = (ctypes.c_char * len(out)).from_buffer(out)
    w = lib.mp_emit(vb, mesh.nv, tb, mesh.nt, (ctypes.c_double * 12)(*m), ob)
    del vb, tb, ob
    return RawTris([(out, w)])


def parse_mesh_native(data, b0, b1):
    """Parse data[b0:b1] in place (no copy) with mp_parse_mesh."""
    import ctypes
    lib = native_lib()
    if not lib:
        return None
    if isinstance(data, bytearray):     # from mp_inflate
        keep = (ctypes.c_char * len(data)).from_buffer(data)
        base = ctypes.addressof(keep)
    else:
        keep = ctypes.c_char_p(data)    # points at the bytes object's own buffer
        base = ctypes.cast(keep, ctypes.c_void_p).value
    ptr, n = base + b0, b1 - b0
    nv, nt = ctypes.c_long(), ctypes.c_long()
    lib.mp_parse_mesh(ptr, n, None, ctypes.byref(nv), None, ctypes.byref(nt))
    v = bytearray(nv.value * 12)
    t = bytearray(nt.value * 24)
    vb = (ctypes.c_char * len(v)).from_buffer(v) if v else None
    tb = (ctypes.c_char * len(t)).from_buffer(t) if t else None
    lib.mp_parse_mesh(ptr, n, vb, ctypes.byref(nv), tb, ctypes.byref(nt))
    del keep, vb, tb
    return RawMesh(v, nv.value, t, nt.value)


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
    lib = native_lib()
    if lib and out.flags['C_CONTIGUOUS'] and out.shape[0] == size * k:
        dst = np.empty((size, size, 4), np.uint8)
        lib.mp_downsample(out.ctypes.data, size, k, dst.ctypes.data)
        return dst
    pre = out[:size * k, :size * k].astype(np.float32)
    pre[..., :3] *= pre[..., 3:] / 255
    small = pre.reshape(size, k, size, k, 4).mean(axis=(1, 3))
    a = small[..., 3:]
    small[..., :3] = np.where(a > 0, small[..., :3] * 255 / np.maximum(a, 1), 0)
    return np.clip(small + 0.5, 0, 255).astype(np.uint8)


def render_plates(parts, size):
    if any(isinstance(p['tris'], RawTris) for p in parts):
        parts = [dict(p, tris=p['tris'].array()) if isinstance(p['tris'], RawTris) else p for p in parts]
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


def write_png_rows(path, raw, w, h):
    """PNG from ready-made scanlines (filter byte + RGB per row)."""
    import struct
    import zlib

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data))
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))


def thumb_parts_native(parts, size, dst):
    """3MF parts (RawTris) -> PNG in C, plate grid included; no numpy. False if not applicable."""
    import ctypes
    lib = native_lib()
    if not lib or not all(isinstance(p['tris'], RawTris) for p in parts):
        return False
    view, light = (ctypes.c_double * 3)(*VIEW_DIR), (ctypes.c_double * 3)(*LIGHT)

    def render_rgba(group, cell):
        # Every mesh chunk is its own part to C, carrying its object's colour: no joins.
        chunks = [(buf, n, lift(p['colour'] or DEFAULT_COLOUR)) for p in group for buf, n in p['tris'].chunks]
        if not chunks:
            return None
        views = [(ctypes.c_char * len(buf)).from_buffer(buf) if isinstance(buf, bytearray) else buf
                 for buf, _, _ in chunks]
        ptrs = (ctypes.c_void_p * len(chunks))(*[ctypes.addressof(v) if not isinstance(v, bytes)
                                                 else ctypes.cast(ctypes.c_char_p(v), ctypes.c_void_p).value
                                                 for v in views])
        counts = (ctypes.c_int * len(chunks))(*[n for _, n, _ in chunks])
        cols = (ctypes.c_uint8 * (3 * len(chunks)))(*[c for _, _, col in chunks for c in col])
        rgba = bytearray(cell * cell * 4)
        buf = (ctypes.c_char * len(rgba)).from_buffer(rgba)
        r = lib.mp_render_rgba_parts(len(chunks), counts, cols, ptrs, cell, view, light, buf)
        del buf, views
        if r == -2:
            raise MemoryError('mp_render_rgba')
        return rgba if r == 0 else None

    plates = sorted({p['plate'] for p in parts})
    if len(plates) <= 1:
        canvas = render_rgba(parts, size)
        if canvas is None:
            return False
    else:
        cols_n = math.ceil(math.sqrt(len(plates)))
        rows_n = math.ceil(len(plates) / cols_n)
        cell = size // cols_n
        top = (size - rows_n * cell) // 2
        canvas = bytearray(size * size * 4)
        cs = max(16, cell - 4)
        for i, pl in enumerate(plates):
            im = render_rgba([p for p in parts if p['plate'] == pl], cs)
            if im is None:
                continue
            x, y = i % cols_n * cell + 2, top + i // cols_n * cell + 2
            for row in range(cs):      # cells don't overlap
                o = ((y + row) * size + x) * 4
                canvas[o:o + cs * 4] = im[row * cs * 4:(row + 1) * cs * 4]
    raw = bytearray(size * (1 + 3 * size))
    cbuf = (ctypes.c_char * len(canvas)).from_buffer(canvas)
    rbuf = (ctypes.c_char * len(raw)).from_buffer(raw)
    lib.mp_backdrop(cbuf, size, rbuf)
    del cbuf, rbuf
    write_png_rows(dst, raw, size, size)
    return True


def thumb_stl_mapped(path, size, dst):
    """Binary STL fast path on a copy-on-write mapping: no 50 MB read into a bytes object."""
    import ctypes
    import mmap
    try:
        with open(path, 'rb') as f:
            m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_COPY)
    except (OSError, ValueError):
        return False
    try:
        buf = (ctypes.c_char * len(m)).from_buffer(m)
        try:
            return thumb_stl_native(buf, size, dst)
        finally:
            del buf
    finally:
        m.close()


def thumb_stl_native(data, size, dst):
    """Binary STL -> PNG entirely in C plus zlib; False if the fast path doesn't apply."""
    import ctypes
    lib = native_lib()
    if not lib:
        return False
    raw = bytearray(size * (1 + 3 * size))
    buf = (ctypes.c_char * len(raw)).from_buffer(raw)
    colour = (ctypes.c_uint8 * 3)(*lift(DEFAULT_COLOUR))
    view, light = (ctypes.c_double * 3)(*VIEW_DIR), (ctypes.c_double * 3)(*LIGHT)
    r = lib.mp_thumb_stl(data, len(data), colour, size, view, light, buf)
    del buf
    if r != 0:
        return False
    write_png_rows(dst, raw, size, size)
    return True


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
            if parts and thumb_parts_native(parts, size, dst):
                return
            im = render_plates(parts, size) if parts else None
        elif ext == '.scad':
            data = scad_to_stl(src, os.path.dirname(os.path.abspath(dst)))
            if thumb_stl_native(data, size, dst):
                return
            im = render(load_stl(data), size)
        else:
            if ext == '.stl' and thumb_stl_mapped(src, size, dst):
                return
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
