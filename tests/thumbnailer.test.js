// T6: thumbnails through GNOME's real thumbnail factory (gnome-desktop 4), which reads the
// installed .thumbnailer, runs its Exec line in its own sandbox and returns the image.
// run: XDG_DATA_HOME=<install> FIXTURES=<dir> [CAD_FIXTURES=<dir>] gjs -m tests/thumbnailer.test.js [--no-occt]
// Exit 77 = skipped (no GnomeDesktop-4.0 typelib).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as system from 'system';

import {check, finish} from './lib/sushi.js';

let GnomeDesktop;
try {
    GnomeDesktop = (await import('gi://GnomeDesktop?version=4.0')).default;
} catch (e) {
    print('# skip: GnomeDesktop-4.0 typelib not installed');
    system.exit(77);
}

const noOcct = system.programArgs.includes('--no-occt');
const fixtures = GLib.getenv('FIXTURES');
const cad = GLib.getenv('CAD_FIXTURES');
const factory = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.LARGE);

function thumbnail(path, mime) {
    const file = Gio.File.new_for_path(path);
    const uri = file.get_uri();
    const mtime = file.query_info('time::modified', 0, null).get_attribute_uint64('time::modified');
    if (!factory.can_thumbnail(uri, mime, mtime))
        return {registered: false};
    try {
        return {registered: true, pixbuf: factory.generate_thumbnail(uri, mime, null)};
    } catch (e) {
        return {registered: true, error: e.message};
    }
}

// Sized for the request and not a flat image: some pixels differ clearly from the corner.
function looksRendered(pixbuf) {
    if (!pixbuf)
        return false;
    const w = pixbuf.get_width(), h = pixbuf.get_height();
    if (Math.max(w, h) > 256 || Math.max(w, h) < 128)
        return false;
    const px = pixbuf.get_pixels(), stride = pixbuf.get_rowstride(), n = pixbuf.get_n_channels();
    const at = (x, y) => px.subarray(y * stride + x * n, y * stride + x * n + 3);
    const bg = at(0, 0);
    let differ = 0;
    for (let y = 0; y < h; y += 4)
        for (let x = 0; x < w; x += 4) {
            const p = at(x, y);
            if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 30)
                differ++;
        }
    return differ > 20;
}

function expectImage(path, mime, label) {
    const r = thumbnail(path, mime);
    check(r.registered, `${label}: oma-peek handles ${mime}`);
    check(looksRendered(r.pixbuf), `${label}: rendered thumbnail`, r.error ?? '');
}

if (noOcct) {
    expectImage(`${fixtures}/two-groups.obj`, 'model/obj', 'OBJ without OpenCASCADE');
    if (cad)
        check(!thumbnail(`${cad}/assembly.step`, 'model/step').registered,
            'without OpenCASCADE STEP is not claimed');
} else {
    expectImage(`${fixtures}/box-binary.stl`, 'model/stl', 'binary STL');
    expectImage(`${fixtures}/box-ascii.stl`, 'model/stl', 'ASCII STL');
    expectImage(`${fixtures}/bambu-plates.3mf`, 'model/3mf', '3MF with plates');
    expectImage(`${fixtures}/two-groups.obj`, 'model/obj', 'OBJ');
    expectImage(`${fixtures}/thumb-only.3mf`, 'model/3mf', '3MF without geometry (embedded preview)');
    if (cad)
        expectImage(`${cad}/assembly.step`, 'model/step', 'STEP');
    else
        print('# skip: STEP case (no CAD_FIXTURES)');
    const garbage = thumbnail(`${fixtures}/garbage.stl`, 'model/stl');
    check(garbage.registered && !garbage.pixbuf, 'garbage STL: no thumbnail (Nautilus keeps the icon)');
}
finish(system);
