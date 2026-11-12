// oma-peek Omarchy plugin: keeps the 3D previews in step with the plugin.
//
// The previews live outside the shell (a Nautilus thumbnailer and a Sushi plugin):
//   service created (shell start, plugin enabled)   -> install.sh --service
//   service destroyed (plugin disabled or removed,  -> uninstall.sh --service-stopped (the
//     but also shell restart and reload)               installed copy: a removed plugin's
//                                                      folder is being deleted), detached
// What those mean lives in the scripts (see their headers): install or update and record the
// install as this plugin's; remove the previews only if Omarchy's saved state says the plugin
// is disabled or gone. Keep this file stable: after a plugin update the shell may keep running
// the previous copy of it until it restarts, while the scripts are always read fresh.
import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  // Injected by omarchy-shell.
  property var shell: null

  readonly property string installer:
    decodeURIComponent(Qt.resolvedUrl("install.sh").toString().replace(/^file:\/\//, ""))

  Process {
    id: install
    command: ["bash", root.installer, "--service"]
    running: true
    onExited: (code) => {
      if (code !== 0)
        console.warn("oma-peek: install.sh exited with " + code)
    }
  }

  Component.onDestruction: Quickshell.execDetached([
    "bash", "-c", 'exec "${XDG_DATA_HOME:-$HOME/.local/share}/oma-peek/uninstall.sh" --service-stopped'
  ])
}
