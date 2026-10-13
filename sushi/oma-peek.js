// oma-peek: 3D model previews (STL, 3MF, OBJ, SCAD, STEP, IGES, glTF) for Sushi / Nautilus spacebar.
// The viewer itself is a three.js page in ~/.local/share/oma-peek/web, loaded by the shared
// ~/.local/share/oma-peek/omaPeekHost.js.

const {GLib, GObject} = imports.gi;

const Renderer = imports.ui.renderer;

var Host;
try {
    let dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek']);
    if (!imports.searchPath.includes(dir))
        imports.searchPath.push(dir);
    Host = imports.omaPeekHost;
} catch (e) {
}

const available = Host !== undefined && Host.isAvailable();

var Klass = available ? GObject.registerClass({
    Implements: [Renderer.Renderer],
    Properties: {
        fullscreen: GObject.ParamSpec.boolean('fullscreen', '', '',
                                              GObject.ParamFlags.READABLE,
                                              false),
        ready: GObject.ParamSpec.boolean('ready', '', '',
                                         GObject.ParamFlags.READABLE,
                                         false),
    },
}, class MeshRenderer extends Host.WebKit2.WebView {
    get ready() {
        return !!this._ready;
    }

    get fullscreen() {
        return !!this._fullscreen;
    }

    _init(file, fileInfo) {
        super._init();

        Host.configureWebView(this);
        this.connect('load-failed', (view, loadEvent, uri, error) => {
            this.emit('error', error);
        });

        Host.loadModel(this, file, fileInfo ? fileInfo.get_content_type() : '');
        this.isReady();
    }

    get moveOnClick() {
        return false;
    }
}) : undefined;

var mimeTypes = available ? Host.mimeTypes() : [];
