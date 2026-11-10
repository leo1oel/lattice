#!/usr/bin/env bash
# Portability smoke for the Linux AppImage on one distribution: extract it
# (no FUSE needed), check that no ELF file it ships is missing a shared
# library, then launch it under Xvfb and require it to stay up.
#
# Adapted from Stefan Bringuier's .github/scripts/smoke-appimage.sh in
# https://github.com/leo1oel/lattice/pull/667. Changes: every bundled ELF is
# checked, not only the main binary, and the launch probe now fails when the
# app exits on its own, not just on a dynamic-linker message.
#
# The guest is expected to look like a desktop: GTK 3, its X11/GL stack and
# Xvfb installed (linux-appimage.yml's smoke job installs them). linuxdeploy
# deliberately leaves those host libraries (glibc, libGL, libX11, fontconfig,
# …) out of an AppImage, so on a bare container their absence would say
# nothing about the AppImage. What it does catch is a library the AppImage
# should have carried and did not (WebKitGTK, libsoup, JavaScriptCore), and a
# glibc or libstdc++ newer than the guest's.
#
# Usage: smoke-appimage.sh /path/to/Lattice*.AppImage
set -euo pipefail

appimage="${1:-}"
if [[ -z "$appimage" || ! -f "$appimage" ]]; then
  echo "usage: $0 /path/to/Lattice*.AppImage" >&2
  exit 2
fi

workdir="$(mktemp -d)"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

cp "$appimage" "$workdir/app.AppImage"
chmod +x "$workdir/app.AppImage"
(cd "$workdir" && ./app.AppImage --appimage-extract >/dev/null)
root="$workdir/squashfs-root"

inner="$root/usr/bin/research-writer"
if [[ ! -x "$inner" ]]; then
  echo "smoke failed: $inner is missing after extract" >&2
  find "$root" -maxdepth 3 -type f | head -40 >&2
  exit 1
fi
echo "inner binary: ${inner#"$workdir/"}"

# Every ELF executable or shared object the AppImage ships. The libraries
# resolve each other through the RUNPATH linuxdeploy writes, and AppRun puts
# usr/lib on LD_LIBRARY_PATH for the helpers WebKit spawns, so check them the
# way AppRun runs them.
missing=0
while IFS= read -r -d '' file; do
  head -c 4 "$file" 2>/dev/null | grep -q $'^\x7fELF' || continue
  if ! report="$(LD_LIBRARY_PATH="$root/usr/lib:$root/usr/lib/x86_64-linux-gnu" ldd "$file" 2>&1)"; then
    # ldd refuses static binaries and non-native objects; neither can miss a library.
    grep -Eq 'not a dynamic executable|statically linked' <<<"$report" && continue
  fi
  if grep -Eq 'not found|GLIBC_|GLIBCXX_|CXXABI_' <<<"$report"; then
    echo "smoke failed: ${file#"$root/"} cannot load:" >&2
    grep -E 'not found|GLIBC_|GLIBCXX_|CXXABI_' <<<"$report" >&2
    missing=1
  fi
done < <(find "$root" -type f \( -perm -u+x -o -name '*.so' -o -name '*.so.*' -o -name '*.node' \) -print0)
if ((missing)); then exit 1; fi
echo "ldd: every bundled ELF resolves its libraries"

# The app has nothing to answer --help with and opens its window instead, so
# a healthy launch is one still running when the timeout ends it (124). An
# exit before that is a crash at startup, whatever the reason.
#
# WebKit draws the page in a web process of its own, and when that process
# dies the app stays up with an empty window. That is how a Mesa newer than
# the AppImage's libwayland-client fails (unbundle-wayland-client.sh), so the
# web process must still be running too.
if command -v xvfb-run >/dev/null; then
  mkdir -p "$workdir/home"
  HOME="$workdir/home" timeout 20 xvfb-run -a "$root/AppRun" >"$workdir/launch.out" 2>"$workdir/launch.err" &
  launch=$!
  sleep 15
  web_process=no
  for process in /proc/[0-9]*; do
    if [[ "$(readlink "$process/exe" 2>/dev/null)" == "$root/"*/WebKitWebProcess ]]; then web_process=yes; fi
  done
  set +e
  wait "$launch"
  status=$?
  set -e
  if ((status != 124)); then
    echo "smoke failed: the app exited with $status within 20 s of launch" >&2
    tail -n 60 "$workdir/launch.out" "$workdir/launch.err" >&2
    exit 1
  fi
  if [[ "$web_process" != yes ]]; then
    echo "smoke failed: WebKit's web process was not running 15 s after launch, so the window is empty" >&2
    tail -n 60 "$workdir/launch.err" >&2
    exit 1
  fi
  if grep -Eiq 'error while loading shared libraries|GLIBC_|undefined symbol' "$workdir/launch.err"; then
    echo "smoke failed: loader errors at launch" >&2
    cat "$workdir/launch.err" >&2
    exit 1
  fi
  echo "launch: still running after 20 s under Xvfb, and so was WebKit's web process at 15 s"
else
  echo "smoke failed: xvfb-run is not installed in this guest" >&2
  exit 1
fi

echo "smoke ok: $(basename "$appimage")"
