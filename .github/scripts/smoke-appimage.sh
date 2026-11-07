#!/usr/bin/env bash
# Portability smoke: extract an AppImage and check the inner binary links.
# Does not require FUSE. Run inside the 22.04 builder or a guest with the
# AppImage bind-mounted.
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
cd "$workdir"
./app.AppImage --appimage-extract >/dev/null

inner="$(find squashfs-root -type f \( -name Lattice -o -name research-writer \) 2>/dev/null | head -n1 || true)"
if [[ -z "$inner" ]]; then
  inner="$(find squashfs-root -type f -executable | head -n1 || true)"
fi
if [[ -z "$inner" ]]; then
  echo "smoke failed: no executable found after extract" >&2
  find squashfs-root -maxdepth 3 -type f | head -40 >&2
  exit 1
fi

echo "inner binary: $inner"
if command -v ldd >/dev/null; then
  if ldd "$inner" 2>&1 | grep -F 'not found'; then
    echo "smoke failed: missing shared libraries" >&2
    ldd "$inner" || true
    exit 1
  fi
  echo "ldd: ok (no 'not found')"
fi

# Soft launch under Xvfb when available; fail on immediate dynamic-linker errors.
if command -v xvfb-run >/dev/null; then
  set +e
  timeout 8 xvfb-run -a "$inner" --help >/tmp/lattice-smoke.out 2>/tmp/lattice-smoke.err
  status=$?
  set -e
  if grep -Eiq 'error while loading shared libraries|GLIBC_|^Segmentation' /tmp/lattice-smoke.err 2>/dev/null; then
    echo "smoke failed: launch linker/runtime error" >&2
    cat /tmp/lattice-smoke.err >&2
    exit 1
  fi
  echo "xvfb launch probe exited $status (linker errors absent)"
fi

echo "smoke ok: $(basename "$appimage")"
