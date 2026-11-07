#!/usr/bin/env bash
# Usage: check-macos-arch.sh <Lattice.app> <arch>
#
# Every Mach-O file in the bundle must run natively on <arch> (x86_64 for the
# Intel app): the app binary, the Synara sidecar's Node, the native addons
# both runtimes load, and helper tools. A thin file for the other CPU would
# fail only when its feature is first used, so no launch test finds it.
# Universal files pass when they contain <arch>.
set -euo pipefail

app="$1"
arch="$2"
test -d "$app"

executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
node="$app/Contents/Resources/synara-runtime/bin/node"
for file in "$app/Contents/MacOS/$executable" "$node"; do
  printf '%s: %s\n' "${file#"$app/"}" "$(lipo -archs "$file")"
  file "$file"
  lipo "$file" -verify_arch "$arch"
done

report="$(mktemp)"
find "$app" -type f -print0 | xargs -0 file --no-pad --separator '|' | grep '| Mach-O' > "$report" || true
count="$(wc -l < "$report" | tr -d ' ')"
if [[ "$count" == "0" ]]; then
  echo "::error::Found no Mach-O files in $app"
  exit 1
fi
if grep -v "$arch" "$report"; then
  echo "::error::The Mach-O files above have no $arch code."
  exit 1
fi
echo "All $count Mach-O files in ${app##*/} contain $arch."
