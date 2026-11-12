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
//   FAKE_LOG    append "pid src out tag" per run        FAKE_TAG  label for this run
//   FAKE_MPK    valid output to copy                    FAKE_MODE see below; a file
//                                                       <source>.mode overrides it for every
//                                                       attempt (retries spawn after open())
//   FAKE_GATES  directory: write a partial output, log, then block on the FIFO
//               FAKE_GATES/<pid> (bash's own redirection, so killing the converter unblocks it)
// Modes: ok, fail (exit 1 with an error), short (3 bytes), badmpk (header not JSON),
// truncmpk (header promises triangles that are missing), nanmpk (complete but every
// coordinate NaN), lockdir (cache dir made read-only after writing), touchsrc (edit the
// source during the first run only), alwaystouch, rmsrc (delete the source while converting),
// bigmpk (128 MB valid mesh), bignanmpk (128 MB, only the very last coordinate NaN).
export function installFakeConverter() {
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'oma-peek', 'oma-peek-cad']);
    GLib.file_set_contents(path, `#!/bin/bash
src="$1" out="$2"
if [ -n "\${FAKE_GATES:-}" ]; then
    printf partial >"$out"
    mkfifo "$FAKE_GATES/$$"
    echo "$$ $src $out \${FAKE_TAG:-}" >>"$FAKE_LOG"
    read -r _ <"$FAKE_GATES/$$"
else
    echo "$$ $src $out \${FAKE_TAG:-}" >>"$FAKE_LOG"
fi
mode="\${FAKE_MODE:-ok}"
[ -f "$src.mode" ] && mode="$(cat "$src.mode")"
case "$mode" in
  fail) echo "ERROR: fake converter failure" >&2; exit 1 ;;
  short) printf abc >"$out" ;;
  badmpk) printf 'MPK1\\x05\\x00\\x00\\x00{bad}' >"$out" ;;
  truncmpk) printf 'MPK1\\x14\\x00\\x00\\x00{"parts":[{"n":12}]}' >"$out" ;;
  nanmpk) { printf 'MPK1\\x14\\x00\\x00\\x00{"parts":[{"n":12}]}'
            for _ in $(seq 108); do printf '\\x00\\x00\\xc0\\x7f'; done; } >"$out" ;;
  rmsrc) cat "$FAKE_MPK" >"$out"; rm -f "$src" ;;
  bigmpk|bignanmpk)
    n=3728270; hdr='{"parts":[{"n":'$n'}]}'; len=\${#hdr}
    { printf "MPK1\\x$(printf %02x $((len & 255)))\\x$(printf %02x $((len >> 8 & 255)))\\x00\\x00%s" "$hdr"
      if [ "$mode" = bigmpk ]; then head -c $((n * 36)) /dev/zero
      else head -c $((n * 36 - 4)) /dev/zero; printf '\\x00\\x00\\xc0\\x7f'; fi; } >"$out" ;;
  lockdir) cat "$FAKE_MPK" >"$out"; chmod a-w "$(dirname "$out")" ;;
  touchsrc) cat "$FAKE_MPK" >"$out"; [ -e "$src.touched" ] || { touch "$src.touched"; echo edit >>"$src"; } ;;
  alwaystouch) cat "$FAKE_MPK" >"$out"; echo edit >>"$src" ;;
  *) cat "$FAKE_MPK" >"$out" ;;
esac
`);
    GLib.chmod(path, 0o755);
    return path;
}

export function fakeLog() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(GLib.getenv('FAKE_LOG'))[1])
            .split('\n').filter(Boolean).map((l) => {
                const [pid, src, out, tag] = l.split(' ');
                return {pid: +pid, src, out, tag};
            });
    } catch (e) {
        return [];
    }
}

// Let one gated converter run (FAKE_GATES mode). Opening the FIFO waits for its reader.
export function releaseConverter(gates, pid) {
    const fifo = `${gates}/${pid}`;
    GLib.spawn_command_line_async(`sh -c ${GLib.shell_quote(`echo go > ${GLib.shell_quote(fifo)}`)}`);
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
