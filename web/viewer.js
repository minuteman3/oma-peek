import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { loadModel } from './loaders.js';
import { initialState, reduce, isVisible, onPlate } from './state.js';

// Host -> page (query string): status=progress|error|model, message, file, ext, name, theme.
// Page -> host: one 'ready' message once the page shows something (progress or error text,
// or the model), via the WebKit script message handler 'omaPeek' when the host registered it.
const params = new URLSearchParams(location.search);
const filePath = params.get('file');
const status = params.get('status') || (filePath ? 'model' : 'error');
const ext = (params.get('ext') || (filePath || '').split('.').pop()).toLowerCase();

let readyPosted = false;
function postReady(outcome) {
    if (readyPosted) return;
    readyPosted = true;
    try {
        window.webkit?.messageHandlers?.omaPeek?.postMessage(JSON.stringify({ event: 'ready', outcome }));
    } catch (e) { /* not hosted by oma-peek (e.g. opened in a browser) */ }
}

const $ = (id) => document.getElementById(id);
const msg = $('msg'), info = $('info'), side = $('side'), view = $('view');

// --- theme -------------------------------------------------------------------

let theme = {};
try { theme = JSON.parse(params.get('theme') || '{}'); } catch (e) { /* defaults */ }
const css = document.documentElement.style;
const themeMap = { bg: 'background', bg2: 'darker_background', panel: 'dark_background',
                   fg: 'foreground', muted: 'muted', sel: 'selection', accent: 'accent' };
for (const [v, k] of Object.entries(themeMap)) if (theme[k]) css.setProperty('--' + v, theme[k]);
const accent = new THREE.Color(theme.accent || '#f38d70');
const defaultColour = theme.mode === 'light' ? '#9aa3ad' : '#b9c0c8';

function show(text, kind) {
    msg.textContent = text;
    msg.className = kind === 'error' ? 'error' : '';
    msg.hidden = false;
}

function fail(text) {
    show(text, 'error');
    postReady('error');
}

// Dark filament (black, navy…) would vanish on a dark background; lift it a little.
function displayColour(hex) {
    const c = new THREE.Color(hex || defaultColour);
    const hsl = {};
    c.getHSL(hsl);
    if (hsl.l < 0.22) c.setHSL(hsl.h, hsl.s, 0.22);
    return c;
}

// --- scene ---------------------------------------------------------------------

// Created by initScene() only when there is a model to show, so progress and error pages
// work without WebGL.
let renderer, scene, camera, controls, root;
let grid = null;

function initScene() {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    view.prepend(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, 1.2, 0.9);
    camera.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, -0.3, 0.4);
    camera.add(fill);
    scene.add(camera);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;

    root = new THREE.Group();
    scene.add(root);

    new ResizeObserver(() => { resize(); if (meshes.length) frame(visibleMeshes()); }).observe(view);
    renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
    });
}

const DEFAULT_DIR = new THREE.Vector3(0.75, 0.62, 1.05).normalize();

function frame(objects, keepDirection = true) {
    const box = new THREE.Box3();
    for (const o of objects) box.expandByObject(o);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = keepDirection && controls.target
        ? camera.position.clone().sub(controls.target).normalize()
        : DEFAULT_DIR.clone();
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.copy(DEFAULT_DIR);

    // Start from the bounding sphere, then tighten so the box corners fill ~88% of the view.
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    let dist = sphere.radius / Math.sin(Math.min(vfov, hfov) / 2);
    const corners = [];
    for (let i = 0; i < 8; i++)
        corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    controls.target.copy(sphere.center);
    for (let iter = 0; iter < 4; iter++) {
        camera.position.copy(sphere.center).addScaledVector(dir, dist);
        camera.lookAt(sphere.center);
        camera.near = dist / 1000;
        camera.far = dist * 100;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
        let extent = 0;
        for (const c of corners) {
            const p = c.clone().project(camera);
            extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
        }
        if (!(extent > 0)) break;
        // Perspective is roughly inverse in distance; damp the step for stability.
        dist *= Math.pow(extent / 0.88, 0.8);
    }
    controls.minDistance = sphere.radius * 0.05;
    controls.maxDistance = dist * 20;
    controls.update();

    // Bed grid under whatever is framed.
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.6;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => span / s <= 24) || 1000;
    const cells = Math.max(2, Math.ceil(span / step));
    grid = new THREE.GridHelper(cells * step, cells, accent.clone().multiplyScalar(0.45),
                                new THREE.Color(theme.selection || '#3a3a3a'));
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    grid.position.set(sphere.center.x, box.min.y - size.y * 0.002, sphere.center.z);
    scene.add(grid);
}

function resize() {
    const w = view.clientWidth, h = view.clientHeight;
    if (!renderer || !w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}

// --- model -------------------------------------------------------------------

function buildMesh(part) {
    const geo = new THREE.BufferGeometry();
    let material;
    if (part.triColors) {
        // Per-triangle colours need un-shared vertices.
        const triCount = part.indices.length / 3;
        const pos = new Float32Array(triCount * 9);
        const col = new Float32Array(triCount * 9);
        for (let t = 0; t < triCount; t++) {
            const c = displayColour('#' + [0, 1, 2].map((k) => part.triColors[t * 3 + k].toString(16).padStart(2, '0')).join(''));
            for (let k = 0; k < 3; k++) {
                const v = part.indices[t * 3 + k];
                pos.set(part.positions.subarray(v * 3, v * 3 + 3), t * 9 + k * 3);
                col.set([c.r, c.g, c.b], t * 9 + k * 3);
            }
        }
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7, metalness: 0.05 });
    } else {
        geo.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
        geo.setIndex(new THREE.BufferAttribute(part.indices, 1));
        material = new THREE.MeshStandardMaterial({ color: displayColour(part.color), flatShading: true, roughness: 0.7, metalness: 0.05 });
    }
    material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData.part = part;
    return mesh;
}

let model, meshes = [], state;

function visibleMeshes() {
    return meshes.filter((m) => m.visible);
}

function applyVisibility(keepDirection = true) {
    meshes.forEach((m, i) => { m.visible = isVisible(model, state, i); });
    frame(visibleMeshes(), keepDirection);
    updateInfo();
    renderSidebar();
}

// All view-state changes go through here (web/state.js owns the rules).
function dispatch(action) {
    const prev = state;
    state = reduce(model, state, action);
    if (state === prev) return;
    if (prev.hovered !== state.hovered) {
        if (prev.hovered !== null) highlight(meshes[prev.hovered], false);
        if (state.hovered !== null) highlight(meshes[state.hovered], true);
    }
    if (prev.plate !== state.plate || prev.isolated !== state.isolated) applyVisibility();
}

function updateInfo() {
    const vis = visibleMeshes();
    const box = new THREE.Box3();
    for (const m of vis) box.expandByObject(m);
    if (box.isEmpty()) { info.textContent = ''; return; }
    // root is rotated to Y-up; report in printer axes (X × Y × Z).
    const s = box.getSize(new THREE.Vector3());
    const dims = model.yUp ? [s.x, s.z, s.y] : [s.x, s.z, s.y];
    const tris = vis.reduce((n, m) => n + m.userData.part.indices.length / 3, 0);
    const f = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
    info.innerHTML = `<b>${dims.map(f).join(' × ')} mm</b> · ${tris.toLocaleString()} triangles`;
}

function button(label, { dot, count, active, dim, onClick, onHover }) {
    const b = document.createElement('button');
    if (dot) {
        const d = document.createElement('span');
        d.className = 'dot';
        d.style.background = dot;
        b.append(d);
    }
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    l.title = label;
    b.append(l);
    if (count !== undefined) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = count;
        b.append(c);
    }
    if (active) b.classList.add('active');
    if (dim) b.classList.add('dim');
    b.onclick = onClick;
    if (onHover) {
        b.onmouseenter = () => onHover(true);
        b.onmouseleave = () => onHover(false);
    }
    return b;
}

function highlight(mesh, on) {
    const mat = mesh.material;
    mat.emissive.copy(on ? accent : new THREE.Color(0));
    mat.emissiveIntensity = on ? 0.35 : 0;
}

function renderSidebar() {
    const plates = model.plates;
    const multiPlate = plates.length > 1;
    const multiPart = meshes.length > 1;
    side.hidden = !(multiPlate || multiPart);
    if (side.hidden) return;
    side.replaceChildren();

    if (multiPlate) {
        const h = document.createElement('h2');
        h.textContent = 'Plates';
        side.append(h);
        side.append(button('All plates', {
            count: meshes.length, active: state.plate < 0 && state.isolated === null,
            onClick: () => dispatch({ type: 'selectPlate', plate: -1 }),
        }));
        plates.forEach((p, i) => {
            const n = meshes.filter((m) => m.userData.part.plate === i).length;
            side.append(button(p.name, {
                count: n, active: state.plate === i && state.isolated === null,
                onClick: () => dispatch({ type: 'selectPlate', plate: i }),
            }));
        });
    }

    if (multiPart) {
        const h = document.createElement('h2');
        h.textContent = 'Objects';
        side.append(h);
        meshes.forEach((m, i) => {
            const p = m.userData.part;
            if (!onPlate(model, state, i)) return;
            const c = p.triColors ? 'conic-from-colors' : '#' + displayColour(p.color).getHexString();
            side.append(button(p.name || 'Object', {
                dot: c === 'conic-from-colors' ? 'conic-gradient(#f38d70,#85dacc,#a8a9eb,#f9cc6c,#f38d70)' : c,
                active: state.isolated === i, dim: state.isolated !== null && state.isolated !== i,
                onClick: () => dispatch({ type: 'toggleIsolate', part: i }),
                onHover: (on) => dispatch({ type: 'hover', part: i, on }),
            }));
        });
    }
    requestAnimationFrame(resize);
}

async function readFile(path) {
    const res = await fetch('file://' + encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F'));
    // file:// responses report status 0 on success.
    if (!res.ok && res.status !== 0) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error('empty or unreadable');
    return new Uint8Array(buf);
}

async function main() {
    if (status !== 'model' || !filePath) {
        const kind = status === 'progress' ? 'progress' : 'error';
        show(params.get('message') || 'Nothing to show', kind);
        postReady(kind);
        return;
    }
    try {
        initScene();
        resize();
    } catch (e) {
        fail(`3D view unavailable: WebGL could not start\n${e.message}`);
        return;
    }
    let bytes;
    try {
        bytes = await readFile(filePath);
    } catch (e) {
        fail(`Could not read ${filePath}\n${e.message}`);
        return;
    }
    try {
        const dir = filePath.slice(0, filePath.lastIndexOf('/') + 1);
        model = await loadModel(bytes, ext, (name) => readFile(dir + name));
    } catch (e) {
        fail(`Could not parse this file\n${e.message}`);
        return;
    }
    try {
        if (!model.yUp) root.rotation.x = -Math.PI / 2;
        meshes = model.parts.map(buildMesh);
        root.add(...meshes);
        root.updateMatrixWorld(true);
        state = initialState(model);
        applyVisibility(false);
    } catch (e) {
        meshes = [];
        fail(`Could not display this file\n${e.message}`);
        return;
    }
    msg.hidden = true;
    postReady('shown');
}

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || !state) return;
    if (e.key === 'r' || e.key === 'R') {
        frame(visibleMeshes(), false);
    } else if (/^[0-9]$/.test(e.key) && model.plates.length > 1) {
        // 1-9 pick a plate, 0 shows all plates.
        dispatch({ type: 'selectPlate', plate: +e.key - 1 });
    }
});

main().catch((e) => fail(`Unexpected error\n${e.message}`));
