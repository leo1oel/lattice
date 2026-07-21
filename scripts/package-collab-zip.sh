#!/usr/bin/env bash
# Build (optional), install to /Applications, and ship a VM-friendly Lattice package.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="${ROOT}/src-tauri/target/release/bundle/macos/Lattice.app"
APP_DST="/Applications/Lattice.app"
OUT_DIR="${HOME}/Desktop/Lattice-collab"
# ditto zip = what macOS Archive Utility on guests opens most reliably
ZIP_PATH="${HOME}/Desktop/Lattice.zip"
SKIP_BUILD=0

if [[ "${1:-}" == "--skip-build" ]]; then
  SKIP_BUILD=1
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  cd "$ROOT"
  pnpm tauri build --bundles app
fi

if [[ ! -d "$APP_SRC" ]]; then
  echo "Missing built app at: $APP_SRC" >&2
  echo "Run without --skip-build, or build first." >&2
  exit 1
fi

rm -rf "$APP_DST" "$OUT_DIR" "$ZIP_PATH"
rm -f "${HOME}/Desktop/Lattice-collab.zip" "${HOME}/Desktop/Lattice-collab.tar.gz" \
  "${HOME}/Desktop/Lattice-collab.tgz" "${HOME}/Desktop/Lattice-collab.tar" || true

ditto "$APP_SRC" "$APP_DST"
xattr -cr "$APP_DST" || true

mkdir -p "$OUT_DIR"
ditto "$APP_DST" "$OUT_DIR/Lattice.app"
xattr -cr "$OUT_DIR/Lattice.app" || true

# ASCII-only names — Chinese paths break guest unzip / Archive Utility.
LAUNCHER_SCRIPT="$(mktemp -t lattice-open).applescript"
cat > "$LAUNCHER_SCRIPT" <<'EOF'
on run
  set launcherPath to POSIX path of (path to me as text)
  set folderPath to do shell script "/usr/bin/dirname " & quoted form of launcherPath
  do shell script "/usr/bin/xattr -cr " & quoted form of folderPath & " ; /bin/chmod -R u+x " & quoted form of (folderPath & "/Lattice.app")
  do shell script "/usr/bin/open " & quoted form of (folderPath & "/Lattice.app")
end run
EOF
osacompile -o "$OUT_DIR/Open-Lattice.app" "$LAUNCHER_SCRIPT" >/dev/null
rm -f "$LAUNCHER_SCRIPT"
xattr -cr "$OUT_DIR/Open-Lattice.app" || true

EXPECTED_BYTES="$(find "$OUT_DIR" -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')"

cat > "$OUT_DIR/README.txt" <<EOF
Lattice collab test package
===========================

TRANSFER INTO A VM
------------------
1. Copy Desktop/Lattice.zip into the guest (shared folder / AirDrop / USB).
2. On the GUEST, check size is about the same as on the host (~64 MB).
   If the guest file is much smaller, the copy was truncated — copy again.
3. Extract ON THE GUEST local disk (Desktop or Downloads), NOT inside a
   shared/sync folder:

   Terminal on the guest (most reliable):
     mkdir -p ~/Desktop/Lattice-collab
     xattr -cr ~/Downloads/Lattice.zip
     ditto -x -k ~/Downloads/Lattice.zip ~/Desktop/Lattice-collab
     open ~/Desktop/Lattice-collab

   Or double-click Lattice.zip in Finder.

Do NOT sync an already-extracted Lattice.app through a shared folder —
guests often show it as an empty folder.

FIRST OPEN
----------
Control-click Open-Lattice.app → Open → Open

Package file count payload (approx bytes of files): ${EXPECTED_BYTES}
EOF

# Native macOS zip — avoids .tar.gz Archive Utility failures on some guests.
ditto -c -k --norsrc --noextattr --noqtn "$OUT_DIR" "$ZIP_PATH"
xattr -cr "$ZIP_PATH" "$OUT_DIR" || true

ZIP_BYTES="$(stat -f%z "$ZIP_PATH")"

echo "Installed: $APP_DST"
echo "Folder:    $OUT_DIR"
echo "Zip:       $ZIP_PATH  (${ZIP_BYTES} bytes)  ← use this for VMs"
echo ""
echo "On the VM after copy, size should match ${ZIP_BYTES} bytes, then:"
echo "  mkdir -p ~/Desktop/Lattice-collab && xattr -cr ~/Downloads/Lattice.zip"
echo "  ditto -x -k ~/Downloads/Lattice.zip ~/Desktop/Lattice-collab && open ~/Desktop/Lattice-collab"
