// oma-peek host: shows a model in the three.js viewer page (web/) inside a WebKitGTK 6.0 WebView.
// Shared by the Sushi plugin (sushi/oma-peek.js) and the standalone window (gjs/oma-peek-open.js).
// Installed as ~/.local/share/oma-peek/host.js and imported as an ES module.
//
// Session (one per view) runs this lifecycle:
//
//   Created -start-> PageLoading -> [Converting] -> ModelLoading -> Shown
//   any -shutdown()-> Closed        any -load-failed / web process died-> Failed
//
// "Shown" includes the page showing an error for a broken file: that is a successful preview
// of an error. The page reports 'started' once its script runs and 'ready' once it shows
// something; readiness comes only from 'ready'. A document that finishes loading without
// 'started' (its script failed to load) fails the session.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export let WebKit = null;
try {
    WebKit = (await import('gi://WebKit?version=6.0')).default;
} catch (e) {
    // webkitgtk-6.0 not installed: isAvailable() is false and callers fall back.
}

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'skip_async', 'skip_finish');

const RUNTIME_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek']);
const WEB_ROOT = GLib.build_filenamev([RUNTIME_DIR, 'web', 'index.html']);
const STAMP = GLib.build_filenamev([RUNTIME_DIR, '.installed']);
const CAD_CONVERTER = GLib.build_filenamev([RUNTIME_DIR, 'oma-peek-cad']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'oma-peek', 'models']);
const THEME_COLORS = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml']);

const SCAD_TYPES = ['application/x-openscad', 'text/x-openscad'];
// CAD formats are converted by oma-peek-cad (OpenCASCADE) to the viewer's .mpk format.
const CAD_TYPES = ['model/step', 'model/iges', 'model/gltf+json', 'model/gltf-binary'];
const CAD_EXTS = ['step', 'stp', 'iges', 'igs', 'gltf', 'glb'];
// After a document finishes loading, its script must report that it started within this
// time; otherwise the page is broken (e.g. a module failed to load) and the preview fails.
const PAGE_START_TIMEOUT_MS = 5000;
const MESSAGE_HANDLER = 'omaPeek';

export function isAvailable() {
    return WebKit !== null && GLib.file_test(WEB_ROOT, GLib.FileTest.EXISTS);
}

function hasCadConverter() {
    return GLib.file_test(CAD_CONVERTER, GLib.FileTest.IS_EXECUTABLE);
}

// MIME types the viewer can show.
export function mimeTypes() {
    const types = [
        'model/stl',
        'model/x.stl-ascii',
        'model/x.stl-binary',
        'application/sla',
        'application/vnd.ms-pki.stl',
        'model/3mf',
        'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
        'model/obj',
        ...SCAD_TYPES,
    ];
    if (hasCadConverter())
        types.push(...CAD_TYPES);
    return types;
}

// WebView settings the viewer page needs (WebGL, reading the model from file://).
export function configureWebView(view) {
    const settings = view.get_settings();
    const debug = GLib.getenv('OMA_PEEK_DEBUG') !== null;
    settings.enable_webgl = true;
    settings.allow_file_access_from_file_urls = true;
    settings.allow_universal_access_from_file_urls = true;
    settings.enable_developer_extras = debug;
    settings.enable_write_console_messages_to_stdout = debug;
    if (!debug)
        view.connect('context-menu', () => true);
}

function readTheme() {
    const theme = {};
    try {
        const [, bytes] = GLib.file_get_contents(THEME_COLORS);
        const text = new TextDecoder().decode(bytes);
        for (const m of text.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm))
            theme[m[1]] = m[2];
    } catch (e) {
        // No Omarchy theme: the page uses its defaults.
    }
    return theme;
}

function extOf(path) {
    const m = /\.([^./]+)$/.exec(path);
    return m ? m[1].toLowerCase() : '';
}

function unlinkQuietly(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch (e) {
        // already gone
    }
}

function cancelledError() {
    return new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Operation was cancelled');
}

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// --- conversion (SCAD and CAD formats) ---------------------------------------------------
//
// Each attempt: Converting(tmp) -> Validating -> Publishing -> Cached, or Failed / Cancelled
// with nothing cached. Every attempt writes its own temp file next to the cache entry, so
// concurrent attempts never share a file and publication is an atomic rename. Only
// self-contained inputs are cached across sessions; SCAD (include/use) and .gltf (external
// buffers) can depend on files we don't track, so their output lives only for the session.

function conversionFor(file, contentType) {
    const path = file.get_path();
    const ext = extOf(path);
    if (SCAD_TYPES.includes(contentType) || ext === 'scad') {
        return {
            argv: (out) => ['openscad', '-o', out, path],
            outExt: 'stl',
            persistent: false,
            progress: 'Rendering with OpenSCAD…',
            failure: 'OpenSCAD could not render this file',
        };
    }
    if (CAD_TYPES.includes(contentType) || CAD_EXTS.includes(ext)) {
        return {
            argv: (out) => [CAD_CONVERTER, path, out],
            outExt: 'mpk',
            persistent: ext !== 'gltf' && contentType !== 'model/gltf+json',
            progress: 'Reading CAD file…',
            failure: 'Could not read this file',
        };
    }
    return null;
}

// Modification time to the nanosecond (when the filesystem has it) plus size.
function sourceIdentity(file) {
    const info = file.query_info('time::modified,time::modified-usec,time::modified-nsec,standard::size',
        Gio.FileQueryInfoFlags.NONE, null);
    const sec = info.get_attribute_uint64('time::modified');
    const nsec = info.has_attribute('time::modified-nsec')
        ? info.get_attribute_uint32('time::modified-nsec')
        : info.get_attribute_uint32('time::modified-usec') * 1000;
    return `${sec}.${nsec}:${info.get_size()}`;
}

// The installed fingerprint: a new install (new converter) never reuses older output.
function converterIdentity() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(STAMP)[1]).trim();
    } catch (e) {
        return 'uninstalled';
    }
}

function summarize(stderr) {
    const lines = (stderr || 'conversion failed').trim().split('\n');
    return lines.filter((l) => /error/i.test(l)).slice(-3).join('\n') || lines.slice(-3).join('\n');
}

async function runConverter(argv, cancellable) {
    if (cancellable.is_cancelled())
        throw cancelledError();
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    // Gio.Cancellable.connect runs the callback at once if already cancelled.
    const id = cancellable.connect(() => proc.force_exit());
    let stderr = '';
    try {
        [, stderr] = await proc.communicate_utf8_async(null, null);
    } catch (e) {
        stderr = e.message;
    }
    // The writer must have exited before the caller removes its output file.
    await proc.wait_async(null);
    cancellable.disconnect(id);
    if (cancellable.is_cancelled())
        throw cancelledError();
    if (!proc.get_successful())
        throw new Error(summarize(stderr));
}

function readHead(path, n) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        const out = new Uint8Array(n);
        let got = 0;
        while (got < n) {
            const chunk = stream.read_bytes(Math.min(n - got, 1 << 20), null).toArray();
            if (!chunk.length)
                break;
            out.set(chunk, got);
            got += chunk.length;
        }
        return out.subarray(0, got);
    } finally {
        stream.close(null);
    }
}

const BAD_OUTPUT = 'the converter produced no usable mesh';
const SCAN_CHUNK = 4 << 20;

// Check that `length` bytes of float32 data starting at `start` are all finite. Reads in
// chunks asynchronously, so the previewer stays responsive (and cancellable) on big meshes.
async function checkFiniteFloats(path, start, length, cancellable) {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        for (let skipped = 0; skipped < start;) {
            const n = await stream.skip_async(start - skipped, GLib.PRIORITY_DEFAULT, cancellable);
            if (n <= 0)
                throw new Error(BAD_OUTPUT);
            skipped += n;
        }
        let remaining = length;
        let carry = new Uint8Array(0);
        while (remaining > 0) {
            const chunk = (await stream.read_bytes_async(Math.min(SCAN_CHUNK, remaining),
                GLib.PRIORITY_DEFAULT, cancellable)).toArray();
            if (!chunk.length)
                throw new Error(BAD_OUTPUT);
            remaining -= chunk.length;
            let buf = chunk;
            if (carry.length) {
                buf = new Uint8Array(carry.length + chunk.length);
                buf.set(carry);
                buf.set(chunk, carry.length);
            }
            const whole = buf.length - (buf.length % 4);
            const dv = new DataView(buf.buffer, buf.byteOffset, whole);
            for (let off = 0; off < whole; off += 4) {
                if (!Number.isFinite(dv.getFloat32(off, true)))
                    throw new Error(BAD_OUTPUT);
            }
            carry = buf.slice(whole);
        }
    } finally {
        stream.close(null);
    }
}

// Converter output must be complete before it is shown or cached. STL: a binary STL whose
// size matches its triangle count, or ASCII. MPK: magic, a JSON header listing parts with
// triangle counts, and exactly that many triangles (9 finite float32 each) after it.
async function validateOutput(path, outExt, cancellable) {
    const size = Gio.File.new_for_path(path).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    const head = readHead(path, 84);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (outExt === 'stl') {
        const ascii = new TextDecoder().decode(head.subarray(0, 5)) === 'solid';
        const binary = size >= 84 && size === 84 + 50 * dv.getUint32(80, true);
        if (!ascii && !binary)
            throw new Error(BAD_OUTPUT);
        return;
    }
    if (size < 8 || new TextDecoder().decode(head.subarray(0, 4)) !== 'MPK1')
        throw new Error(BAD_OUTPUT);
    const len = dv.getUint32(4, true);
    if (8 + len > size)
        throw new Error(BAD_OUTPUT);
    let header;
    try {
        header = JSON.parse(new TextDecoder().decode(readHead(path, 8 + len).subarray(8)));
    } catch (e) {
        throw new Error(BAD_OUTPUT);
    }
    const parts = header?.parts;
    if (!Array.isArray(parts) || !parts.length || !parts.every((p) => Number.isInteger(p?.n) && p.n > 0))
        throw new Error(BAD_OUTPUT);
    const triangles = parts.reduce((t, p) => t + p.n, 0);
    if (size !== 8 + len + triangles * 36)
        throw new Error(BAD_OUTPUT);
    // Every coordinate must be a finite number (the viewer rejects NaN and infinities).
    await checkFiniteFloats(path, 8 + len, triangles * 36, cancellable);
}

// --- cache upkeep ------------------------------------------------------------------------
//
// A cached mesh's modification time records when it was last used (set on every hit), so:
//   Cached -hit-> Cached (last use = now)
//   Cached -unused for CACHE_MAX_IDLE-> Evicted
//   Cached -cache over CACHE_MAX_BYTES-> Evicted, least recently used first
// An entry used within CACHE_IN_USE is never evicted: an open preview may still be reading it.
// Temp files ('.'-prefixed) older than TEMP_MAX_AGE were left by a crashed previewer.
// Pruning runs after each publication, the only time the cache grows.
const CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const CACHE_MAX_IDLE = 30 * 24 * 3600;
const CACHE_IN_USE = 10 * 60;
const TEMP_MAX_AGE = 24 * 3600;

function markUsed(path) {
    try {
        Gio.File.new_for_path(path).set_attribute_uint64('time::modified', Math.floor(Date.now() / 1000),
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        // a read-only cache still works; it just ages by publication time
    }
}

function pruneCache() {
    let entries;
    try {
        const e = Gio.File.new_for_path(CACHE_DIR).enumerate_children(
            'standard::name,standard::size,standard::type,time::modified', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        entries = [...e].filter((i) => i.get_file_type() === Gio.FileType.REGULAR).map((i) => ({
            name: i.get_name(), size: i.get_size(), used: i.get_attribute_uint64('time::modified'),
        }));
    } catch (e) {
        return;
    }
    const now = Math.floor(Date.now() / 1000);
    const remove = (name) => unlinkQuietly(GLib.build_filenamev([CACHE_DIR, name]));
    const kept = [];
    for (const entry of entries) {
        const age = now - entry.used;
        if (entry.name.startsWith('.'))
            age > TEMP_MAX_AGE && remove(entry.name);
        else if (age > CACHE_MAX_IDLE)
            remove(entry.name);
        else
            kept.push(entry);
    }
    let total = kept.reduce((t, x) => t + x.size, 0);
    for (const entry of kept.sort((a, b) => a.used - b.used)) {
        if (total <= CACHE_MAX_BYTES)
            break;
        if (now - entry.used <= CACHE_IN_USE)
            continue;
        remove(entry.name);
        total -= entry.size;
    }
}

// Resolves to {path, temporary}; temporary outputs belong to the caller.
async function convert(file, conversion, cancellable, attempts = 2) {
    const path = file.get_path();
    GLib.mkdir_with_parents(CACHE_DIR, 0o700);
    const identity = sourceIdentity(file);
    // JSON, not NUL separators: the checksum input is a C string.
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
        JSON.stringify([path, identity, converterIdentity()]), -1);
    const out = GLib.build_filenamev([CACHE_DIR, `${key}.${conversion.outExt}`]);
    if (conversion.persistent && GLib.file_test(out, GLib.FileTest.EXISTS)) {
        markUsed(out);
        return {path: out, temporary: false};
    }

    // This attempt owns tmp until it is published or handed to the caller; any other way
    // out (error, cancellation, the source changing or vanishing) removes it.
    const tmp = GLib.build_filenamev([CACHE_DIR, `.${key}.${GLib.uuid_string_random()}.${conversion.outExt}`]);
    let owned = true;
    let changed = false;
    try {
        await runConverter(conversion.argv(tmp), cancellable);
        await validateOutput(tmp, conversion.outExt, cancellable);
        // Edited while converting: the output may mix old and new content.
        changed = sourceIdentity(file) !== identity;
        if (changed) {
            if (attempts <= 1)
                throw new Error('the file kept changing during conversion');
        } else if (!conversion.persistent) {
            owned = false;
            return {path: tmp, temporary: true};
        } else {
            try {
                Gio.File.new_for_path(tmp).move(Gio.File.new_for_path(out), Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch (e) {
                throw new Error(`could not save the converted file: ${e.message}`);
            }
            owned = false;
            pruneCache();
            return {path: out, temporary: false};
        }
    } finally {
        if (owned)
            unlinkQuietly(tmp);
    }
    return convert(file, conversion, cancellable, attempts - 1);
}

// --- session -----------------------------------------------------------------------------

export class Session {
    #view;
    #onReady;
    #onFailed;
    #cancellable = new Gio.Cancellable();
    #handlers = [];
    #contentManager = null;
    #startTimer = 0;
    #pageStarted = false;
    #temps = [];
    #ready = false;
    #closed = false;

    // onReady(): the page shows something (call at most once). onFailed(GLib.Error): the view
    // itself failed (load error, web process died); the session is closed afterwards.
    constructor(view, {onReady = () => {}, onFailed = () => {}} = {}) {
        this.#view = view;
        this.#onReady = onReady;
        this.#onFailed = onFailed;
    }

    get closed() {
        return this.#closed;
    }

    start(file, contentType = '') {
        const view = this.#view;
        this.#contentManager = view.get_user_content_manager();
        this.#contentManager.register_script_message_handler(MESSAGE_HANDLER, null);
        this.#connect(this.#contentManager, `script-message-received::${MESSAGE_HANDLER}`,
            (_m, value) => this.#onMessage(value));
        this.#connect(view, 'load-changed', (_v, event) => {
            // Each navigation must start its own script.
            if (event === WebKit.LoadEvent.STARTED) {
                this.#pageStarted = false;
                this.#clearStartTimer();
            } else if (event === WebKit.LoadEvent.FINISHED && !this.#pageStarted) {
                this.#armStartTimer();
            }
        });
        this.#connect(view, 'load-failed', (_v, _event, _uri, error) => {
            this.#onLoadFailed(error);
            return false;
        });
        this.#connect(view, 'web-process-terminated', (_v, reason) => {
            if (reason !== WebKit.WebProcessTerminationReason.TERMINATED_BY_API)
                this.#fail(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED,
                    reason === WebKit.WebProcessTerminationReason.EXCEEDED_MEMORY_LIMIT
                        ? 'The 3D view ran out of memory' : 'The 3D view crashed'));
        });
        this.#run(file, contentType).catch((e) => {
            if (!this.#closed && !isCancelled(e))
                this.#load(file, {status: 'error', message: `Could not show this file\n${e.message}`});
        });
    }

    // Idempotent; reachable from Renderer.stop() (even if never mapped) and cleanup().
    shutdown() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#cancellable.cancel();
        this.#clearStartTimer();
        for (const [obj, id] of this.#handlers)
            obj.disconnect(id);
        this.#handlers = [];
        this.#contentManager?.unregister_script_message_handler(MESSAGE_HANDLER, null);
        this.#view.stop_loading();
        for (const t of this.#temps)
            unlinkQuietly(t);
        this.#temps = [];
    }

    #connect(obj, signal, handler) {
        this.#handlers.push([obj, obj.connect(signal, handler)]);
    }

    async #run(file, contentType) {
        const path = file.get_path();
        if (!path) {
            this.#load(file, {status: 'error', message: 'oma-peek can only preview local files'});
            return;
        }
        const conversion = conversionFor(file, contentType);
        if (!conversion) {
            this.#load(file, {status: 'model', file: path, ext: extOf(path)});
            return;
        }
        this.#load(file, {status: 'progress', message: conversion.progress});
        let result;
        try {
            result = await convert(file, conversion, this.#cancellable);
        } catch (e) {
            if (!this.#closed && !isCancelled(e))
                this.#load(file, {status: 'error', message: `${conversion.failure}\n${e.message}`});
            return;
        }
        if (result.temporary) {
            if (this.#closed) {
                unlinkQuietly(result.path);
                return;
            }
            this.#temps.push(result.path);
        }
        this.#load(file, {status: 'model', file: result.path, ext: conversion.outExt});
    }

    #load(file, params) {
        if (this.#closed)
            return;
        const q = {name: file.get_basename() ?? '', theme: JSON.stringify(readTheme()), ...params};
        const query = Object.entries(q)
            .map(([k, v]) => `${k}=${GLib.uri_escape_string(v, null, false)}`).join('&');
        this.#view.load_uri(`${GLib.filename_to_uri(WEB_ROOT, null)}?${query}`);
    }

    #onMessage(value) {
        let msg;
        try {
            msg = JSON.parse(value.to_string());
        } catch (e) {
            return;
        }
        if (msg?.event === 'started' || msg?.event === 'ready') {
            this.#pageStarted = true;
            this.#clearStartTimer();
        }
        if (msg?.event === 'ready')
            this.#markReady();
    }

    #armStartTimer() {
        if (this.#startTimer || this.#closed)
            return;
        this.#startTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAGE_START_TIMEOUT_MS, () => {
            this.#startTimer = 0;
            this.#fail(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED,
                'The 3D viewer page did not start; reinstall oma-peek'));
            return GLib.SOURCE_REMOVE;
        });
    }

    #clearStartTimer() {
        if (this.#startTimer) {
            GLib.source_remove(this.#startTimer);
            this.#startTimer = 0;
        }
    }

    #markReady() {
        if (this.#ready || this.#closed)
            return;
        this.#ready = true;
        this.#onReady();
    }

    #onLoadFailed(error) {
        // Replacing the progress page with the model page cancels the first load.
        if (error.matches(WebKit.NetworkError, WebKit.NetworkError.CANCELLED) ||
            error.matches(WebKit.PolicyError, WebKit.PolicyError.FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE))
            return;
        this.#fail(error);
    }

    #fail(error) {
        if (this.#closed)
            return;
        this.#onFailed(error);
        this.shutdown();
    }
}
