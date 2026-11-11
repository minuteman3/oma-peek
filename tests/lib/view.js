// Helpers for tests that drive real WebKit views: waiting on the main loop, reading the page,
// and a fake CAD converter installed into the install under test.
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function sleep(ms) {
    return new Promise((resolve) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

export async function waitFor(predicate, timeoutMs = 10000, stepMs = 50) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate())
            return true;
        await sleep(stepMs);
    }
    return false;
}

export function pageParams(view) {
    const uri = view.get_uri();
    if (!uri)
        return null;
    const q = uri.indexOf('?');
    if (q < 0)
        return {};
    const params = GLib.Uri.parse_params(uri.slice(q + 1), -1, '&', GLib.UriParamsFlags.NONE);
    return Object.fromEntries(Object.entries(params));
}

// Evaluate an expression in the page; resolves to its JSON-decoded value.
export function evaluate(view, expr) {
    return new Promise((resolve, reject) => {
        view.evaluate_javascript(`JSON.stringify(${expr})`, -1, null, null, null, (v, res) => {
            try {
                resolve(JSON.parse(v.evaluate_javascript_finish(res).to_string()));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function pageState(view) {
    return evaluate(view, `({msgHidden: document.getElementById('msg').hidden,
        msgClass: document.getElementById('msg').className,
        msg: document.getElementById('msg').textContent,
        info: document.getElementById('info').textContent})`);
}

// Fraction of pixels in the central box that differ clearly from the top-left corner pixel.
export function snapshotCoverage(view, WebKit) {
    return new Promise((resolve, reject) => {
        view.get_snapshot(WebKit.SnapshotRegion.VISIBLE, WebKit.SnapshotOptions.NONE, null, (v, res) => {
            try {
                const texture = v.get_snapshot_finish(res);
                const dl = Gdk.TextureDownloader.new(texture);
                dl.set_format(Gdk.MemoryFormat.R8G8B8A8);
                const [bytes, stride] = dl.download_bytes();
                const px = bytes.toArray();
                const w = texture.get_width(), h = texture.get_height();
                const at = (x, y) => px.subarray(y * stride + x * 4, y * stride + x * 4 + 3);
                const bg = at(2, 2);
                let differ = 0, total = 0;
                for (let y = Math.floor(h * 0.4); y < h * 0.6; y += 2)
                    for (let x = Math.floor(w * 0.4); x < w * 0.6; x += 2, total++) {
                        const p = at(x, y);
                        if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 30)
                            differ++;
                    }
                resolve(total ? differ / total : 0);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Replace the installed CAD converter with a script controlled through environment variables
// (Gio.Subprocess passes the test process environment through):
//   FAKE_LOG   append "pid src out" per run      FAKE_GATE  FIFO to block on before writing
//   FAKE_MPK   valid output to copy              FAKE_MODE  ok | fail | short | lockdir
export function installFakeConverter() {
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek', 'oma-peek-cad']);
    GLib.file_set_contents(path, `#!/bin/bash
echo "$$ $1 $2" >> "$FAKE_LOG"
[ -n "\${FAKE_GATE:-}" ] && cat "$FAKE_GATE" >/dev/null
case "\${FAKE_MODE:-ok}" in
  fail) echo "ERROR: fake converter failure" >&2; exit 1 ;;
  short) printf abc >"$2" ;;
  lockdir) cat "$FAKE_MPK" >"$2"; chmod a-w "$(dirname "$2")" ;;
  *) cat "$FAKE_MPK" >"$2" ;;
esac
`);
    GLib.chmod(path, 0o755);
    return path;
}

export function fakeLog() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(GLib.getenv('FAKE_LOG'))[1])
            .split('\n').filter(Boolean).map((l) => {
                const [pid, src, out] = l.split(' ');
                return {pid: +pid, src, out};
            });
    } catch (e) {
        return [];
    }
}

export function makeFifo(path) {
    GLib.spawn_command_line_sync(`mkfifo ${GLib.shell_quote(path)}`);
    return path;
}

// Opening the FIFO for writing releases every converter blocked on it.
export function release(fifo) {
    GLib.spawn_command_line_async(`sh -c ${GLib.shell_quote(`: > ${GLib.shell_quote(fifo)}`)}`);
}

export function pidAlive(pid) {
    return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS) &&
        !/^State:\s+Z/m.test(new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/status`)[1]));
}

export function listDir(path) {
    try {
        const e = Gio.File.new_for_path(path).enumerate_children('standard::name', 0, null);
        return [...e].map((i) => i.get_name()).sort();
    } catch (e) {
        return [];
    }
}
