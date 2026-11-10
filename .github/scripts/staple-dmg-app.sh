#!/usr/bin/env bash
# Usage: staple-dmg-app.sh <dmg> <signing identity>
#
# Makes sure the app inside a notarized build's disk image carries its
# notarization ticket, so it opens offline once copied out of the image.
# `tauri build` staples the ticket to the app before copying the app into the
# DMG, but it runs `xcrun stapler staple` once and ignores its exit status
# (staple_app in tauri-macos-sign). When the CloudKit lookup drops right
# after the accepted submission, the drop retry-stapler.sh retries, the DMG
# ships an app without its ticket: v0.16.6's first Intel build failed its
# verification that way after five tries of `stapler validate`.
#
# The ticket is the file Contents/CodeResources, which stapling adds without
# touching the code signature. When it is missing, the app is stapled in
# place on a writable shadow of the image, the image is rewritten in its own
# format (the free space bundle_dmg.sh leaves holds the ticket), and the
# rewritten image is signed again as tauri signed it. The DMG's own
# notarization comes after this, so it covers the image as shipped.
set -euo pipefail

dmg="$1"
identity="$2"
scripts="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lattice-staple.XXXXXX")"
mount="$work/mount"
shadow="$work/image.shadow"
mkdir "$mount"

attached=false
cleanup() {
  if [[ "$attached" == true ]]; then
    hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

hdiutil attach "$dmg" -shadow "$shadow" -nobrowse -noverify -noautoopen -mountpoint "$mount" >/dev/null
attached=true

app="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
test -n "$app"
if [[ -f "$app/Contents/CodeResources" ]]; then
  echo "$(basename "$app") in $(basename "$dmg") has its notarization ticket."
  exit 0
fi

echo "::warning::$(basename "$app") in $(basename "$dmg") has no notarization ticket: tauri's one stapler run failed. Stapling it in the image."
"$scripts/retry-stapler.sh" staple "$app"
hdiutil detach "$mount" -quiet
attached=false

format="$(hdiutil imageinfo -plist "$dmg" | plutil -extract Format raw -o - -)"
hdiutil convert "$dmg" -shadow "$shadow" -format "$format" -o "$work/stapled.dmg" -quiet
mv -f "$work/stapled.dmg" "$dmg"
codesign --force --sign "$identity" --timestamp "$dmg"
