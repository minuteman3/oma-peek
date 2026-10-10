// oma-peek Omarchy plugin: keeps the 3D preview install in sync with this checkout.
//
// The previews themselves live outside the shell (a Nautilus thumbnailer and a
// Sushi viewer module), so the plugin's only job is to run install.sh when the
// shell starts. install.sh --if-changed exits immediately when this source is
// already installed, and --notify reports installs and failures.
import QtQuick
import Quickshell.Io

Item {
  id: root

  // Injected by omarchy-shell.
  property var shell: null

  readonly property string installer:
    decodeURIComponent(Qt.resolvedUrl("install.sh").toString().replace(/^file:\/\//, ""))

  Process {
    id: install
    command: ["bash", root.installer, "--if-changed", "--notify"]
    running: true
    onExited: (code) => {
      if (code !== 0)
        console.warn("oma-peek: install.sh exited with " + code)
    }
  }
}
