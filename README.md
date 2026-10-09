# oma-peek

Quick Look–style 3D previews for Nautilus on Omarchy (STL, 3MF, OBJ, SCAD).

## Spacebar preview (Sushi plugin)

- `~/.local/share/sushi/viewers/mesh.js`: Sushi viewer module. Sushi adds
  `~/.local/share/sushi` to its import path, so no system files are touched.
- `web/`: three.js viewer page loaded into Sushi's WebKit view.
  - `loaders.js`: STL/OBJ/3MF parsing. 3MF reads build transforms, components, object names,
    filament colours (PrusaSlicer 3 project JSON, Slic3r_PE configs, Bambu/Orca project
    settings), Bambu plates (`model_settings.config`) and PrusaSlicer multi-bed.
  - `viewer.js`: orbit/zoom/pan, plate picker, object list (hover highlights, click isolates),
    dimensions. Keys: `R` reset view, `1`–`9` plate, `0` all plates.
  - Colours come from the current Omarchy theme (`~/.local/state/omarchy/current/theme/colors.toml`).
- SCAD is rendered with `openscad` to `~/.cache/oma-peek/<sha1>.stl` (keyed on path + mtime).
- Debug: `OMA_PEEK_DEBUG=1 /usr/lib/org.gnome.NautilusPreviewer` then `sushi FILE`.
- After changing `mesh.js`, kill the running `org.gnome.NautilusPreviewer` process.
  Edits to `web/` take effect on the next preview.

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
