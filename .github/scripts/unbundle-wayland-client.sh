#!/usr/bin/env bash
# Take libwayland-client out of the Linux AppImage, in place, so the app runs
# with the host's own copy:
#
#   unbundle-wayland-client.sh path/to/Lattice_<version>_amd64.AppImage
#
# Mesa's EGL driver is never bundled (it has to match the host's GPU driver),
# and it is built against the host's libwayland-client. linuxdeploy bundles
# the build machine's libwayland-client for GTK and WebKit, Ubuntu 22.04's
# 1.20, and that copy, loaded first, is the one Mesa gets. Mesa built against
# Wayland 1.24 or later (Ubuntu 26.04, Fedora 45, Arch) needs symbols 1.20
# lacks: wl_fixes_interface when it loads, and
# wl_display_dispatch_queue_timeout and wl_display_create_queue_with_name
# when called. Its EGL driver then fails to load, and WebKit's web process
# aborts with "Could not create default EGL display: EGL_BAD_PARAMETER",
# leaving the window empty while the app keeps running.
#
# Every host that can run the AppImage has a libwayland-client of its own:
# its EGL and GTK depend on it. Wayland keeps the library backward compatible,
# so the bundled GTK and WebKit, which need only 1.20's symbols, run with any
# later one.
#
# libwayland-server stays bundled. WebKit links it and Mesa no longer does, so
# a desktop without a Wayland compositor need not have it: a container with
# GTK and Mesa installed on Ubuntu 24.04 or 26.04 or Fedora 45 has none.
#
# The runtime at the start of the AppImage is kept byte for byte; only the
# squashfs image after it is rebuilt, with the same compression and block size.
# Needs unsquashfs and mksquashfs (squashfs-tools).
set -euo pipefail

fail() { echo "unbundle-wayland-client.sh: $1" >&2; exit 1; }
appimage="$(realpath "${1:?usage: unbundle-wayland-client.sh path/to/Lattice.AppImage}")"
for tool in unsquashfs mksquashfs; do
  command -v "$tool" >/dev/null || fail "needs $tool (squashfs-tools)"
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The runtime reports where the image starts without mounting it.
offset="$("$appimage" --appimage-offset)"
[[ "$offset" =~ ^[0-9]+$ ]] || fail "$appimage did not report its image offset"
head -c "$offset" "$appimage" > "$work/runtime"
superblock="$(unsquashfs -s -o "$offset" "$appimage")"
compression="$(awk '$1 == "Compression" { print $2 }' <<< "$superblock")"
block_size="$(awk '$1 == "Block" && $2 == "size" { print $3 }' <<< "$superblock")"
[[ -n "$compression" && -n "$block_size" ]] || fail "could not read the image's compression and block size"

unsquashfs -no-progress -no-xattrs -o "$offset" -d "$work/AppDir" "$appimage" >/dev/null
removed="$(cd "$work/AppDir" && find . -name 'libwayland-client.so*' -printf '%P\n' -delete)"
# A build that no longer bundles it needs this step looked at again, not run blind.
[[ -n "$removed" ]] || fail "the AppImage bundles no libwayland-client"
echo "removed from the AppImage: ${removed//$'\n'/, }"

mksquashfs "$work/AppDir" "$work/image" -root-owned -noappend -no-progress -no-xattrs \
  -comp "$compression" -b "$block_size" >/dev/null
cat "$work/runtime" "$work/image" > "$work/repacked.AppImage"
chmod 755 "$work/repacked.AppImage"

# The runtime must find the new image where it found the old one, and the new
# image must give back every file that was kept.
[[ "$("$work/repacked.AppImage" --appimage-offset)" == "$offset" ]] \
  || fail "the runtime does not find the rebuilt image"
(cd "$work" && ./repacked.AppImage --appimage-extract >/dev/null)
[[ "$(cd "$work/AppDir" && find . | sort)" == "$(cd "$work/squashfs-root" && find . | sort)" ]] \
  || fail "the rebuilt image does not extract to the files that were kept"

mv "$work/repacked.AppImage" "$appimage"
ls -l "$appimage"
