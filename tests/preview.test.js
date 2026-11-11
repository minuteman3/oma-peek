// T2b + T3: the installed Sushi plugin renders models, reports errors in the page, and follows
// Sushi's renderer lifecycle (ready once; stop before/after ready and during conversion).
// run: XDG_DATA_HOME=<install> XDG_CACHE_HOME=<cache> FIXTURES=<dir> gjs -m tests/preview.test.js
// Needs a display (Wayland), Sushi 51 and webkitgtk-6.0. Exit 77 = skipped.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as system from 'system';

import {bootSushi, check, finish} from './lib/sushi.js';
import {fakeLog, installFakeConverter, listDir, pageParams, pageState, pidAlive, sleep,
    snapshotCoverage, waitFor} from './lib/view.js';

if (!(await bootSushi())) {
    print('# skip: Sushi 51 or newer is not installed');
    system.exit(77);
}
const Gtk = (await import('gi://Gtk?version=4.0')).default;
const {stopRenderer} = await import('resource:///org/gnome/NautilusPreviewer/js/core/renderer.js');
const data = GLib.get_user_data_dir();
const plugin = await import(GLib.filename_to_uri(`${data}/sushi/plugins-1/oma-peek.js`, null));
const WebKit = (await import('gi://WebKit?version=6.0')).default;
const fixtures = GLib.getenv('FIXTURES');
const scratch = GLib.dir_make_tmp('oma-peek-preview-XXXXXX');

function open(path, {show = true} = {}) {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::content-type', 0, null);
    const r = new plugin.Klass(file, info);
    r.readyCount = 0;
    r.failure = null;
    r.connect('ready', () => r.readyCount++);
    r.connect('failed', (_r, e) => { r.failure = e; });
    if (show) {
        r.window = new Gtk.Window({default_width: 800, default_height: 600, child: r});
        r.window.present();
    }
    return r;
}

function close(r) {
    stopRenderer(r);
    r.window?.destroy();
}

// --- T2b: rendering -----------------------------------------------------------------------
{
    const r = open(`${fixtures}/box-binary.stl`);
    check(await waitFor(() => r.readyCount > 0), 'STL: renderer becomes ready');
    let s = null;
    await waitFor(async () => (s = await pageState(r)).msgHidden && s.info.includes('triangles'));
    check(s?.msgHidden === true, 'STL: message hidden once the model is shown', JSON.stringify(s));
    check(/20\.0 × 10\.0 × 5\.0 mm/.test(s?.info) && /\b12 triangles/.test(s?.info),
        'STL: info shows the fixture size and triangle count', s?.info);
    await sleep(500);
    const noFrames = GLib.getenv('OMA_PEEK_TEST_NO_FRAMES');
    if (noFrames) {
        print(`# skip: drawn-model snapshot check (${noFrames})`);
    } else {
        const coverage = await snapshotCoverage(r, WebKit);
        check(coverage > 0.5, 'STL: the model is drawn in the centre of the view', `coverage ${coverage.toFixed(2)}`);
    }
    check(r.readyCount === 1 && r.failure === null, 'STL: ready exactly once, no failure');

    // WebGL disabled through WebKit's own setting: the page must say so, not hang on "Loading…".
    r.get_settings().enable_webgl = false;
    r.reload();
    const sawWebGlError = await waitFor(async () => {
        const st = await pageState(r).catch(() => null);
        return st && !st.msgHidden && st.msgClass === 'error' && /WebGL/.test(st.msg);
    });
    check(sawWebGlError, 'no WebGL: the page shows a 3D-unavailable error');
    close(r);
}
{
    const r = open(`${fixtures}/empty-ascii.stl`);
    check(await waitFor(() => r.readyCount > 0), 'empty STL: renderer becomes ready (error page)');
    let s = null;
    await waitFor(async () => !(s = await pageState(r)).msgHidden && s.msgClass === 'error');
    check(s?.msgClass === 'error' && /no geometry/.test(s?.msg), 'empty STL: page shows the error', JSON.stringify(s));
    check(r.failure === null, 'empty STL: an in-page error is not a renderer failure');
    close(r);
}

// --- T3: lifecycle ------------------------------------------------------------------------
{
    // (a) Stopped before the first page finished loading, never shown (Sushi does this when
    // the user moves on quickly). Showing it afterwards forces WebKit to run: the stopped
    // session must not resume the load or report ready.
    const r = open(`${fixtures}/box-binary.stl`, {show: false});
    stopRenderer(r);
    r.window = new Gtk.Window({default_width: 400, default_height: 300, child: r});
    r.window.present();
    await sleep(2000);
    let s = null;
    try {
        s = await pageState(r);
    } catch (e) {
        // no document at all: nothing loaded, as intended
    }
    check(r.readyCount === 0, 'stopped before load: never becomes ready');
    check(!s?.info, 'stopped before load: the model was never loaded', JSON.stringify(s));
    r.window.destroy();
}
{
    // (b) Stopped after ready.
    const r = open(`${fixtures}/box-binary.stl`);
    await waitFor(() => r.readyCount > 0);
    close(r);
    await sleep(300);
    check(r.readyCount === 1 && r.failure === null, 'stopped after ready: no extra signals');
}
{
    // (c) Stopped during a conversion that has written part of its output: the converter is
    // killed, the partial output removed, and the model page never loads.
    installFakeConverter();
    GLib.setenv('FAKE_LOG', `${scratch}/converter.log`, true);
    GLib.setenv('FAKE_MPK', `${fixtures}/assembly.mpk`, true);
    GLib.mkdir_with_parents(`${scratch}/gates`, 0o755);
    GLib.setenv('FAKE_GATES', `${scratch}/gates`, true);
    const step = `${scratch}/part.step`;
    GLib.file_set_contents(step, 'ISO-10303-21; fake');
    const r = open(step);
    GLib.unsetenv('FAKE_GATES');
    check(await waitFor(() => fakeLog().length === 1), 'conversion: converter started');
    const {pid, out} = fakeLog()[0] ?? {};
    check(GLib.file_test(out ?? '', GLib.FileTest.EXISTS), 'conversion: partial output written');
    check(pageParams(r)?.status === 'progress', 'conversion: progress page shown while converting');
    close(r);
    check(await waitFor(() => !pidAlive(pid), 3000), 'stopped during conversion: converter process killed');
    check(await waitFor(() => !GLib.file_test(out, GLib.FileTest.EXISTS), 3000), 'stopped during conversion: partial output removed');
    const cache = `${GLib.get_user_cache_dir()}/oma-peek/models`;
    check(listDir(cache).length === 0, 'stopped during conversion: nothing cached', listDir(cache).join(','));
    check(pageParams(r)?.status !== 'model', 'stopped during conversion: model page never loaded');
}
{
    // A viewer page whose script never starts (here: a module with a syntax error) fails the
    // preview instead of showing "Loading…" forever. Runs last: it breaks the installed page.
    const state = `${data}/oma-peek/web/state.js`;
    GLib.file_set_contents(state, 'export const broken = ;\n');
    const r = open(`${fixtures}/box-binary.stl`);
    check(await waitFor(() => r.failure !== null, 10000), 'broken page: the preview fails', r.failure?.message);
    check(r.readyCount === 0, 'broken page: never reported ready');
    close(r);
}

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(scratch)}`);
finish(system);
