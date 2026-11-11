// T4: conversion cache (SCAD/CAD -> viewer mesh), driven through real sessions with a fake
// converter installed in place of oma-peek-cad (and a fake openscad on PATH).
// run: XDG_DATA_HOME=<install> XDG_CACHE_HOME=<cache> FIXTURES=<dir> gjs -m tests/conversion.test.js
// Needs a display and webkitgtk-6.0. Exit 77 = skipped.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import * as system from 'system';

import {check, finish} from './lib/sushi.js';
import {fakeLog, installFakeConverter, listDir, pageParams, pidAlive, releaseConverter,
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
const gates = `${scratch}/gates`;
GLib.mkdir_with_parents(gates, 0o755);

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

// The converter is spawned synchronously inside start(), so env set here applies to it only.
function open(path, env = {}) {
    for (const [k, v] of Object.entries(env))
        GLib.setenv(k, v, true);
    const view = new Host.WebKit.WebView();
    Host.configureWebView(view);
    const session = new Host.Session(view);
    session.start(Gio.File.new_for_path(path), '');
    for (const k of Object.keys(env))
        GLib.unsetenv(k);
    return {view, session};
}

const settled = (p) => p.view.get_uri() && ['model', 'error'].includes(pageParams(p.view)?.status);
const runsFor = (path) => fakeLog().filter((l) => l.src === path);
const run = (tag) => fakeLog().find((l) => l.tag === tag);
const visible = () => listDir(cache).filter((f) => !f.startsWith('.'));
const temps = () => listDir(cache).filter((f) => f.startsWith('.'));
const exists = (path) => GLib.file_test(path, GLib.FileTest.EXISTS);

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
    const a = open(src, {FAKE_GATES: gates, FAKE_TAG: 'both-a'});
    const b = open(src, {FAKE_GATES: gates, FAKE_TAG: 'both-b'});
    check(await waitFor(() => run('both-a') && run('both-b')), 'concurrent: both conversions running');
    releaseConverter(gates, run('both-a').pid);
    releaseConverter(gates, run('both-b').pid);
    await waitFor(() => settled(a) && settled(b));
    const pa = pageParams(a.view), pb = pageParams(b.view);
    check(pa?.status === 'model' && pb?.status === 'model', 'concurrent: both previews show the model',
        `${pa?.status}: ${pa?.message} / ${pb?.status}: ${pb?.message}`);
    check(pa?.file === pb?.file && isMpk(pa?.file), 'concurrent: both use one valid cached mesh');
    check(temps().length === 0, 'concurrent: no temp files left', temps().join(','));
    a.session.shutdown();
    b.session.shutdown();
}

// One of two concurrent conversions is cancelled while it has written part of its output;
// the other still publishes.
{
    const src = source('step');
    const a = open(src, {FAKE_GATES: gates, FAKE_TAG: 'cancel-a'});
    const b = open(src, {FAKE_GATES: gates, FAKE_TAG: 'cancel-b'});
    await waitFor(() => run('cancel-a') && run('cancel-b'));
    const ra = run('cancel-a');
    check(exists(ra.out), 'cancel one: its partial output exists before cancelling');
    a.session.shutdown();
    check(await waitFor(() => !pidAlive(ra.pid), 3000), 'cancel one: its converter is killed');
    check(await waitFor(() => !exists(ra.out), 3000), 'cancel one: its partial output is removed');
    releaseConverter(gates, run('cancel-b').pid);
    await waitFor(() => settled(b));
    check(pageParams(b.view)?.status === 'model' && isMpk(pageParams(b.view).file), 'cancel one: the other shows the model');
    check(pageParams(a.view)?.status === 'progress', 'cancel one: the cancelled preview never moves on');
    check(await waitFor(() => temps().length === 0, 2000), 'cancel one: no temp files left', temps().join(','));
    b.session.shutdown();
}

// Converter output that isn't a complete mesh is an error and is not cached.
for (const mode of ['short', 'badmpk', 'truncmpk', 'nanmpk']) {
    const src = source('step');
    const before = visible().length;
    const p = open(src, {FAKE_MODE: mode});
    await waitFor(() => settled(p));
    check(pageParams(p.view)?.status === 'error' && /no usable mesh/.test(pageParams(p.view).message),
        `bad output (${mode}): error shown`, pageParams(p.view)?.message);
    p.session.shutdown();
    check(visible().length === before && temps().length === 0, `bad output (${mode}): nothing cached or left over`);
    const q = open(src);
    await waitFor(() => settled(q));
    check(runsFor(src).length === 2 && pageParams(q.view)?.status === 'model', `bad output (${mode}): converted again next time`);
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

// The source changes while it converts: converted again; if it keeps changing, an error.
{
    const src = source('step');
    GLib.file_set_contents(`${src}.mode`, 'touchsrc');
    const p = open(src);
    await waitFor(() => settled(p));
    check(runsFor(src).length === 2 && pageParams(p.view)?.status === 'model',
        'edited during conversion: converted again and shown', pageParams(p.view)?.message);
    p.session.shutdown();
    const before = visible();
    const src2 = source('step');
    GLib.file_set_contents(`${src2}.mode`, 'alwaystouch');
    const q = open(src2);
    await waitFor(() => settled(q));
    check(pageParams(q.view)?.status === 'error' && /kept changing/.test(pageParams(q.view).message),
        'always changing: error after a retry', pageParams(q.view)?.message);
    check(runsFor(src2).length === 2 && visible().join() === before.join() && temps().length === 0,
        'always changing: nothing cached or left over');
    q.session.shutdown();
}

// The source disappears while it converts: an error, and nothing cached or left over.
{
    const before = visible();
    const src = source('step');
    GLib.file_set_contents(`${src}.mode`, 'rmsrc');
    const p = open(src);
    await waitFor(() => settled(p));
    check(pageParams(p.view)?.status === 'error', 'source removed while converting: error shown', pageParams(p.view)?.message);
    check(visible().join() === before.join() && temps().length === 0, 'source removed while converting: nothing cached or left over',
        temps().join(','));
    p.session.shutdown();
}

// Cache hits and invalidation. Each change below alters exactly one part of the identity.
{
    const touch = (path, stamp) => GLib.spawn_command_line_sync(`touch -d @${stamp} ${GLib.shell_quote(path)}`);
    const src = source('step', 'version 1');
    const sec = Math.floor(Date.now() / 1000) - 60;
    touch(src, `${sec}.25`);
    const convertAndClose = async () => {
        const p = open(src);
        await waitFor(() => settled(p));
        p.session.shutdown();
        return pageParams(p.view)?.file;
    };
    const first = await convertAndClose();
    const again = await convertAndClose();
    check(runsFor(src).length === 1 && again === first, 'cache: unchanged file reuses the cached mesh');

    GLib.file_set_contents(src, 'version 2');            // same size
    touch(src, `${sec}.75`);                             // same second, different fraction
    await convertAndClose();
    check(runsFor(src).length === 2, 'cache: same-size edit within the same second converts again');

    GLib.file_set_contents(src, 'version 3, longer');    // different size
    touch(src, `${sec}.75`);                             // identical timestamp
    await convertAndClose();
    check(runsFor(src).length === 3, 'cache: a size change with the same timestamp converts again');

    const stamp = `${data}/oma-peek/.installed`;
    const [, old] = GLib.file_get_contents(stamp);
    GLib.file_set_contents(stamp, 'another-installed-version');
    await convertAndClose();
    check(runsFor(src).length === 4, 'cache: a reinstall converts again');
    GLib.file_set_contents(stamp, old);
}

// Inputs that can depend on other files are converted per session and never cached.
for (const [ext, label] of [['gltf', '.gltf'], ['scad', 'SCAD']]) {
    const before = visible();
    const p = open(source(ext, ext === 'scad' ? 'cube(10);' : '{"asset":{"version":"2.0"}}'));
    await waitFor(() => settled(p));
    const file = pageParams(p.view)?.file;
    check(pageParams(p.view)?.status === 'model' && exists(file), `${label}: converted and shown`, pageParams(p.view)?.message);
    p.session.shutdown();
    check(!exists(file) && visible().join() === before.join(), `${label}: output removed when the preview closes, nothing cached`);
}

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(scratch)}`);
finish(system);
