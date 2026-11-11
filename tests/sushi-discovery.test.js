// T1 / T2a: Sushi 51 discovers the installed plugin and routes model types to it.
// run: XDG_DATA_HOME=<install> gjs -m tests/sushi-discovery.test.js [--expect-unavailable]
// Exit 77 = skipped (no Sushi 51 on this system).
import GLib from 'gi://GLib';
import * as system from 'system';

import {bootSushi, check, finish} from './lib/sushi.js';

const expectUnavailable = system.programArgs.includes('--expect-unavailable');
const selector = await bootSushi();
if (!selector) {
    print('# skip: Sushi 51 or newer is not installed');
    system.exit(77);
}
const {selectRenderer} = selector;

// Positive control: a built-in type must reach Sushi's own renderer. If this fails the
// bootstrap is degraded and nothing below proves anything.
check(selectRenderer('image/png')?.name === 'ImageRenderer', 'control: image/png uses Sushi\'s image renderer',
    `got ${selectRenderer('image/png')?.name}`);

const data = GLib.get_user_data_dir();
const plugin = await import(GLib.filename_to_uri(GLib.build_filenamev([data, 'sushi', 'plugins-1', 'oma-peek.js']), null));
const converter = GLib.file_test(GLib.build_filenamev([data, 'oma-peek', 'oma-peek-cad']), GLib.FileTest.IS_EXECUTABLE);

if (expectUnavailable) {
    check(plugin.Klass === undefined && plugin.contentTypes.length === 0, 'without WebKit 6 the plugin offers no types');
    check(selectRenderer('model/stl') !== undefined && selectRenderer('model/stl') !== plugin.Klass,
        'without WebKit 6 model/stl falls back to Sushi');
} else {
    check(plugin.Klass !== undefined, 'plugin exports a renderer');
    for (const type of ['model/stl', 'model/3mf', 'model/obj', 'application/x-openscad'])
        check(selectRenderer(type) === plugin.Klass, `${type} -> oma-peek`, `got ${selectRenderer(type)?.name}`);
    for (const type of ['model/step', 'model/iges', 'model/gltf-binary'])
        check((selectRenderer(type) === plugin.Klass) === converter,
            `${type} -> oma-peek only when the CAD converter is installed (installed: ${converter})`);
    for (const type of ['text/plain', 'image/png'])
        check(selectRenderer(type) !== plugin.Klass, `${type} is not taken by oma-peek`);
}
finish(system);
