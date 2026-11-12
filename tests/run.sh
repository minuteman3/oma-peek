#!/bin/bash
# Run oma-peek's tests against a throwaway install (never the user's own).
#
#   tests/run.sh                 node, system and display tiers
#   tests/run.sh --acceptance    also the acceptance tier (real previewer and windows on the
#                                current Hyprland session); for sign-off every test must PASS,
#                                so a SKIP there counts as a failure
#
# Tiers: node (loaders, view state), system (installer, thumbnailer factory), display (Sushi
# discovery, rendering, lifecycle, conversion: need a Wayland display), acceptance.
# A test exits 77 to skip, with a "# skip:" reason.
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
acceptance=0
[ "${1:-}" = --acceptance ] && acceptance=1

R="$(mktemp -d "${TMPDIR:-/tmp}/oma-peek-tests-XXXXXX")"
trap 'chmod -R u+w "$R" 2>/dev/null; rm -rf "$R"' EXIT
pass=0 skip=0 fail=0
declare -a summary

run_test() { # run_test TIER NAME COMMAND...
    local tier="$1" name="$2"; shift 2
    local log="$R/log-${name//[^a-zA-Z0-9]/_}"
    "$@" >"$log" 2>&1
    local rc=$?
    local reason
    reason="$(grep -m1 '^# skip:' "$log" | sed 's/^# skip: //')"
    if [ $rc -eq 0 ] && [ -n "$reason" ]; then
        # Passed, but some checks inside were skipped: not good enough for sign-off.
        if ((acceptance)); then
            fail=$((fail + 1)); summary+=("FAIL  [$tier] $name: checks skipped in a sign-off run: $reason")
        else
            pass=$((pass + 1)); summary+=("PASS  [$tier] $name ($(grep -c '^ok' "$log") checks; skipped: $reason)")
        fi
    elif [ $rc -eq 0 ]; then
        pass=$((pass + 1)); summary+=("PASS  [$tier] $name ($(grep -c '^ok' "$log") checks)")
    elif [ $rc -eq 77 ]; then
        if ((acceptance)); then
            fail=$((fail + 1)); summary+=("FAIL  [$tier] $name: skipped in a sign-off run: $reason")
        else
            skip=$((skip + 1)); summary+=("SKIP  [$tier] $name: $reason")
        fi
    else
        fail=$((fail + 1)); summary+=("FAIL  [$tier] $name")
        grep -E '^not ok|ERROR|Error' "$log" | head -15 | sed 's/^/        /' >>"$R/failures"
        echo "--- $name" >>"$R/failures"
    fi
}

# --- shared setup: fixtures and isolated installs ----------------------------------------------
fixtures="$R/fixtures"
python3 -I "$repo/tests/fixtures/models.py" "$fixtures" >/dev/null

ns() { unshare --user --map-root-user --pid --fork --mount-proc "$@"; }
install_into() { # install_into DIR [--no-occt]: real install.sh, isolated from the user's session
    local dir="$1" hide=""
    [ "${2:-}" = --no-occt ] && hide="mkdir -p '$dir/empty' && mount --bind '$dir/empty' /usr/include/opencascade &&"
    XDG_DATA_HOME="$dir/data" XDG_CACHE_HOME="$dir/cache" XDG_STATE_HOME="$dir/state" XDG_CONFIG_HOME="$dir/config" \
        unshare --user --map-root-user --mount --pid --fork --mount-proc \
        bash -c "$hide bash '$repo/install.sh'" >"$dir.log" 2>&1
}
namespaces=1
ns true 2>/dev/null || namespaces=0
if ((namespaces)); then
    install_into "$R/install" || { echo "install failed:"; cat "$R/install.log"; exit 1; }
    [ -d /usr/include/opencascade ] && install_into "$R/noocct" --no-occt
fi
with_install() { # with_install NAME COMMAND...: a private copy of the install per test
    local name="$1"; shift
    rm -rf "$R/copy-$name"
    mkdir -p "$R/copy-$name"
    cp -a "$R/install/data" "$R/copy-$name/data"
    XDG_DATA_HOME="$R/copy-$name/data" XDG_CACHE_HOME="$R/copy-$name/cache" FIXTURES="$fixtures" \
        CAD_FIXTURES="${cad:-}" "$@"
}
skip_test() { echo "# skip: $1"; return 77; }

# CAD corpus (STEP/IGES/GLB) for the CAD cases, when OpenCASCADE is available.
cad=""
if [ -f /usr/include/opencascade/STEPCAFControl_Reader.hxx ]; then
    g++ -O1 -std=c++17 -I/usr/include/opencascade -o "$R/mkcad" "$repo/bench/e2e/make_cad_corpus.cpp" \
        $(cat "$repo/cad_ldlibs") -lTKPrim -lTKBO -lTKShHealing >/dev/null 2>&1 &&
        mkdir -p "$R/cad" && "$R/mkcad" "$R/cad" >/dev/null 2>&1 && cad="$R/cad"
fi

# Display for GTK tests: inherit, or find the session's Wayland socket.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -z "${WAYLAND_DISPLAY:-}" ]; then
    WAYLAND_DISPLAY="$(cd "$XDG_RUNTIME_DIR" 2>/dev/null && ls wayland-* 2>/dev/null | grep -v lock | head -1)"
    [ -n "$WAYLAND_DISPLAY" ] && export WAYLAND_DISPLAY
fi
display=0
[ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && display=1
# Sleeping monitors (DPMS off) deliver no frames, so nothing is drawn for snapshot checks.
if ((display)) && command -v hyprctl >/dev/null; then
    [ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ] ||
        export HYPRLAND_INSTANCE_SIGNATURE="$(ls -t "$XDG_RUNTIME_DIR/hypr" 2>/dev/null | head -1)"
    hyprctl monitors -j 2>/dev/null | python3 -c 'import json,sys; sys.exit(0 if any(m["dpmsStatus"] for m in json.load(sys.stdin)) else 1)' ||
        export OMA_PEEK_TEST_NO_FRAMES="display asleep (DPMS off)"
fi

# --- node tier --------------------------------------------------------------------------------
if command -v node >/dev/null; then
    run_test node "loaders (T5)" node --test "$repo/tests/loaders.test.mjs"
    run_test node "view state (T8)" node --test "$repo/tests/state.test.mjs"
else
    run_test node "loaders (T5)" skip_test "node not installed"
    run_test node "view state (T8)" skip_test "node not installed"
fi

# --- system tier ------------------------------------------------------------------------------
run_test system "installer (T7, T7r)" bash "$repo/tests/install.test.sh"
run_test system "plugin lifecycle (T11)" bash "$repo/tests/lifecycle.test.sh"
if ((namespaces)); then
    run_test system "thumbnailer (T6)" with_install thumb gjs -m "$repo/tests/thumbnailer.test.js"
    if [ -d "$R/noocct" ]; then
        run_test system "thumbnailer without OpenCASCADE (T6)" env XDG_DATA_HOME="$R/noocct/data" \
            FIXTURES="$fixtures" CAD_FIXTURES="$cad" gjs -m "$repo/tests/thumbnailer.test.js" --no-occt
    fi
else
    run_test system "thumbnailer (T6)" skip_test "unprivileged namespaces unavailable"
fi

run_test system "thumbnailer numpy fallback (T6b)" env FIXTURES="$fixtures" bash "$repo/tests/thumbnailer-fallback.test.sh"

# --- display tier -----------------------------------------------------------------------------
display_test() { # display_test NAME COMMAND...
    if ! ((display)); then run_test display "$1" skip_test "no Wayland display"; return; fi
    if ! ((namespaces)); then run_test display "$1" skip_test "no isolated install"; return; fi
    local name="$1"; shift
    run_test display "$name" with_install "${name//[^a-z]/}" "$@"
}
display_test "Sushi discovery (T1)" gjs -m "$repo/tests/sushi-discovery.test.js"
if ((display && namespaces)); then
    # T2a: WebKit 6 hidden from this process only.
    run_test display "Sushi without WebKit 6 (T2a)" with_install nowebkit \
        unshare --user --map-root-user --mount bash -c \
        'mount --bind /dev/null /usr/lib/girepository-1.0/WebKit-6.0.typelib && gjs -m "$1" --expect-unavailable' \
        _ "$repo/tests/sushi-discovery.test.js"
fi
display_test "preview rendering and lifecycle (T2b, T3)" gjs -m "$repo/tests/preview.test.js"
display_test "conversion cache (T4)" gjs -m "$repo/tests/conversion.test.js"

# --- acceptance tier --------------------------------------------------------------------------
if ((acceptance)); then
    if ((namespaces)); then
        run_test acceptance "real previewer and viewer windows (T9)" with_install accept bash "$repo/tests/acceptance.sh"
    else
        run_test acceptance "real previewer and viewer windows (T9)" skip_test "no isolated install"
    fi
fi

printf '%s\n' "${summary[@]}"
[ -f "$R/failures" ] && { echo; echo "failures:"; cat "$R/failures"; }
echo
echo "PASS $pass  SKIP $skip  FAIL $fail"
((fail == 0))
