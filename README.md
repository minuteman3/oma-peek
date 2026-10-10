# oma-peek

Quick Look–style 3D previews for Nautilus on Omarchy: thumbnails and spacebar previews for
STL, 3MF, OBJ, SCAD and, through OpenCASCADE, STEP, IGES and glTF/GLB.

## Install (Omarchy plugin)

```
omarchy plugin add <git-url-of-this-repo> --enable     # or file:///path/to/a/checkout
nautilus -q                                            # once, so Nautilus loads the thumbnailer
```

The plugin is a shell `service` (`Service.qml`): when the Omarchy shell starts it runs
`install.sh --if-changed --notify`, which builds the native code and installs it if this
checkout differs from what is installed, then sends a notification. `omarchy plugin update
oma-peek` pulls new code; the next shell start installs it.

Build needs `gcc`/`g++`, `python3`, `numpy` (fallback only), `sushi`, `webkit2gtk-4.1`, and
optionally `opencascade` (STEP/IGES/glTF), `libdeflate` and `openscad`.

Removing the plugin doesn't remove the installed previews; run
`~/.local/share/oma-peek/uninstall.sh` (or `install.sh --uninstall`) for that.

Installed files:
- `~/.local/share/oma-peek/`: viewer page (`web/`), `oma-peek-cad`, `uninstall.sh`, install stamp
- `~/.local/share/sushi/viewers/oma-peek.js`: Sushi viewer module
- `~/.local/share/thumbnailers/oma-peek.thumbnailer`: thumbnailer (code embedded in its Exec line)
- `~/.cache/oma-peek/`: converted SCAD/CAD meshes for the viewer

## Spacebar preview (Sushi plugin)

- `sushi/oma-peek.js` (installed to `~/.local/share/sushi/viewers/`): Sushi viewer module.
  Sushi adds `~/.local/share/sushi` to its import path, so no system files are touched.
- `web/`: three.js viewer page loaded into Sushi's WebKit view.
  - `loaders.js`: STL/OBJ/3MF parsing. 3MF reads build transforms, components, object names,
    filament colours (PrusaSlicer 3 project JSON, Slic3r_PE configs, Bambu/Orca project
    settings), Bambu plates (`model_settings.config`) and PrusaSlicer multi-bed.
  - `viewer.js`: orbit/zoom/pan, plate picker, object list (hover highlights, click isolates),
    dimensions. Keys: `R` reset view, `1`–`9` plate, `0` all plates.
  - Colours come from the current Omarchy theme (`~/.local/state/omarchy/current/theme/colors.toml`).
- SCAD is rendered with `openscad` to `~/.cache/oma-peek/<sha1>.stl` (keyed on path + mtime).
- Debug: `OMA_PEEK_DEBUG=1 /usr/lib/org.gnome.NautilusPreviewer` then `sushi FILE`.
- After editing `sushi/` or `web/`, run `./install.sh` (it restarts the previewer service).

## Thumbnails

- `thumbnailer.py`: parsing plus numpy projection and shading.
- `raster.c` → `libmeshraster.so`: z-buffer triangle fill and fast 3MF `<mesh>` parsing.
- `install.sh`: builds the library and writes `~/.local/share/thumbnailers/oma-peek.thumbnailer`.

The gnome-desktop thumbnail sandbox (bwrap) only exposes `/usr` plus the input and output
files, so `install.sh` embeds the script and the compressed `.so` in the Exec line and runs
them with `/usr/bin/python3`. The library is loaded from a memfd. If that fails, the script
falls back to a slower pure-numpy sampler.

After editing the thumbnailer: run `./install.sh`, then `nautilus -q`. Nautilus reads the
thumbnailer list only at startup. Delete `~/.cache/thumbnails/*/` entries to force a re-render.

## CAD formats (OpenCASCADE)

`cad.cpp` reads STEP/IGES (B-rep, meshed with a tolerance relative to model size) and
glTF/GLB/OBJ into an XCAF document, so part names, placements and colours come through
the same way for each. Output is Z-up millimetres.

- `libmeshcad.so`: C API (`mp_cad_load/nparts/part/free`), embedded in the thumbnailer as a
  second payload and loaded only for these extensions (OpenCASCADE costs ~30 ms to load).
- `oma-peek-cad IN OUT.mpk`: converter used by the Sushi viewer (finer meshing); `.mpk` is a
  JSON header plus float32 triangles, read by `web/loaders.js`. Cached in `~/.cache/oma-peek`.
- Thumbnails use the coarse mesh; OBJ falls back to the Python loader if OpenCASCADE is missing.
- In the thumbnail sandbox only the input file is visible: OBJ `.mtl` colours and glTF files
  with external `.bin`/textures can't be read there (GLB is self-contained and fine).
- IGES carries no assembly structure and patchy colours; uncoloured parts use the default grey.
- PLY is deliberately not supported yet (scans, point clouds and Gaussian splats need their own handling).
- Test corpus: `bench/e2e/make_cad_corpus.cpp` writes a named, coloured assembly as STEP/IGES/GLB/OBJ.
