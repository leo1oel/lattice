#!/usr/bin/env bash
# Usage: smoke-macos-dmg.sh <Lattice.dmg> <evidence dir> <signed: true|false>
#
# Installs Lattice from its disk image the way a user does (mount, copy to a
# folder, launch with `open`) on a fresh runner, then checks that it reached
# its interface: the process stays up, it has a window on screen, and the
# frontend's own events reach lattice.log (only a running React app writes
# those, through the Tauri IPC). The bundled Node is run directly, since
# Synara starts only when a Synara surface opens. A screenshot and the log
# land in the evidence directory.
set -euo pipefail

dmg="$1"
evidence="$2"
signed="$3"
mkdir -p "$evidence"
bundle_id="app.leo1oel.researchwriter"
log="$HOME/Library/Logs/$bundle_id/lattice.log"

mount_path="$(mktemp -d "${RUNNER_TEMP:-/tmp}/lattice-smoke-dmg.XXXXXX")"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_path" >/dev/null
install_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/lattice-smoke-app.XXXXXX")"
cp -R "$mount_path/Lattice.app" "$install_dir/"
hdiutil detach "$mount_path" >/dev/null
app="$install_dir/Lattice.app"

echo "Host: $(uname -m), macOS $(sw_vers -productVersion)"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
printf 'Lattice binary: %s\n' "$(lipo -archs "$app/Contents/MacOS/$executable")"
node="$app/Contents/Resources/synara-runtime/bin/node"
printf 'Sidecar Node: %s, reports %s\n' "$(lipo -archs "$node")" "$("$node" -p 'process.version + " " + process.arch')"
test "$("$node" -p process.arch)" = "x64"

if [[ "$signed" == "true" ]]; then
  codesign --verify --deep --strict --verbose=2 "$app"
  spctl --assess --type execute --verbose=4 "$app"
fi

rm -f "$log"
open "$app"

cleanup() {
  pkill -x "$executable" >/dev/null 2>&1 || true
  cp "$log" "$evidence/lattice.log" 2>/dev/null || true
}
trap cleanup EXIT

# The windows Lattice's process owns on screen, one "width height" per line.
# Owner names and bounds need no screen-recording permission.
cat > "$evidence/windows.swift" <<'SWIFT'
import CoreGraphics
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for window in windows where (window[kCGWindowOwnerName as String] as? String) == "Lattice" {
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("\(bounds["Width"] ?? 0) \(bounds["Height"] ?? 0)")
}
SWIFT
swiftc -O -o "$evidence/windows" "$evidence/windows.swift" >/dev/null

frontend=false
window=""
for _ in $(seq 90); do
  sleep 2
  if ! pgrep -x "$executable" >/dev/null; then
    echo "::error::Lattice exited before it showed its interface."
    exit 1
  fi
  if [[ "$frontend" == "false" ]] && grep -q '"service":"lattice.frontend"' "$log" 2>/dev/null; then
    frontend=true
    echo "The frontend is logging to lattice.log."
  fi
  window="$("$evidence/windows" | awk '$1 >= 640 && $2 >= 400 { print; exit }')"
  if [[ "$frontend" == "true" && -n "$window" ]]; then break; fi
done

screencapture -x "$evidence/screen.png" || echo "::warning::screencapture failed"
if [[ "$frontend" != "true" ]]; then
  echo "::error::No frontend event reached $log within three minutes."
  exit 1
fi
if [[ -z "$window" ]]; then
  echo "::error::Lattice has no window on screen."
  exit 1
fi
echo "Lattice window on screen: ${window/ /x}."

# It must stay up once its interface is there.
sleep 10
pgrep -x "$executable" >/dev/null || { echo "::error::Lattice exited after launch."; exit 1; }
echo "First frontend events:"
grep '"service":"lattice.frontend"' "$log" | head -5 | cut -c1-300
grep -E '"event":"(project.open|app.start)' "$log" | head -3 | cut -c1-300 || true
echo "Lattice runs on this $(uname -m) Mac."
