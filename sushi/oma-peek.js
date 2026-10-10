// oma-peek: 3D model previews (STL, 3MF, OBJ, SCAD, STEP, IGES, glTF) for Sushi / Nautilus spacebar.
// The viewer itself is a three.js page in ~/.local/share/oma-peek/web.

const {Gio, GLib, GObject} = imports.gi;

var WebKit2;
try {
    imports.gi.versions.WebKit2 = '4.1';
    WebKit2 = imports.gi.WebKit2;
} catch (e) {
}

const Renderer = imports.ui.renderer;

const WEB_ROOT = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek', 'web', 'index.html']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'oma-peek']);
const THEME_COLORS = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml']);

const SCAD_TYPES = ['application/x-openscad', 'text/x-openscad'];
// CAD formats are converted by oma-peek-cad (OpenCASCADE) to the viewer's .mpk format.
const CAD_TYPES = ['model/step', 'model/iges', 'model/gltf+json', 'model/gltf-binary'];
const CAD_EXTS = ['step', 'stp', 'iges', 'igs', 'gltf', 'glb'];
const CAD_CONVERTER = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek', 'oma-peek-cad']);

function _isAvailable() {
    return WebKit2 !== undefined && GLib.file_test(WEB_ROOT, GLib.FileTest.EXISTS);
}

function _readTheme() {
    let theme = {};
    try {
        let [, bytes] = GLib.file_get_contents(THEME_COLORS);
        let text = new TextDecoder().decode(bytes);
        for (let m of text.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"/gm))
            theme[m[1]] = m[2];
    } catch (e) {
    }
    return theme;
}

function _extOf(path) {
    let m = /\.([^./]+)$/.exec(path);
    return m ? m[1].toLowerCase() : '';
}

// Convert a file with an external tool into the cache, keyed by path + mtime.
// argv(out) builds the command line; callback(outPath | null, errorText).
function _convertCached(file, ext, argv, callback) {
    let path = file.get_path();
    let info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
    let key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1,
        `${path}:${info.get_attribute_uint64('time::modified')}`, -1);
    let out = GLib.build_filenamev([CACHE_DIR, `${key}.${ext}`]);
    if (GLib.file_test(out, GLib.FileTest.EXISTS)) {
        callback(out, null);
        return;
    }
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    let tmp = `${out}.tmp.${ext}`;
    let proc;
    try {
        proc = Gio.Subprocess.new(argv(tmp),
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        callback(null, e.message);
        return;
    }
    proc.communicate_utf8_async(null, null, (p, res) => {
        let stderr = '';
        try {
            [, , stderr] = p.communicate_utf8_finish(res);
        } catch (e) {
            stderr = e.message;
        }
        if (p.get_successful() && GLib.file_test(tmp, GLib.FileTest.EXISTS)) {
            GLib.rename(tmp, out);
            callback(out, null);
        } else {
            GLib.unlink(tmp);
            let lines = (stderr || 'conversion failed').trim().split('\n');
            callback(null, lines.filter((l) => /ERROR|error/.test(l)).slice(-3).join('\n') || lines.slice(-3).join('\n'));
        }
    });
}

function _scadToStl(file, callback) {
    _convertCached(file, 'stl', (out) => ['openscad', '-o', out, file.get_path()], callback);
}

function _cadToMpk(file, callback) {
    _convertCached(file, 'mpk', (out) => [CAD_CONVERTER, file.get_path(), out], callback);
}

var Klass = _isAvailable() ? GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '',
                                              GObject.ParamFlags.READABLE,
                                              false),
        ready: GObject.ParamSpec.boolean('ready', '', '',
                                         GObject.ParamFlags.READABLE,
                                         false),
    },
}, class MeshRenderer extends WebKit2.WebView {
    get ready() {
        return !!this._ready;
    }

    get fullscreen() {
        return !!this._fullscreen;
    }

    _init(file, fileInfo) {
        super._init();

        let settings = this.get_settings();
        settings.enable_webgl = true;
        settings.allow_file_access_from_file_urls = true;
        settings.allow_universal_access_from_file_urls = true;
        settings.enable_developer_extras = GLib.getenv('OMA_PEEK_DEBUG') !== null;
        settings.enable_write_console_messages_to_stdout = GLib.getenv('OMA_PEEK_DEBUG') !== null;

        if (!settings.enable_developer_extras)
            this.connect('context-menu', () => true);
        this.connect('load-failed', (view, loadEvent, uri, error) => {
            this.emit('error', error);
        });

        let theme = _readTheme();
        let contentType = fileInfo ? fileInfo.get_content_type() : '';
        let path = file.get_path();
        if (SCAD_TYPES.includes(contentType) || _extOf(path) === 'scad') {
            this._load(null, path, theme, 'Rendering with OpenSCAD…');
            _scadToStl(file, (stl, err) => {
                if (stl)
                    this._load(stl, path, theme);
                else
                    this._load(null, path, theme, `OpenSCAD could not render this file\n${err}`);
            });
        } else if (CAD_TYPES.includes(contentType) || CAD_EXTS.includes(_extOf(path))) {
            this._load(null, path, theme, 'Reading CAD file…');
            _cadToMpk(file, (mpk, err) => {
                if (mpk)
                    this._load(mpk, path, theme);
                else
                    this._load(null, path, theme, `Could not read this file\n${err}`);
            });
        } else {
            this._load(path, path, theme);
        }
        this.isReady();
    }

    _load(modelPath, originalPath, theme, message) {
        let q = new Map([
            ['name', GLib.path_get_basename(originalPath)],
            ['theme', JSON.stringify(theme)],
        ]);
        if (modelPath) {
            q.set('file', modelPath);
            q.set('ext', _extOf(modelPath));
        }
        if (message)
            q.set('message', message);
        let query = [...q].map(([k, v]) => `${k}=${GLib.uri_escape_string(v, null, false)}`).join('&');
        this.load_uri(`${GLib.filename_to_uri(WEB_ROOT, null)}?${query}`);
    }

    get moveOnClick() {
        return false;
    }
}) : undefined;

var mimeTypes = [];
if (_isAvailable()) {
    mimeTypes = [
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
    if (GLib.file_test(CAD_CONVERTER, GLib.FileTest.IS_EXECUTABLE))
        mimeTypes.push(...CAD_TYPES);
}
