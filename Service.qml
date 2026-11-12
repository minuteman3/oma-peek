// oma-peek Omarchy plugin: keeps the 3D previews in step with the plugin.
//
// The previews live outside the shell (a Nautilus thumbnailer and a Sushi plugin):
//   service created (shell start, plugin enabled)
//       install.sh --if-changed --managed: installs or updates this checkout (exits at once
//       when it is already installed) and records that the install belongs to this plugin.
//   service destroyed (plugin disabled or removed, but also shell restart and reload)
//       uninstall.sh --if-inactive, a few seconds later and detached (the shell may be going
//       away): it removes the previews only if Omarchy's saved state says the plugin is no
//       longer enabled or no longer there.
// The installed copy of uninstall.sh is used because a removed plugin's folder is deleted.
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
    command: ["bash", root.installer, "--if-changed", "--notify", "--managed"]
    running: true
    onExited: (code) => {
      if (code !== 0)
        console.warn("oma-peek: install.sh exited with " + code)
    }
  }

  Component.onDestruction: Quickshell.execDetached([
    "bash", "-c",
    'exec "${XDG_DATA_HOME:-$HOME/.local/share}/oma-peek/uninstall.sh" --if-inactive --after 3'
  ])
}
