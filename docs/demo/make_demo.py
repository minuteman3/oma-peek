#!/usr/bin/env python3
"""Build the demo models used for the README screenshots.

usage: docs/demo/make_demo.py OUT_DIR

Needs openscad. The STEP/IGES assembly also needs OpenCASCADE headers (it builds
bench/e2e/make_cad_corpus.cpp); it is skipped if that fails. Everything is generated
from scratch, so the screenshots can be reproduced and redistributed.
"""
import json, math, os, struct, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
TMP = tempfile.mkdtemp(prefix='oma-peek-demo-')

SCAD = {
    'vase': '''
        linear_extrude(height=110, twist=140, slices=160, scale=1.35, convexity=6)
            offset(r=4) offset(delta=-4)
                for (i = [0:5]) rotate(i * 60) translate([12, 0]) circle(r=14, $fn=48);''',
    'gear': '''
        // Spur gear with lightening holes
        $fn = 96;
        teeth = 24; r = 38; h = 8;
        difference() {
            union() {
                cylinder(r=r, h=h);
                for (i = [0:teeth-1]) rotate(i * 360 / teeth)
                    translate([r - 1, 0, 0]) linear_extrude(h)
                        polygon([[0, -3.2], [6, -1.6], [6, 1.6], [0, 3.2]]);
                cylinder(r=12, h=h + 6);
            }
            translate([0, 0, -1]) cylinder(r=5, h=h + 8);
            for (i = [0:5]) rotate(i * 60) translate([24, 0, -1]) cylinder(r=7, h=h + 2);
        }''',
    'rook': '''
        $fn = 96;
        difference() {
            rotate_extrude() polygon([[0,0],[16,0],[16,4],[13,7],[11,9],[9,30],[12,34],[12,46],[0,46]]);
            translate([0, 0, 40]) cylinder(r=8, h=10);
            for (i = [0:3]) rotate(i * 90 + 45) translate([0, -2, 40]) cube([20, 4, 10]);
        }''',
    'pawn': '''
        $fn = 96;
        rotate_extrude() polygon([[0,0],[13,0],[13,3],[10,6],[7,9],[5,22],[8,24],[0,24]]);
        translate([0, 0, 30]) sphere(r=8);''',
    'planter': '''
        $fn = 6;
        difference() {
            cylinder(r1=34, r2=44, h=70);
            translate([0, 0, 4]) cylinder(r1=30, r2=40.5, h=70);
            translate([0, 0, -1]) cylinder(r=5, h=8, $fn=32);
        }''',
    'saucer': '''
        $fn = 6;
        translate([0, 0, -8]) difference() {
            cylinder(r=50, h=8);
            translate([0, 0, 2]) cylinder(r=46, h=8);
        }''',
    'stem': '$fn = 64; cylinder(r1=9, r2=7, h=34);',
    'cap': '''
        $fn = 96;
        translate([0, 0, 30]) difference() {
            scale([1, 1, 0.62]) sphere(r=30);
            translate([0, 0, -40]) cube(80, center=true);
        }''',
    'spots': '''
        $fn = 32;
        for (p = [[0, 0, 48.6], [14, 6, 45.2], [-10, 13, 45.4], [-6, -15, 45], [20, -9, 41], [-21, -4, 41.5]])
            translate(p) scale([1, 1, 0.5]) sphere(r=4.5);''',
}


def scad_tris(name):
    """Mesh one SCAD snippet with OpenSCAD; returns a list of (v0, v1, v2) tuples."""
    src = os.path.join(TMP, name + '.scad')
    stl = os.path.join(TMP, name + '.stl')
    open(src, 'w').write(SCAD[name])
    subprocess.run(['openscad', '-q', '--export-format', 'binstl', '-o', stl, src], check=True)
    data = open(stl, 'rb').read()
    n = struct.unpack_from('<I', data, 80)[0]
    tris = []
    for i in range(n):
        f = struct.unpack_from('<12f', data, 84 + 50 * i)
        tris.append((f[3:6], f[6:9], f[9:12]))
    return tris


def indexed(tris):
    verts, index, faces = [], {}, []
    for t in tris:
        face = []
        for v in t:
            k = tuple(round(c, 4) for c in v)
            if k not in index:
                index[k] = len(verts)
                verts.append(k)
            face.append(index[k])
        faces.append(face)
    return verts, faces


def write_3mf(path, objects, items, model_settings, filament_colours):
    """objects: [(id, name, tris)]; items: [(object_id, x, y)] build items."""
    res = []
    for oid, name, tris in objects:
        verts, faces = indexed(tris)
        v = ''.join(f'<vertex x="{x:g}" y="{y:g}" z="{z:g}"/>' for x, y, z in verts)
        t = ''.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in faces)
        res.append(f'<object id="{oid}" name="{name}" type="model"><mesh><vertices>{v}</vertices>'
                   f'<triangles>{t}</triangles></mesh></object>')
    build = ''.join(f'<item objectid="{o}" transform="1 0 0 0 1 0 0 0 1 {x:g} {y:g} 0"/>' for o, x, y in items)
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             f'<resources>{"".join(res)}</resources><build>{build}</build></model>')
    types = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', types)
        z.writestr('_rels/.rels', rels)
        z.writestr('3D/3dmodel.model', model)
        z.writestr('Metadata/model_settings.config', model_settings)
        z.writestr('Metadata/project_settings.config', json.dumps({'filament_colour': filament_colours}))


def bambu_config(objects, plates):
    """objects: [(id, name, extruder)]; plates: [(name, [(object_id, instance_id)])]."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>']
    for oid, name, ext in objects:
        out.append(f'<object id="{oid}"><metadata key="name" value="{name}"/>'
                   f'<metadata key="extruder" value="{ext}"/></object>')
    for i, (name, inst) in enumerate(plates, 1):
        out.append(f'<plate><metadata key="plater_id" value="{i}"/><metadata key="plater_name" value="{name}"/>')
        out += [f'<model_instance><metadata key="object_id" value="{o}"/>'
                f'<metadata key="instance_id" value="{n}"/></model_instance>' for o, n in inst]
        out.append('</plate>')
    out.append('</config>')
    return '\n'.join(out)


def write_stl(path, tris):
    with open(path, 'wb') as f:
        f.write(b'oma-peek demo'.ljust(80, b' ') + struct.pack('<I', len(tris)))
        for t in tris:
            f.write(struct.pack('<12fH', 0, 0, 0, *t[0], *t[1], *t[2], 0))


def torus_knot_obj(path, p=2, q=3, R=30, r=11, tube=5.5, n=480, m=24):
    """Tube swept along a (p, q) torus knot, written as an OBJ (Z up, mm)."""
    def curve(t):
        c = R + r * math.cos(q * t)
        return (c * math.cos(p * t), c * math.sin(p * t), r * math.sin(q * t))
    sub = lambda a, b: tuple(x - y for x, y in zip(a, b))
    cross = lambda a, b: (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])
    unit = lambda a: tuple(x / math.sqrt(sum(y * y for y in a)) for x in a)
    lines = ['# oma-peek demo: (2,3) torus knot']
    for i in range(n):
        t = 2 * math.pi * i / n
        c, nxt = curve(t), curve(t + 1e-3)
        tan = unit(sub(nxt, c))
        nrm = unit(cross(tan, (0, 0, 1)))
        bin_ = cross(tan, nrm)
        for j in range(m):
            a = 2 * math.pi * j / m
            v = tuple(c[k] + tube * (math.cos(a) * nrm[k] + math.sin(a) * bin_[k]) for k in range(3))
            lines.append('v %.4f %.4f %.4f' % (v[0], v[1], v[2] + r + tube))
    for i in range(n):
        for j in range(m):
            a = i * m + j + 1
            b = ((i + 1) % n) * m + j + 1
            c = ((i + 1) % n) * m + (j + 1) % m + 1
            d = i * m + (j + 1) % m + 1
            lines.append(f'f {a} {b} {c} {d}')
    open(path, 'w').write('\n'.join(lines) + '\n')


def write_glb(path, parts):
    """parts: [(name, tris, (r, g, b))]; glTF is Y-up metres, so convert from Z-up mm."""
    blob, meshes, nodes, accessors, views, materials = b'', [], [], [], [], []
    for i, (name, tris, rgb) in enumerate(parts):
        flat = [c for t in tris for x, y, z in t for c in (x / 1000, z / 1000, -y / 1000)]
        lo = [min(flat[k::3]) for k in range(3)]
        hi = [max(flat[k::3]) for k in range(3)]
        data = struct.pack(f'<{len(flat)}f', *flat)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
        blob += data
        accessors.append({'bufferView': i, 'componentType': 5126, 'count': len(flat) // 3,
                          'type': 'VEC3', 'min': lo, 'max': hi})
        materials.append({'name': name, 'pbrMetallicRoughness': {'baseColorFactor': [*rgb, 1],
                                                                 'metallicFactor': 0, 'roughnessFactor': 0.8}})
        meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': i}, 'material': i}]})
        nodes.append({'name': name, 'mesh': i})
    doc = {'asset': {'version': '2.0', 'generator': 'oma-peek demo'}, 'scene': 0,
           'scenes': [{'nodes': list(range(len(parts)))}], 'nodes': nodes, 'meshes': meshes,
           'materials': materials, 'accessors': accessors, 'bufferViews': views,
           'buffers': [{'byteLength': len(blob)}]}
    js = json.dumps(doc, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    blob += b'\0' * (-len(blob) % 4)
    with open(path, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<I4s', len(js), b'JSON') + js)
        f.write(struct.pack('<I4s', len(blob), b'BIN\0') + blob)


def moved(tris, dx, dy):
    return [tuple((x + dx, y + dy, z) for x, y, z in t) for t in tris]


write_stl(os.path.join(OUT, 'twisted_vase.stl'), scad_tris('vase'))
open(os.path.join(OUT, 'gear.scad'), 'w').write(SCAD['gear'].strip() + '\n')
torus_knot_obj(os.path.join(OUT, 'torus_knot.obj'))

rook, pawn = scad_tris('rook'), scad_tris('pawn')
write_3mf(os.path.join(OUT, 'chess_set.3mf'),
          [(1, 'Rook', rook), (2, 'Pawn', pawn), (3, 'Rook', rook), (4, 'Pawn', pawn)],
          [(1, -40, 0), (2, 0, 0), (2, 30, 0), (2, 60, 0), (3, -40, 0), (4, 0, 0), (4, 30, 0), (4, 60, 0)],
          bambu_config([(1, 'Rook', 1), (2, 'Pawn', 1), (3, 'Rook', 2), (4, 'Pawn', 2)],
                       [('Light pieces', [(1, 0), (2, 0), (2, 1), (2, 2)]),
                        ('Dark pieces', [(3, 0), (4, 0), (4, 1), (4, 2)])]),
          ['#F2E3C6', '#2B2D42'])
write_3mf(os.path.join(OUT, 'hex_planter.3mf'),
          [(1, 'Planter', scad_tris('planter')), (2, 'Saucer', scad_tris('saucer'))],
          [(1, 0, 0), (2, 0, 0)],
          bambu_config([(1, 'Planter', 1), (2, 'Saucer', 2)], [('', [(1, 0), (2, 0)])]),
          ['#E07A5F', '#81B29A'])
write_glb(os.path.join(OUT, 'mushroom.glb'),
          [('Stem', scad_tris('stem'), (0.93, 0.88, 0.78)),
           ('Cap', scad_tris('cap'), (0.80, 0.16, 0.16)),
           ('Spots', scad_tris('spots'), (0.98, 0.97, 0.94))])

try:
    flags = open(os.path.join(REPO, 'cad_ldlibs')).read().split()
    mk = os.path.join(TMP, 'mkcad')
    subprocess.run(['g++', '-std=c++17', '-O1', '-I/usr/include/opencascade',
                    os.path.join(REPO, 'bench/e2e/make_cad_corpus.cpp'), '-o', mk, *flags, '-lTKPrim', '-lTKBO'],
                   check=True, capture_output=True)
    subprocess.run([mk, TMP], check=True, capture_output=True)
    os.replace(os.path.join(TMP, 'assembly.step'), os.path.join(OUT, 'bracket_assembly.step'))
    os.replace(os.path.join(TMP, 'assembly.iges'), os.path.join(OUT, 'bracket_assembly.iges'))
except (subprocess.CalledProcessError, OSError) as e:
    print('skipping STEP/IGES (needs OpenCASCADE):', e, file=sys.stderr)

print('\n'.join(sorted(os.listdir(OUT))))
