// oma-peek-open: show 3D models in the oma-peek viewer, one window per file.
// Used by the Strata custom action, or directly: gjs -m oma-peek-open.js FILE...
// A single-instance GtkApplication, so later calls open their windows in the running process.
// Escape, Q or Space closes a window; R, 1-9 and 0 work as in the Sushi preview.

import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {exit, programArgs, programInvocationName} from 'system';

import * as Host from './host.js';

const APP_ID = 'io.github.minuteman3.OmaPeek';
const CLOSE_KEYS = [Gdk.KEY_Escape, Gdk.KEY_q, Gdk.KEY_Q, Gdk.KEY_space];

function openWindow(app, file) {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: file.get_basename(),
        default_width: 1100,
        default_height: 780,
    });
    const view = new Host.WebKit.WebView();
    Host.configureWebView(view);
    window.set_child(view);

    // One session per window: closing this window stops only its own conversion.
    const session = new Host.Session(view, {
        // Keyboard focus goes to the 3D view, so R and the plate keys work straight away.
        onReady: () => view.grab_focus(),
        onFailed: (error) => logError(error, `oma-peek: could not show ${file.get_path()}`),
    });
    window.connect('close-request', () => {
        session.shutdown();
        return false;
    });

    // Capture phase: the window sees close keys before the WebView does.
    const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
    keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
        if (CLOSE_KEYS.includes(keyval) && !(state & Gtk.accelerator_get_default_mod_mask())) {
            window.close();
            return true;
        }
        return false;
    });
    window.add_controller(keys);
    window.present();

    let contentType = '';
    try {
        contentType = file.query_info('standard::content-type', Gio.FileQueryInfoFlags.NONE, null)
            .get_content_type();
    } catch (e) {
        // unknown type: the host falls back to the file extension
    }
    session.start(file, contentType);
}

if (!Host.isAvailable()) {
    printerr('oma-peek: WebKitGTK 6.0 (webkitgtk-6.0) or the installed viewer page is missing; run install.sh');
    exit(1);
}

// The Wayland app id (Hyprland's window class) follows the application id; set the program
// name too, which gjs otherwise sets to "gjs".
GLib.set_prgname(APP_ID);
const app = new Gtk.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.HANDLES_OPEN,
});
app.connect('open', (a, files) => {
    for (const file of files)
        openWindow(a, file);
});
app.connect('activate', () => {
    printerr('usage: oma-peek-open FILE...');
});
exit(await app.runAsync([programInvocationName, ...programArgs]));
