// T5: web/loaders.js against fixtures with known geometry (tests/fixtures/models.py).
// run: node --test tests/loaders.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { loadModel } = await import(join(here, '..', 'web', 'loaders.js'));

// Fixtures are generated before the tests are declared: the manifest defines the test list.
const dir = mkdtempSync(join(tmpdir(), 'oma-peek-fixtures-'));
execFileSync('python3', ['-I', join(here, 'fixtures', 'models.py'), dir], { stdio: 'ignore' });
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
after(() => rmSync(dir, { recursive: true, force: true }));

const load = (c) => {
    const bytes = new Uint8Array(readFileSync(join(dir, c.file)));
    return loadModel(bytes, c.ext, async (name) => new Uint8Array(readFileSync(join(dir, name))));
};

function bounds(positions) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], positions[i + k]);
            max[k] = Math.max(max[k], positions[i + k]);
        }
    return [min, max];
}

for (const c of manifest) {
    test(`${c.file}${c.error ? ' is rejected' : ''}`, async () => {
        if (c.error) {
            await assert.rejects(load(c), (e) => e.message.toLowerCase().includes(c.error));
            return;
        }
        const m = await load(c);
        assert.equal(m.yUp, c.yUp);
        assert.deepEqual(m.plates.map((p) => p.name), c.plates);
        assert.equal(m.parts.length, c.parts.length, 'part count');
        c.parts.forEach((want, i) => {
            const got = m.parts[i];
            assert.equal(got.name, want.name, `part ${i} name`);
            assert.equal(got.plate, want.plate, `part ${i} plate`);
            assert.equal(got.indices.length / 3, want.tris, `part ${i} triangles`);
            if (want.colour) assert.equal(got.color, want.colour, `part ${i} colour`);
            assert.equal(!!got.triColors, want.triColours, `part ${i} per-triangle colours`);
            const [min, max] = bounds(got.positions);
            for (let k = 0; k < 3; k++) {
                assert.ok(Math.abs(min[k] - want.bbox[0][k]) < 1e-4, `part ${i} min[${k}] ${min[k]} vs ${want.bbox[0][k]}`);
                assert.ok(Math.abs(max[k] - want.bbox[1][k]) < 1e-4, `part ${i} max[${k}] ${max[k]} vs ${want.bbox[1][k]}`);
            }
        });
    });
}
