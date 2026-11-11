// T8: viewer view-state transitions and invariants (web/state.js).
// run: node --test tests/state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { initialState, reduce, isVisible } = await import(join(here, '..', 'web', 'state.js'));

// Two plates; parts 0 and 1 on plate 0, part 2 on plate 1.
const model = { plates: [{ name: 'A' }, { name: 'B' }], parts: [{ plate: 0 }, { plate: 0 }, { plate: 1 }] };
const single = { plates: [{ name: 'Model' }], parts: [{ plate: 0 }, { plate: 0 }] };
const run = (m, s, ...actions) => actions.reduce((st, a) => reduce(m, st, a), s);
const visible = (m, s) => m.parts.map((_, i) => i).filter((i) => isVisible(m, s, i));

test('multi-plate models open on the first plate, single-plate models show everything', () => {
    assert.deepEqual(initialState(model), { plate: 0, isolated: null, hovered: null });
    assert.deepEqual(initialState(single), { plate: -1, isolated: null, hovered: null });
    assert.deepEqual(visible(model, initialState(model)), [0, 1]);
});

test('selecting a plate shows only its parts and clears isolation and hover', () => {
    let s = run(model, initialState(model), { type: 'hover', part: 0, on: true });
    assert.equal(s.hovered, 0);
    s = run(model, s, { type: 'selectPlate', plate: 1 });
    assert.deepEqual(s, { plate: 1, isolated: null, hovered: null });
    assert.deepEqual(visible(model, s), [2]);
    s = run(model, s, { type: 'toggleIsolate', part: 2 }, { type: 'selectPlate', plate: -1 });
    assert.deepEqual(s, { plate: -1, isolated: null, hovered: null });
    assert.deepEqual(visible(model, s), [0, 1, 2]);
});

test('out-of-range plates are ignored', () => {
    const s0 = initialState(model);
    for (const plate of [2, -2, 0.5, undefined])
        assert.equal(reduce(model, s0, { type: 'selectPlate', plate }), s0);
});

test('isolation toggles, shows only that part, and clears hover', () => {
    let s = run(model, initialState(model), { type: 'hover', part: 1, on: true }, { type: 'toggleIsolate', part: 1 });
    assert.equal(s.isolated, 1);
    assert.equal(s.hovered, null);
    assert.deepEqual(visible(model, s), [1]);
    s = run(model, s, { type: 'toggleIsolate', part: 0 });
    assert.equal(s.isolated, 0, 'isolating another part on the plate switches to it');
    s = run(model, s, { type: 'toggleIsolate', part: 0 });
    assert.equal(s.isolated, null);
    assert.deepEqual(visible(model, s), [0, 1]);
});

test('parts on another plate cannot be isolated or hovered', () => {
    const s0 = initialState(model);
    assert.equal(reduce(model, s0, { type: 'toggleIsolate', part: 2 }), s0);
    assert.equal(reduce(model, s0, { type: 'hover', part: 2, on: true }), s0);
    assert.equal(reduce(model, s0, { type: 'toggleIsolate', part: 9 }), s0);
});

test('hover is ignored while isolated, and only the hovered part un-hovers', () => {
    let s = run(model, initialState(model), { type: 'toggleIsolate', part: 0 });
    assert.equal(reduce(model, s, { type: 'hover', part: 0, on: true }), s);
    s = run(model, initialState(model), { type: 'hover', part: 0, on: true }, { type: 'hover', part: 1, on: false });
    assert.equal(s.hovered, 0);
    s = run(model, s, { type: 'hover', part: 0, on: false });
    assert.equal(s.hovered, null);
});
