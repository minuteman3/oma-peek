// Mesh loaders for oma-peek: STL, OBJ and 3MF (PrusaSlicer, Bambu/Orca, generic).
//
// loadModel(bytes, ext) resolves to
//   { yUp, plates: [{ name }], parts: [Part] }
// where each Part is one placed object instance in world space:
//   { name, plate, positions: Float32Array, indices: Uint32Array,
//     triColors: Uint8Array | null (RGB per triangle), color: '#rrggbb' | null }

import { unzipSync, strFromU8 } from './vendor/fflate.module.js';

// --- 3MF affine transforms (row-vector convention, 12 floats) -------------

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(s) {
    if (!s) return IDENTITY;
    const t = s.trim().split(/\s+/).map(Number);
    return t.length === 12 && t.every(Number.isFinite) ? t : IDENTITY;
}

// Apply a first, then b.
function compose(a, b) {
    const c = new Array(12);
    for (let i = 0; i < 4; i++)
        for (let j = 0; j < 3; j++) {
            let v = 0;
            for (let k = 0; k < 3; k++) v += a[i * 3 + k] * b[k * 3 + j];
            c[i * 3 + j] = v + (i === 3 ? b[9 + j] : 0);
        }
    return c;
}

// --- small helpers ---------------------------------------------------------

function attrs(s) {
    const out = {};
    for (const m of s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
    return out;
}

function stripNs(tag) {
    const i = tag.indexOf(':');
    return i < 0 ? tag : tag.slice(i + 1);
}

function normColor(c) {
    if (!c) return null;
    const m = /^#?([0-9a-f]{6})/i.exec(c.trim());
    return m ? '#' + m[1].toLowerCase() : null;
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class Accum {
    constructor() {
        this.pos = [];
        this.idx = [];
        this.tri = [];      // per-triangle colour hex or null
        this.anyColor = false;
    }
    finish(name, plate, fallback) {
        const triCount = this.idx.length / 3;
        let triColors = null;
        let color = fallback;
        if (this.anyColor) {
            const distinct = new Set(this.tri.map((c) => c || fallback));
            if (distinct.size === 1) {
                color = [...distinct][0];
            } else {
                triColors = new Uint8Array(triCount * 3);
                const def = fallback ? hexToRgb(fallback) : [200, 200, 200];
                for (let i = 0; i < triCount; i++) {
                    const rgb = this.tri[i] ? hexToRgb(this.tri[i]) : def;
                    triColors.set(rgb, i * 3);
                }
            }
        }
        return {
            name, plate,
            positions: Float32Array.from(this.pos),
            indices: Uint32Array.from(this.idx),
            triColors, color,
        };
    }
}

// --- STL -------------------------------------------------------------------

function loadSTL(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.byteLength >= 84 ? dv.getUint32(80, true) : 0;
    let positions;
    if (bytes.byteLength === 84 + n * 50 && n > 0) {
        positions = new Float32Array(n * 9);
        for (let i = 0; i < n; i++) {
            const o = 84 + i * 50 + 12;
            for (let k = 0; k < 9; k++) positions[i * 9 + k] = dv.getFloat32(o + k * 4, true);
        }
    } else {
        const text = new TextDecoder().decode(bytes);
        const out = [];
        for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g))
            out.push(+m[1], +m[2], +m[3]);
        positions = Float32Array.from(out);
    }
    const indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    return {
        yUp: false,
        plates: [{ name: 'Model' }],
        parts: [{ name: null, plate: 0, positions, indices, triColors: null, color: null }],
    };
}

// --- OBJ -------------------------------------------------------------------

function parseMTL(text) {
    const mats = {};
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim().split(/\s+/);
        if (t[0] === 'newmtl') cur = t.slice(1).join(' ');
        else if (t[0] === 'Kd' && cur !== null) {
            const rgb = t.slice(1, 4).map((v) => Math.round(Math.min(1, Math.max(0, +v)) * 255));
            mats[cur] = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
        }
    }
    return mats;
}

async function loadOBJ(bytes, fetchSibling) {
    const text = new TextDecoder().decode(bytes);
    const verts = [];
    let mats = {};
    const parts = [];
    let part = null, partName = null, curColor = null;
    const newPart = () => { part = { name: partName, acc: new Accum(), map: new Map() }; parts.push(part); };

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line[0] === '#') continue;
        const t = line.split(/\s+/);
        switch (t[0]) {
            case 'v':
                verts.push([+t[1], +t[2], +t[3]]);
                if (t.length >= 7) {
                    const rgb = t.slice(4, 7).map((v) => Math.round(Math.min(1, Math.max(0, +v)) * 255));
                    verts[verts.length - 1].color = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
                }
                break;
            case 'o':
            case 'g':
                partName = t.slice(1).join(' ') || null;
                part = null;
                break;
            case 'mtllib':
                if (fetchSibling) {
                    try { mats = { ...mats, ...parseMTL(new TextDecoder().decode(await fetchSibling(t.slice(1).join(' ')))) }; } catch (e) { /* no mtl */ }
                }
                break;
            case 'usemtl':
                curColor = mats[t.slice(1).join(' ')] || null;
                break;
            case 'f': {
                if (!part) newPart();
                const ids = t.slice(1).map((s) => {
                    let i = parseInt(s, 10);
                    return i < 0 ? verts.length + i : i - 1;
                });
                const local = ids.map((i) => {
                    let l = part.map.get(i);
                    if (l === undefined) {
                        l = part.acc.pos.length / 3;
                        part.map.set(i, l);
                        const v = verts[i] || [0, 0, 0];
                        part.acc.pos.push(v[0], v[1], v[2]);
                    }
                    return l;
                });
                const c = curColor || (verts[ids[0]] && verts[ids[0]].color) || null;
                for (let k = 1; k + 1 < local.length; k++) {
                    part.acc.idx.push(local[0], local[k], local[k + 1]);
                    part.acc.tri.push(c);
                    if (c) part.acc.anyColor = true;
                }
                break;
            }
        }
    }
    return {
        yUp: true,
        plates: [{ name: 'Model' }],
        parts: parts.filter((p) => p.acc.idx.length).map((p) => p.acc.finish(p.name, 0, null)),
    };
}

// --- 3MF -------------------------------------------------------------------

// Parse one .model XML into { objects: Map(id -> obj), props: Map(id -> [hex]), build: [item] }.
function parseModelXML(text) {
    const props = new Map();
    for (const m of text.matchAll(/<((?:\w+:)?(?:basematerials|colorgroup))\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
        const id = attrs(m[2]).id;
        const list = [];
        for (const e of m[3].matchAll(/<(?:\w+:)?(?:base|color)\b([^>]*)\/?>/g)) {
            const a = attrs(e[1]);
            list.push(normColor(a.displaycolor || a.color));
        }
        props.set(id, list);
    }

    const objects = new Map();
    for (const m of text.matchAll(/<object\b([^>]*?)(\/>|>([\s\S]*?)<\/object>)/g)) {
        const a = attrs(m[1]);
        const body = m[3] || '';
        const obj = { id: a.id, name: a.name || null, pid: a.pid, pindex: a.pindex, mesh: null, components: [] };
        const meshStart = body.indexOf('<mesh');
        if (meshStart >= 0) {
            const pos = [];
            const vEnd = body.indexOf('</vertices>', meshStart);
            const vText = body.slice(meshStart, vEnd < 0 ? undefined : vEnd);
            for (const v of vText.matchAll(/<vertex\b([^>]*)>/g)) {
                const s = v[1];
                const x = /\bx="([^"]*)"/.exec(s), y = /\by="([^"]*)"/.exec(s), z = /\bz="([^"]*)"/.exec(s);
                pos.push(x ? +x[1] : 0, y ? +y[1] : 0, z ? +z[1] : 0);
            }
            const idx = [];
            const triProp = [];
            const tText = vEnd < 0 ? '' : body.slice(vEnd);
            for (const t of tText.matchAll(/<triangle\b([^>]*)>/g)) {
                const s = t[1];
                const v1 = /\bv1="(\d+)"/.exec(s), v2 = /\bv2="(\d+)"/.exec(s), v3 = /\bv3="(\d+)"/.exec(s);
                if (!v1 || !v2 || !v3) continue;
                idx.push(+v1[1], +v2[1], +v3[1]);
                const pid = /\bpid="([^"]*)"/.exec(s), p1 = /\bp1="(\d+)"/.exec(s);
                triProp.push(pid || p1 ? [pid ? pid[1] : null, p1 ? +p1[1] : null] : null);
            }
            obj.mesh = { pos, idx, triProp };
        }
        for (const c of body.matchAll(/<component\b([^>]*)\/?>/g)) {
            const ca = attrs(c[1]);
            obj.components.push({ objectid: ca.objectid, path: ca['p:path'] || null, transform: parseTransform(ca.transform) });
        }
        objects.set(a.id, obj);
    }

    const build = [];
    const b = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(text);
    if (b) for (const it of b[1].matchAll(/<item\b([^>]*)\/?>/g)) {
        const ia = attrs(it[1]);
        build.push({ objectid: ia.objectid, path: ia['p:path'] || null, transform: parseTransform(ia.transform), printable: ia.printable !== '0' });
    }
    return { objects, props, build };
}

function findKey(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
        for (const n of node) { const r = findKey(n, key); if (r !== undefined) return r; }
        return undefined;
    }
    if (key in node) return node[key];
    for (const v of Object.values(node)) { const r = findKey(v, key); if (r !== undefined) return r; }
    return undefined;
}

function colourList(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : String(v).split(';');
    return arr.map((s) => normColor(String(s).replace(/"/g, '')));
}

function mergeColours(primary, secondary) {
    const n = Math.max(primary.length, secondary.length);
    const out = [];
    for (let i = 0; i < n; i++) out.push(primary[i] || secondary[i] || null);
    return out;
}

function load3MF(bytes) {
    const files = unzipSync(bytes);
    const get = (p) => {
        p = p.replace(/^\//, '');
        const k = Object.keys(files).find((f) => f.toLowerCase() === p.toLowerCase());
        return k ? files[k] : null;
    };

    // Root model: from _rels/.rels, else 3D/3dmodel.model.
    let rootPath = '3D/3dmodel.model';
    const rels = get('_rels/.rels');
    if (rels) {
        const m = /Target="([^"]+\.model)"/i.exec(strFromU8(rels));
        if (m) rootPath = m[1].replace(/^\//, '');
    }
    const models = new Map();
    const model = (path) => {
        path = (path || rootPath).replace(/^\//, '');
        if (!models.has(path)) {
            const data = get(path);
            models.set(path, data ? parseModelXML(strFromU8(data)) : { objects: new Map(), props: new Map(), build: [] });
        }
        return models.get(path);
    };
    const root = model(rootPath);

    // --- slicer metadata: names, extruders, colours, plates ---
    const objNames = new Map();      // root object id -> name
    const objExtruder = new Map();   // root object id -> extruder (1-based)
    const partExtruder = new Map();  // component object id -> extruder
    const volumeRanges = new Map();  // root object id -> [{first,last,extruder}] (legacy Prusa)
    let colours = [];
    let plates = null;               // [{name, members: Set('objid#instance')}]
    let beds = null;                 // Prusa multi-bed [{x,y}]

    const prusa3 = get('Metadata/PrusaSlicer3_project.json');
    if (prusa3) {
        try {
            const j = JSON.parse(strFromU8(prusa3));
            for (const o of j.objects || []) {
                const e = o.object_settings && o.object_settings.extruder;
                if (e) objExtruder.set(String(o.id), e);
                for (const v of o.volumes || []) {
                    const ve = v.volume_settings && v.volume_settings.extruder;
                    if (ve) partExtruder.set(String(v.id), ve);
                }
            }
            colours = mergeColours(colourList(findKey(j, 'extruder_colour')), colourList(findKey(j, 'filament_colour')));
            const cc = Array.isArray(j.config_containers) ? j.config_containers[0] : j.config_containers;
            if (cc && Array.isArray(cc.beds) && cc.beds.length > 1)
                beds = cc.beds.map((b) => ({ x: b.position_x || 0, y: b.position_y || 0 }));
        } catch (e) { /* ignore malformed metadata */ }
    }

    const slic3rCfg = get('Metadata/Slic3r_PE.config');
    if (slic3rCfg && !colours.some(Boolean)) {
        const t = strFromU8(slic3rCfg);
        const ext = /^;\s*extruder_colour\s*=\s*(.*)$/m.exec(t);
        const fil = /^;\s*filament_colour\s*=\s*(.*)$/m.exec(t);
        colours = mergeColours(colourList(ext && ext[1]), colourList(fil && fil[1]));
    }

    const slic3rModel = get('Metadata/Slic3r_PE_model.config');
    if (slic3rModel) {
        const t = strFromU8(slic3rModel);
        for (const m of t.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
            const id = attrs(m[1]).id;
            const ranges = [];
            for (const md of m[2].replace(/<volume[\s\S]*?<\/volume>/g, '').matchAll(/<metadata\b([^>]*)\/>/g)) {
                const a = attrs(md[1]);
                if (a.type === 'object' && a.key === 'name') objNames.set(id, a.value);
                if (a.type === 'object' && a.key === 'extruder' && +a.value) objExtruder.set(id, +a.value);
            }
            for (const v of m[2].matchAll(/<volume\b([^>]*)>([\s\S]*?)<\/volume>/g)) {
                const va = attrs(v[1]);
                const e = /key="extruder"\s+value="(\d+)"/.exec(v[2]);
                if (e && +e[1]) ranges.push({ first: +va.firstid, last: +va.lastid, extruder: +e[1] });
            }
            if (ranges.length) volumeRanges.set(id, ranges);
        }
    }

    const bambuModel = get('Metadata/model_settings.config');
    if (bambuModel) {
        const t = strFromU8(bambuModel);
        for (const m of t.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
            const id = attrs(m[1]).id;
            const own = m[2].replace(/<part[\s\S]*?<\/part>/g, '');
            const n = /key="name"\s+value="([^"]*)"/.exec(own);
            const e = /key="extruder"\s+value="(\d+)"/.exec(own);
            if (n) objNames.set(id, n[1]);
            if (e && +e[1]) objExtruder.set(id, +e[1]);
            for (const p of m[2].matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)) {
                const pe = /key="extruder"\s+value="(\d+)"/.exec(p[2]);
                if (pe && +pe[1]) partExtruder.set(attrs(p[1]).id, +pe[1]);
            }
        }
        const pl = [];
        for (const m of t.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
            const id = /key="plater_id"\s+value="(\d+)"/.exec(m[1]);
            const name = /key="plater_name"\s+value="([^"]*)"/.exec(m[1]);
            const members = new Set();
            for (const mi of m[1].matchAll(/<model_instance>([\s\S]*?)<\/model_instance>/g)) {
                const oid = /key="object_id"\s+value="(\d+)"/.exec(mi[1]);
                const iid = /key="instance_id"\s+value="(\d+)"/.exec(mi[1]);
                if (oid) members.add(`${oid[1]}#${iid ? iid[1] : 0}`);
            }
            const n = id ? +id[1] : pl.length + 1;
            pl.push({ name: (name && name[1].trim()) || `Plate ${n}`, members, order: n });
        }
        if (pl.length) plates = pl.sort((a, b) => a.order - b.order);
    }

    const bambuProject = get('Metadata/project_settings.config');
    if (bambuProject && !colours.some(Boolean)) {
        try { colours = colourList(JSON.parse(strFromU8(bambuProject)).filament_colour); } catch (e) { /* ignore */ }
    }

    const extruderColour = (e) => (e && colours[e - 1]) || null;

    // --- flatten build items into parts ---
    function emit(acc, path, objectid, transform, inheritedColour, rootId) {
        const mdl = model(path);
        const obj = mdl.objects.get(objectid);
        if (!obj) return;
        const own = extruderColour(partExtruder.get(objectid)) || inheritedColour;
        if (obj.mesh) {
            const { pos, idx, triProp } = obj.mesh;
            const base = acc.pos.length / 3;
            const t = transform;
            for (let i = 0; i < pos.length; i += 3) {
                const x = pos[i], y = pos[i + 1], z = pos[i + 2];
                acc.pos.push(x * t[0] + y * t[3] + z * t[6] + t[9],
                             x * t[1] + y * t[4] + z * t[7] + t[10],
                             x * t[2] + y * t[5] + z * t[8] + t[11]);
            }
            const objProp = obj.pid ? (mdl.props.get(obj.pid) || [])[+(obj.pindex || 0)] : null;
            const ranges = volumeRanges.get(rootId);
            for (let i = 0; i < idx.length; i += 3) {
                acc.idx.push(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
                const tri = i / 3;
                let c = null;
                const tp = triProp[tri];
                if (tp) {
                    const list = mdl.props.get(tp[0] || obj.pid) || [];
                    c = list[tp[1] !== null ? tp[1] : +(obj.pindex || 0)] || null;
                }
                if (!c && ranges) {
                    const r = ranges.find((r) => tri >= r.first / 3 && tri <= r.last / 3);
                    if (r) c = extruderColour(r.extruder);
                }
                c = c || objProp || own;
                acc.tri.push(c);
                if (c) acc.anyColor = true;
            }
        }
        for (const comp of obj.components)
            emit(acc, comp.path || path, comp.objectid, compose(comp.transform, transform), own, rootId);
    }

    const parts = [];
    const instanceCount = new Map();
    for (const item of root.build) {
        const k = instanceCount.get(item.objectid) || 0;
        instanceCount.set(item.objectid, k + 1);
        const acc = new Accum();
        const colour = extruderColour(objExtruder.get(item.objectid) || 1);
        emit(acc, item.path, item.objectid, item.transform, colour, item.objectid);
        if (!acc.idx.length) continue;
        const obj = model(item.path).objects.get(item.objectid);
        const name = objNames.get(item.objectid) || (obj && obj.name) || `Object ${item.objectid}`;
        const part = acc.finish(name, 0, colour);
        part.key = `${item.objectid}#${k}`;
        parts.push(part);
    }

    // Disambiguate repeated instance names: "Frame_Side.stl", "Frame_Side.stl (2)".
    const seen = new Map();
    for (const p of parts) {
        const n = (seen.get(p.name) || 0) + 1;
        seen.set(p.name, n);
        if (n > 1) p.name = `${p.name} (${n})`;
    }

    let plateList = [{ name: 'Plate 1' }];
    if (plates) {
        plateList = plates.map((p) => ({ name: p.name }));
        for (const p of parts) {
            const i = plates.findIndex((pl) => pl.members.has(p.key));
            p.plate = i < 0 ? 0 : i;
        }
    } else if (beds) {
        plateList = beds.map((_, i) => ({ name: `Bed ${i + 1}` }));
        for (const p of parts) {
            let cx = 0, cy = 0;
            const n = p.positions.length / 3;
            for (let i = 0; i < p.positions.length; i += 3) { cx += p.positions[i]; cy += p.positions[i + 1]; }
            cx /= n; cy /= n;
            let best = 0, bestD = Infinity;
            beds.forEach((b, i) => {
                const behind = cx < b.x - 1 || cy < b.y - 1 ? 1e12 : 0;
                const d = behind + (cx - b.x) ** 2 + (cy - b.y) ** 2;
                if (d < bestD) { bestD = d; best = i; }
            });
            p.plate = best;
        }
    }
    // Drop empty plates (but keep at least one).
    const used = new Set(parts.map((p) => p.plate));
    if (plateList.length > 1) {
        const remap = new Map();
        const kept = [];
        plateList.forEach((pl, i) => { if (used.has(i)) { remap.set(i, kept.length); kept.push(pl); } });
        for (const p of parts) p.plate = remap.get(p.plate);
        plateList = kept.length ? kept : [{ name: 'Plate 1' }];
    }
    return { yUp: false, plates: plateList, parts };
}

export async function loadModel(bytes, ext, fetchSibling) {
    ext = ext.toLowerCase();
    if (ext === '3mf') return load3MF(bytes);
    if (ext === 'obj') return loadOBJ(bytes, fetchSibling);
    return loadSTL(bytes);
}
