#!/usr/bin/env python3
"""Generate small model fixtures with known geometry, plus manifest.json of expectations.

usage: python3 -I tests/fixtures/models.py OUT_DIR

Every expected value is derived from the parameters used to write the file (box sizes,
offsets, names, colours), never from oma-peek's own loaders.
"""
import json, math, os, struct, sys, zipfile

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
cases = []


def box(sx, sy, sz, ox=0.0, oy=0.0, oz=0.0):
    """12 triangles of an axis-aligned box [o, o+s]."""
    v = [(ox + x, oy + y, oz + z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris = []
    for a, b, c, d in quads:
        tris += [(v[a], v[b], v[c]), (v[a], v[c], v[d])]
    return tris


def bbox(sx, sy, sz, ox=0.0, oy=0.0, oz=0.0):
    return [[ox, oy, oz], [ox + sx, oy + sy, oz + sz]]


def write_stl_binary(name, tris, count=None):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(b'\0' * 80 + struct.pack('<I', len(tris) if count is None else count))
        for t in tris:
            f.write(struct.pack('<3f', 0, 0, 0) + b''.join(struct.pack('<3f', *p) for p in t) + b'\0\0')


def write_text(name, text):
    with open(os.path.join(OUT, name), 'w') as f:
        f.write(text)


def stl_ascii(tris, extra_vertices=()):
    out = ['solid fixture']
    for t in tris:
        out += ['facet normal 0 0 0', 'outer loop']
        out += [f'vertex {x:g} {y:g} {z:g}' for x, y, z in t]
        out += ['endloop', 'endfacet']
    if extra_vertices:
        out += ['facet normal 0 0 0', 'outer loop'] + [f'vertex {x:g} {y:g} {z:g}' for x, y, z in extra_vertices]
    out.append('endsolid fixture')
    return '\n'.join(out) + '\n'


def indexed(tris):
    verts, index, faces = [], {}, []
    for t in tris:
        face = []
        for p in t:
            if p not in index:
                index[p] = len(verts)
                verts.append(p)
            face.append(index[p])
        faces.append(face)
    return verts, faces


def model_xml(objects, build, resources_extra=''):
    """objects: [(id, name, tris, triangle_attrs(i) -> str)], build: [(objectid, dx, dy)]."""
    res = [resources_extra]
    for oid, name, tris, tri_attr in objects:
        verts, faces = indexed(tris)
        v = ''.join(f'<vertex x="{x:g}" y="{y:g}" z="{z:g}"/>' for x, y, z in verts)
        t = ''.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"{tri_attr(i)}/>' for i, (a, b, c) in enumerate(faces))
        res.append(f'<object id="{oid}" name="{name}" type="model"><mesh><vertices>{v}</vertices>'
                   f'<triangles>{t}</triangles></mesh></object>')
    items = ''.join(f'<item objectid="{o}" transform="1 0 0 0 1 0 0 0 1 {x:g} {y:g} 0"/>' for o, x, y in build)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" '
            'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
            f'<resources>{"".join(res)}</resources><build>{items}</build></model>')


def write_3mf(name, model, metadata=None):
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(os.path.join(OUT, name), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('_rels/.rels', rels)
        z.writestr('3D/3dmodel.model', model)
        for path, data in (metadata or {}).items():
            z.writestr(path, data)


def no_attr(_):
    return ''


def part(name, tris, box_, plate=0, colour=None, tri_colours=False):
    return {'name': name, 'tris': tris, 'bbox': box_, 'plate': plate, 'colour': colour, 'triColours': tri_colours}


# --- STL ---------------------------------------------------------------------------------

B = (20.0, 10.0, 5.0)
write_stl_binary('box-binary.stl', box(*B))
write_text('box-ascii.stl', stl_ascii(box(*B)))
for f in ('box-binary.stl', 'box-ascii.stl'):
    cases.append({'file': f, 'ext': 'stl', 'yUp': False, 'plates': ['Model'],
                  'parts': [part(None, 12, bbox(*B))]})

# Malformed or empty STL must be rejected, not shown as an empty scene.
write_text('garbage.stl', 'not an STL file at all\n')
write_text('empty-ascii.stl', 'solid empty\nendsolid empty\n')
write_stl_binary('empty-binary.stl', [])
write_text('incomplete-ascii.stl', stl_ascii(box(*B)[:1], extra_vertices=[(1, 2, 3)]))
nan_tris = box(*B)
nan_tris[3] = ((math.nan, 0.0, 0.0),) + nan_tris[3][1:]
write_stl_binary('nan-binary.stl', nan_tris)
cases += [
    {'file': 'garbage.stl', 'ext': 'stl', 'error': 'no geometry'},
    {'file': 'empty-ascii.stl', 'ext': 'stl', 'error': 'no geometry'},
    {'file': 'empty-binary.stl', 'ext': 'stl', 'error': 'no geometry'},
    {'file': 'incomplete-ascii.stl', 'ext': 'stl', 'error': 'malformed'},
    {'file': 'nan-binary.stl', 'ext': 'stl', 'error': 'malformed'},
]

# Binary STLs as found in the wild: header count of 0 (streaming exporters), padding after
# the last record, a header promising more records than the file holds (truncated download),
# and a binary file whose 80-byte header starts with "solid". All are read by their whole
# 50-byte records; a truncated file is shown with a warning.
def stl_binary_bytes(tris, count, header=b'', tail=b''):
    body = b''.join(struct.pack('<3f', 0, 0, 0) + b''.join(struct.pack('<3f', *p) for p in t) + b'\0\0'
                    for t in tris)
    return header.ljust(80, b' ') + struct.pack('<I', count) + body + tail

def write_bytes(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data)

write_bytes('count-zero.stl', stl_binary_bytes(box(*B), 0))
write_bytes('padded.stl', stl_binary_bytes(box(*B), 12, tail=b'\0' * 7))
write_bytes('truncated.stl', stl_binary_bytes(box(*B), 20))          # 12 records present
write_bytes('solid-header-binary.stl', stl_binary_bytes(box(*B), 12, header=b'solid exported by CAD'))
write_text('crlf-ascii.stl', stl_ascii(box(*B)).replace('\n', '\r\n'))
for f in ('count-zero.stl', 'padded.stl', 'solid-header-binary.stl', 'crlf-ascii.stl'):
    cases.append({'file': f, 'ext': 'stl', 'yUp': False, 'plates': ['Model'],
                  'parts': [part(None, 12, bbox(*B))]})
cases.append({'file': 'truncated.stl', 'ext': 'stl', 'yUp': False, 'plates': ['Model'],
              'parts': [part(None, 12, bbox(*B))], 'warning': 'truncated'})
# Plain text that is not an STL must not be read as binary records.
write_text('notes.stl', 'These are my notes about a print. ' * 20)
cases.append({'file': 'notes.stl', 'ext': 'stl', 'error': 'no geometry'})

# --- OBJ (+ mtl), quads fan-triangulated, two named groups -------------------------------

def obj_box(sx, sy, sz, ox, oy, oz, base):
    v = [(ox + x, oy + y, oz + z) for x in (0, sx) for y in (0, sy) for z in (0, sz)]
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return ([f'v {x:g} {y:g} {z:g}' for x, y, z in v],
            ['f ' + ' '.join(str(base + i + 1) for i in q) for q in quads])

va, fa = obj_box(4, 6, 8, 0, 0, 0, 0)
vb, fb = obj_box(2, 2, 2, 10, 0, 0, 8)
write_text('two-groups.mtl', 'newmtl red\nKd 1 0 0\nnewmtl blue\nKd 0 0 1\n')
write_text('two-groups.obj', '\n'.join(['mtllib two-groups.mtl'] + va + vb +
                                       ['o Tall', 'usemtl red'] + fa + ['o Cube', 'usemtl blue'] + fb) + '\n')
cases.append({'file': 'two-groups.obj', 'ext': 'obj', 'yUp': True, 'plates': ['Model'], 'parts': [
    part('Tall', 12, bbox(4, 6, 8), colour='#ff0000'),
    part('Cube', 12, bbox(2, 2, 2, 10, 0, 0), colour='#0000ff'),
]})

# --- 3MF ---------------------------------------------------------------------------------

# Generic: names from <object name>, translation from the build item, one plate.
write_3mf('generic.3mf', model_xml(
    [(1, 'Left', box(10, 10, 10), no_attr), (2, 'Right', box(5, 5, 20), no_attr)],
    [(1, 0, 0), (2, 30, 0)]))
cases.append({'file': 'generic.3mf', 'ext': '3mf', 'yUp': False, 'plates': ['Plate 1'], 'parts': [
    part('Left', 12, bbox(10, 10, 10)),
    part('Right', 12, bbox(5, 5, 20, 30, 0, 0)),
]})

# Bambu/Orca: names, extruders and plates from Metadata/model_settings.config, filament
# colours from Metadata/project_settings.config. Object 3 (instance of 1) lands on plate 2.
bambu_settings = '\n'.join([
    '<?xml version="1.0" encoding="UTF-8"?>', '<config>',
    '<object id="1"><metadata key="name" value="Rook"/><metadata key="extruder" value="1"/></object>',
    '<object id="2"><metadata key="name" value="Pawn"/><metadata key="extruder" value="2"/></object>',
    '<plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="White"/>',
    '<model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance>',
    '</plate>',
    '<plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Black"/>',
    '<model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>',
    '</plate>', '</config>'])
write_3mf('bambu-plates.3mf', model_xml(
    [(1, 'obj1', box(8, 8, 16), no_attr), (2, 'obj2', box(6, 6, 10), no_attr)],
    [(1, 0, 0), (2, 200, 0)]),
    {'Metadata/model_settings.config': bambu_settings,
     'Metadata/project_settings.config': json.dumps({'filament_colour': ['#FF0000', '#00FF00']})})
cases.append({'file': 'bambu-plates.3mf', 'ext': '3mf', 'yUp': False, 'plates': ['White', 'Black'], 'parts': [
    part('Rook', 12, bbox(8, 8, 16), plate=0, colour='#ff0000'),
    part('Pawn', 12, bbox(6, 6, 10, 200, 0, 0), plate=1, colour='#00ff00'),
]})

# PrusaSlicer multi-bed: beds from PrusaSlicer3_project.json, objects assigned by position.
prusa = {'objects': [], 'config_containers': [{'beds': [{'position_x': 0, 'position_y': 0},
                                                        {'position_x': 300, 'position_y': 0}]}]}
write_3mf('prusa-beds.3mf', model_xml(
    [(1, 'A', box(10, 10, 10), no_attr), (2, 'B', box(10, 10, 10), no_attr)],
    [(1, 50, 50), (2, 350, 50)]),
    {'Metadata/PrusaSlicer3_project.json': json.dumps(prusa)})
cases.append({'file': 'prusa-beds.3mf', 'ext': '3mf', 'yUp': False, 'plates': ['Bed 1', 'Bed 2'], 'parts': [
    part('A', 12, bbox(10, 10, 10, 50, 50, 0), plate=0),
    part('B', 12, bbox(10, 10, 10, 350, 50, 0), plate=1),
]})

# Per-triangle colours from a basematerials group: first half red, second half blue.
mats = ('<basematerials id="9"><base name="red" displaycolor="#FF0000FF"/>'
        '<base name="blue" displaycolor="#0000FFFF"/></basematerials>')
write_3mf('tri-colours.3mf', model_xml(
    [(1, 'Painted', box(10, 10, 10), lambda i: f' pid="9" p1="{0 if i < 6 else 1}"')],
    [(1, 0, 0)], resources_extra=mats))
cases.append({'file': 'tri-colours.3mf', 'ext': '3mf', 'yUp': False, 'plates': ['Plate 1'], 'parts': [
    part('Painted', 12, bbox(10, 10, 10), tri_colours=True),
]})

# A 3MF whose model has no geometry but carries the slicer's embedded preview image: the
# viewer reports no geometry; the thumbnailer falls back to the embedded image.
def png(w, h, rgb):
    """White image with a centred square of rgb (slicer previews are a few hundred px)."""
    import zlib
    def px(x, y):
        inside = w // 4 <= x < 3 * w // 4 and h // 4 <= y < 3 * h // 4
        return bytes(rgb) if inside else b'\xff\xff\xff'
    raw = b''.join(b'\0' + b''.join(px(x, y) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))

write_3mf('thumb-only.3mf', model_xml([], []), {'Metadata/thumbnail.png': png(300, 300, (200, 30, 30))})
cases.append({'file': 'thumb-only.3mf', 'ext': '3mf', 'error': 'no geometry'})

# --- MPK (oma-peek-cad output) -------------------------------------------------------------

def mpk(name, parts):
    head = json.dumps({'parts': [{'name': n, 'color': c, 'n': len(t)} for n, c, t in parts]}).encode()
    body = b''.join(struct.pack('<9f', *(c for p in tri for c in p)) for _, _, t in parts for tri in t)
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(b'MPK1' + struct.pack('<I', len(head)) + head + body)

mpk('assembly.mpk', [('Body', '#112233', box(10, 20, 30)), ('Body', None, box(1, 1, 1, 50, 0, 0))])
cases.append({'file': 'assembly.mpk', 'ext': 'mpk', 'yUp': False, 'plates': ['Model'], 'parts': [
    part('Body', 12, bbox(10, 20, 30), colour='#112233'),
    part('Body (2)', 12, bbox(1, 1, 1, 50, 0, 0)),
]})

# Malformed MPK: header not JSON; header promising triangles that are missing.
def raw(name, data):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(data)

raw('bad-header.mpk', b'MPK1' + struct.pack('<I', 5) + b'{bad}')
head = json.dumps({'parts': [{'name': 'Body', 'color': None, 'n': 12}]}).encode()
raw('truncated.mpk', b'MPK1' + struct.pack('<I', len(head)) + head + b'\0' * 36)
raw('nan.mpk', b'MPK1' + struct.pack('<I', len(head)) + head + struct.pack('<f', math.nan) * 108)
cases += [
    {'file': 'nan.mpk', 'ext': 'mpk', 'error': 'non-finite'},
    {'file': 'bad-header.mpk', 'ext': 'mpk', 'error': 'malformed mpk'},
    {'file': 'truncated.mpk', 'ext': 'mpk', 'error': 'malformed mpk'},
]

with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
    json.dump(cases, f, indent=1)
print(f'{len(cases)} fixture cases in {OUT}')
