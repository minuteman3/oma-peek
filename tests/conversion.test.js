// T4: conversion cache (SCAD/CAD -> viewer mesh), driven through real sessions with a fake
// converter installed in place of oma-peek-cad (and a fake openscad on PATH).
// run: XDG_DATA_HOME=<install> XDG_CACHE_HOME=<cache> FIXTURES=<dir> gjs -m tests/conversion.test.js
// Needs a display and webkitgtk-6.0. Exit 77 = skipped.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import * as system from 'system';

import {check, finish} from './lib/sushi.js';
import {fakeLog, installFakeConverter, listDir, makeFifo, pageParams, pidAlive, release, sleep,
    waitFor} from './lib/view.js';

const data = GLib.get_user_data_dir();
let Host;
try {
    Host = await import(GLib.filename_to_uri(`${data}/oma-peek/host.js`, null));
} catch (e) {
    print(`# skip: no oma-peek install in ${data}`);
    system.exit(77);
}
if (!Host.isAvailable()) {
    print('# skip: webkitgtk-6.0 is not installed');
    system.exit(77);
}
Gtk.init();

const fixtures = GLib.getenv('FIXTURES');
const scratch = GLib.dir_make_tmp('oma-peek-conv-XXXXXX');
const cache = `${GLib.get_user_cache_dir()}/oma-peek/models`;
installFakeConverter();
GLib.setenv('FAKE_LOG', `${scratch}/converter.log`, true);
GLib.setenv('FAKE_MPK', `${fixtures}/assembly.mpk`, true);

// A fake openscad that writes a valid STL.
GLib.mkdir_with_parents(`${scratch}/bin`, 0o755);
GLib.file_set_contents(`${scratch}/bin/openscad`,
    `#!/bin/bash\necho "$$ $3 $2" >> "$FAKE_LOG"\ncat ${GLib.shell_quote(`${fixtures}/box-binary.stl`)} > "$2"\n`);
GLib.chmod(`${scratch}/bin/openscad`, 0o755);
GLib.setenv('PATH', `${scratch}/bin:${GLib.getenv('PATH')}`, true);

let n = 0;
function source(ext, content = 'ISO-10303-21; fake') {
    const path = `${scratch}/model${++n}.${ext}`;
    GLib.file_set_contents(path, content);
    return path;
}

function open(path, env = {}) {
    for (const [k, v] of Object.entries(env))
        v === null ? GLib.unsetenv(k) : GLib.setenv(k, v, true);
    const view = new Host.WebKit.WebView();
    Host.configureWebView(view);
    const session = new Host.Session(view);
    session.start(Gio.File.new_for_path(path), '');
    for (const k of Object.keys(env))
        GLib.unsetenv(k);
    return {view, session};
}

const settled = (p) => p.view.get_uri() && ['model', 'error'].includes(pageParams(p.view)?.status);
const runsFor = (path) => fakeLog().filter((l) => l.src === path).length;
const visible = () => listDir(cache).filter((f) => !f.startsWith('.'));
const temps = () => listDir(cache).filter((f) => f.startsWith('.'));

function isMpk(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1].subarray(0, 4)) === 'MPK1';
    } catch (e) {
        return false;
    }
}

// Two previews of one file convert at the same time; both must succeed.
{
    const src = source('step');
    const gate = makeFifo(`${scratch}/gate-both`);
    const a = open(src, {FAKE_GATE: gate});
    const b = open(src, {FAKE_GATE: gate});
    check(await waitFor(() => runsFor(src) === 2), 'concurrent: both conversions running');
    release(gate);
    await waitFor(() => settled(a) && settled(b));
    const pa = pageParams(a.view), pb = pageParams(b.view);
    check(pa?.status === 'model' && pb?.status === 'model', 'concurrent: both previews show the model',
        `${pa?.status}: ${pa?.message} / ${pb?.status}: ${pb?.message}`);
    check(pa?.file === pb?.file && isMpk(pa?.file), 'concurrent: both use one valid cached mesh');
    check(temps().length === 0, 'concurrent: no temp files left', temps().join(','));
    a.session.shutdown();
    b.session.shutdown();
}

// One of two concurrent conversions is cancelled; the other still publishes.
{
    const src = source('step');
    const ga = makeFifo(`${scratch}/gate-a`), gb = makeFifo(`${scratch}/gate-b`);
    const a = open(src, {FAKE_GATE: ga});
    const b = open(src, {FAKE_GATE: gb});
    await waitFor(() => runsFor(src) === 2);
    const pidA = fakeLog().filter((l) => l.src === src)[0].pid;
    a.session.shutdown();
    check(await waitFor(() => !pidAlive(pidA), 3000), 'cancel one: its converter is killed');
    release(gb);
    await waitFor(() => settled(b));
    check(pageParams(b.view)?.status === 'model' && isMpk(pageParams(b.view).file), 'cancel one: the other shows the model');
    check(pageParams(a.view)?.status === 'progress', 'cancel one: the cancelled preview never moves on');
    await sleep(200);
    check(temps().length === 0, 'cancel one: no temp files left', temps().join(','));
    release(ga);
    b.session.shutdown();
}

// Converter output that isn't a mesh is an error and is not cached.
{
    const src = source('step');
    const p = open(src, {FAKE_MODE: 'short'});
    await waitFor(() => settled(p));
    check(pageParams(p.view)?.status === 'error' && /no usable mesh/.test(pageParams(p.view).message),
        'bad output: error shown', pageParams(p.view)?.message);
    p.session.shutdown();
    const before = visible().length;
    const q = open(src);
    await waitFor(() => settled(q));
    check(runsFor(src) === 2 && pageParams(q.view)?.status === 'model', 'bad output: not cached, converted again');
    check(visible().length === before + 1, 'bad output: only the good result was cached');
    q.session.shutdown();
}

// A failing converter shows its error text.
{
    const p = open(source('step'), {FAKE_MODE: 'fail'});
    await waitFor(() => settled(p));
    check(pageParams(p.view)?.status === 'error' && /fake converter failure/.test(pageParams(p.view).message),
        'converter failure: its message is shown', pageParams(p.view)?.message);
    p.session.shutdown();
}

// The result can't be published (cache directory not writable): reported, nothing cached.
{
    const before = visible();
    const p = open(source('step'), {FAKE_MODE: 'lockdir'});
    await waitFor(() => settled(p));
    GLib.chmod(cache, 0o700);
    check(pageParams(p.view)?.status === 'error' && /could not save/.test(pageParams(p.view).message),
        'publish failure: error shown', pageParams(p.view)?.message);
    check(visible().join() === before.join(), 'publish failure: nothing new cached');
    for (const t of temps())
        Gio.File.new_for_path(`${cache}/${t}`).delete(null);
    p.session.shutdown();
}

// Cache hits and invalidation.
{
    const src = source('step', 'version 1');
    const first = open(src);
    await waitFor(() => settled(first));
    first.session.shutdown();
    const again = open(src);
    await waitFor(() => settled(again));
    check(runsFor(src) === 1 && pageParams(again.view)?.file === pageParams(first.view)?.file,
        'cache: unchanged file reuses the cached mesh');
    again.session.shutdown();

    // Rewritten within the same second (different content and size, same whole-second mtime).
    const info = Gio.File.new_for_path(src).query_info('time::modified', 0, null);
    const sec = info.get_attribute_uint64('time::modified');
    GLib.file_set_contents(src, 'version 2, longer');
    GLib.spawn_command_line_sync(`touch -d @${sec}.5 ${GLib.shell_quote(src)}`);
    const edited = open(src);
    await waitFor(() => settled(edited));
    check(runsFor(src) === 2, 'cache: an edit within the same second converts again');
    edited.session.shutdown();

    // A new install (new converter) never reuses older output.
    const stamp = `${data}/oma-peek/.installed`;
    const [, old] = GLib.file_get_contents(stamp);
    GLib.file_set_contents(stamp, 'another-installed-version');
    const upgraded = open(src);
    await waitFor(() => settled(upgraded));
    check(runsFor(src) === 3, 'cache: a reinstall converts again');
    upgraded.session.shutdown();
    GLib.file_set_contents(stamp, old);
}

// Inputs that can depend on other files are converted per session and never cached.
for (const [ext, label] of [['gltf', '.gltf'], ['scad', 'SCAD']]) {
    const before = visible();
    const p = open(source(ext, ext === 'scad' ? 'cube(10);' : '{"asset":{"version":"2.0"}}'));
    await waitFor(() => settled(p));
    const file = pageParams(p.view)?.file;
    check(pageParams(p.view)?.status === 'model' && GLib.file_test(file, GLib.FileTest.EXISTS),
        `${label}: converted and shown`, pageParams(p.view)?.message);
    p.session.shutdown();
    check(!GLib.file_test(file, GLib.FileTest.EXISTS) && visible().join() === before.join(),
        `${label}: output removed when the preview closes, nothing cached`);
}

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(scratch)}`);
finish(system);
