// oma-peek: 3D model previews (STL, 3MF, OBJ, SCAD, STEP, IGES, glTF) for Sushi 51+, the
// Nautilus spacebar previewer. Installed as ~/.local/share/sushi/plugins-1/oma-peek.js.
// The viewer is a three.js page in ~/.local/share/oma-peek/web, driven by
// ~/.local/share/oma-peek/host.js (kept out of plugins-1: Sushi imports every .js there).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Renderer} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';

let Host = null;
try {
    const host = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek', 'host.js']);
    Host = await import(GLib.filename_to_uri(host, null));
} catch (e) {
    console.warn(`oma-peek: runtime not installed (${e.message}); run install.sh`);
}

const available = Host?.isAvailable() ?? false;
if (Host && !available)
    console.warn('oma-peek: WebKitGTK 6.0 (webkitgtk-6.0) is not installed; 3D previews are off');

export const Klass = available ? class OmaPeekRenderer extends Host.WebKit.WebView {
    static {
        GObject.registerClass({
            Implements: [Renderer],
        }, this);
    }

    #session;

    constructor(file, fileInfo, constructProperties = {}) {
        super(constructProperties);
        Host.configureWebView(this);
        this.#session = new Host.Session(this, {
            onReady: () => {
                this.markReady();
                this.grab_focus();
            },
            onFailed: (error) => this.markFailed(error),
        });
        this.markInitialized();
        this.#session.start(file, fileInfo?.get_content_type() ?? '');
    }

    // Sushi calls stop() when the preview closes or moves on, even if this widget was never
    // shown; cleanup() runs on unmap. Both end the session.
    stop() {
        this.#session.shutdown();
    }

    cleanup() {
        this.#session.shutdown();
    }

    get topBarStyle() {
        return Adw.ToolbarStyle.RAISED_BORDER;
    }
} : undefined;

export const contentTypes = available ? Host.mimeTypes() : [];
