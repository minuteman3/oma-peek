// oma-peek-open: show 3D models in the oma-peek viewer, one window per file.
// Used by the Strata custom action, or directly: gjs oma-peek-open.js FILE...
// A single-instance GtkApplication, so later calls open their windows in the running process.
// Escape, Q or Space closes a window; R, 1-9 and 0 work as in the Sushi preview.

imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
const {Gdk, Gio, GLib, Gtk} = imports.gi;
const System = imports.system;

imports.searchPath.unshift(GLib.path_get_dirname(System.programPath));
const Host = imports.omaPeekHost;

const APP_ID = 'io.github.minuteman3.OmaPeek';
const CLOSE_KEYS = [Gdk.KEY_Escape, Gdk.KEY_q, Gdk.KEY_Q, Gdk.KEY_space];

function openWindow(app, file) {
    let window = new Gtk.ApplicationWindow({
        application: app,
        title: file.get_basename(),
        default_width: 1100,
        default_height: 780,
    });
    let view = new Host.WebKit2.WebView();
    Host.configureWebView(view);
    view.connect('load-failed', (v, loadEvent, uri, error) => {
        logError(error, `oma-peek: could not load ${uri}`);
        return false;
    });
    // Keyboard focus goes to the 3D view, so R and the plate keys work straight away.
    view.connect('load-changed', (v, event) => {
        if (event === Host.WebKit2.LoadEvent.FINISHED)
            view.grab_focus();
    });
    window.connect('key-press-event', (w, event) => {
        let [, keyval] = event.get_keyval();
        let [, state] = event.get_state();
        if (CLOSE_KEYS.includes(keyval) && !(state & Gtk.accelerator_get_default_mod_mask())) {
            window.close();
            return true;
        }
        return false;
    });
    window.add(view);
    window.show_all();

    let contentType = '';
    try {
        contentType = file.query_info('standard::content-type', Gio.FileQueryInfoFlags.NONE, null)
            .get_content_type();
    } catch (e) {
    }
    Host.loadModel(view, file, contentType);
}

if (!Host.isAvailable()) {
    printerr('oma-peek: WebKit2GTK 4.1 or the installed viewer page is missing; run install.sh');
    System.exit(1);
}

// The Wayland app id (Hyprland's window class) comes from the program name, which gjs
// otherwise sets to "gjs".
GLib.set_prgname(APP_ID);
const app = new Gtk.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.HANDLES_OPEN,
});
app.connect('open', (a, files) => {
    for (let file of files)
        openWindow(a, file);
});
app.connect('activate', () => {
    printerr('usage: oma-peek-open FILE...');
});
System.exit(app.run([System.programInvocationName, ...ARGV]));
