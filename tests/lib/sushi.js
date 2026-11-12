// Boot Sushi's own modules the way /usr/lib/org.gnome.NautilusPreviewer does, so tests use
// Sushi's real plugin discovery and renderer selection. XDG_DATA_HOME must already point at
// the install under test (GLib reads it once per process).
import GLib from 'gi://GLib';

export const LAUNCHER = '/usr/lib/org.gnome.NautilusPreviewer';

export function sushiVersion() {
    try {
        const text = new TextDecoder().decode(GLib.file_get_contents(LAUNCHER)[1]);
        return /version:\s*'([^']+)'/.exec(text)?.[1] ?? null;
    } catch (e) {
        return null;
    }
}

export async function bootSushi() {
    const version = sushiVersion();
    if (!version || parseInt(version, 10) < 51)
        return null;
    imports.package.init({name: 'sushi', version, prefix: '/usr', libdir: '/usr/lib'});
    // Register Sushi's resource bundles explicitly (harmless if package.init already did).
    const Gio = (await import('gi://Gio')).default;
    for (const kind of ['src', 'data']) {
        const path = `/usr/share/sushi/org.gnome.NautilusPreviewer.${kind}.gresource`;
        try {
            Gio.resources_lookup_data(kind === 'src' ? '/org/gnome/NautilusPreviewer/js/core/main.js'
                : '/org/gnome/NautilusPreviewer/ui/fallback.ui', 0);
        } catch (e) {
            Gio.Resource.load(path)._register();
        }
    }
    // Same versioned gi imports as Sushi's core/main.js, so built-in renderers load as in production.
    for (const ns of ['Adw?version=1', 'Gdk?version=4.0', 'Gtk?version=4.0', 'Gly?version=2',
        'GlyGtk4?version=2', 'Gst?version=1.0', 'GstTag?version=1.0', 'GtkSource?version=5',
        'PapersDocument?version=4.0', 'PapersView?version=4.0', 'Soup?version=3.0', 'Sushi?version=1.0'])
        await import(`gi://${ns}`);
    const Gtk = (await import('gi://Gtk?version=4.0')).default;
    Gtk.init();
    return import('resource:///org/gnome/NautilusPreviewer/js/core/rendererSelector.js');
}

let failures = 0;
export function check(ok, name, detail = '') {
    print(`${ok ? 'ok' : 'not ok'} - ${name}${!ok && detail ? ` (${detail})` : ''}`);
    if (!ok)
        failures++;
}
export function finish(system) {
    system.exit(failures ? 1 : 0);
}
