#!/usr/bin/env bash
#
# Bootstrap a Lattice development environment from scratch.
#
# TARGET: a fresh Debian/Ubuntu machine (headless container or VM). It installs
# with apt and downloads Linux release archives. It will not work on macOS.
#
# macOS contributors: do NOT run this. Follow CONTRIBUTING.md instead — Homebrew
# and the Tauri prerequisites cover what apt does here, and `mise install` gets
# you the same Node and pnpm.
#
# What it does, in order:
#   1. apt-installs the Tauri and LaTeX build prerequisites;
#   2. installs mise (pinned, checksum-verified) and runs `mise install`, which
#      provisions Node and pnpm at the versions mise.toml pins — the same
#      versions `pnpm check` runs under, since `pnpm check` is `mise run check`;
#   3. installs the stable Rust toolchain with clippy, rustfmt, and the
#      aarch64-apple-darwin target;
#   4. installs a pinned, checksum-verified `uv` (optional — see that step);
#   5. installs locked dependencies for the app and collab-server;
#   6. fetches the pinned Synara source into SYNARA_SOURCE_DIR (defaulting to
#      the `sourceDirectory` in scripts/synara-runtime.json) and installs it
#      with bun — only needed to run the real agent sidecar;
#   7. writes the src-tauri/synara-runtime/placeholder.txt stub that lets cargo
#      compile Tauri's resource manifest without a staged sidecar;
#   8. warms the cargo registry.
#
# It only writes inside the repository, ~/.local, ~/.cargo and the Synara source
# directory. It does not edit your shell profile: the last thing it prints is
# the PATH line to add yourself.
#
# It is idempotent: every step checks before it acts, so re-running is cheap.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

case "$(uname -m)" in
  x86_64) machine_arch="x64"; rust_triple_arch="x86_64" ;;
  aarch64|arm64) machine_arch="arm64"; rust_triple_arch="aarch64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Everything this script installs lands here, so it is the one directory that
# has to be on PATH afterwards.
local_bin="$HOME/.local/bin"
mise_shims="$HOME/.local/share/mise/shims"
path_line="export PATH=\"\$HOME/.local/bin:\$HOME/.local/share/mise/shims:\$HOME/.cargo/bin:\$PATH\""
export PATH="$local_bin:$mise_shims:$HOME/.cargo/bin:$PATH"

step_started=0
start_step() {
  step_started=$SECONDS
  printf '\n==> %s\n' "$1"
}
finish_step() {
  printf '    completed in %ss\n' "$((SECONDS - step_started))"
}

start_step "Installing system packages required by Tauri and LaTeX"
packages=(
  build-essential
  curl
  file
  git
  latexmk
  libayatana-appindicator3-dev
  librsvg2-dev
  libssl-dev
  libwebkit2gtk-4.1-dev
  libxdo-dev
  pkg-config
  wget
  xz-utils
  zip
)
missing_packages=()
for package in "${packages[@]}"; do
  if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -Fq 'install ok installed'; then
    missing_packages+=("$package")
  fi
done
if ((${#missing_packages[@]})); then
  if ((EUID == 0)); then
    apt_prefix=()
  else
    apt_prefix=(sudo)
  fi
  "${apt_prefix[@]}" apt-get update
  "${apt_prefix[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi
finish_step

start_step "Installing mise, then Node.js and pnpm at the pinned versions"
# mise.toml is the single source of truth for the Node and pnpm versions, and
# `pnpm check` is literally `mise run check`, so mise is not optional: without
# it this box cannot run the gate. Installing Node by hand here instead is how
# this script used to drift a whole major version away from mise.toml.
#
# Pinned and verified against the SHASUMS256.txt published with the same
# release, like the uv install below. `curl https://mise.run | sh` would run
# whatever the server returned today, unverified.
mise_version="${MISE_VERSION:-v2026.8.8}"
mise_bin="$local_bin/mise"
if ! "$mise_bin" --version 2>/dev/null | grep -Fq "${mise_version#v}"; then
  mise_archive="mise-$mise_version-linux-$machine_arch.tar.gz"
  mise_base="https://github.com/jdx/mise/releases/download/$mise_version"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  curl -fsSLo "$tmp_dir/$mise_archive" "$mise_base/$mise_archive"
  curl -fsSLo "$tmp_dir/SHASUMS256.txt" "$mise_base/SHASUMS256.txt"
  # mise's checksum file lists paths as `./mise-…`, so match on that and strip
  # the prefix before handing the line to sha256sum.
  (
    cd "$tmp_dir"
    grep -F "  ./$mise_archive" SHASUMS256.txt | sed 's|\./||' | sha256sum --check --status
  )
  tar -xzf "$tmp_dir/$mise_archive" -C "$tmp_dir"
  mkdir -p "$local_bin"
  install -m 0755 "$tmp_dir/mise/bin/mise" "$mise_bin"
  rm -rf "$tmp_dir"
  trap - EXIT
fi
# `mise install` refuses to act on an untrusted config file when it cannot ask.
"$mise_bin" trust "$repo_root/mise.toml"
"$mise_bin" install
# Shims are what put the pinned `node` and `pnpm` on PATH for the rest of this
# script (and for any later shell that picks up the PATH line printed at the
# end) without needing `mise activate` in a profile.
"$mise_bin" reshim
finish_step

start_step "Installing the stable Rust toolchain"
if [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
fi
rustup toolchain install stable --profile minimal --component clippy,rustfmt
rustup target add aarch64-apple-darwin --toolchain stable
finish_step

start_step "Installing uv (optional; set SKIP_UV=1 to skip)"
# uv provisions the two Python literature CLIs the app shells out to
# (`bibcite-cli` and `arxiv2md`). Note what it is NOT for: the shipped macOS app
# never uses a `uv` from PATH. It downloads and checksum-verifies its own copy
# under ~/Library/Application Support and refuses to fall back to a PATH install
# (see MANAGED_UV_VERSION and managed_uv_tool_status in
# src-tauri/src/commands.rs). This copy is only so you can drive those tools by
# hand on a Linux dev box, which is why the step is skippable.
#
# It is pinned to the version the app manages, and the archive digest is
# recorded here rather than fetched, so a compromised release page cannot
# silently swap the binary. Bump both together when MANAGED_UV_VERSION moves.
uv_version="0.12.3"
uv_target="$rust_triple_arch-unknown-linux-gnu"
case "$rust_triple_arch" in
  x86_64) uv_sha256="600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101" ;;
  aarch64) uv_sha256="bb66cb52e7b1823aed1183630d8d8e5c958840d584a4c55ec10a4cfc168dcca2" ;;
esac
if [[ "${SKIP_UV:-0}" == "1" ]]; then
  printf '    skipped (SKIP_UV=1)\n'
elif "$local_bin/uv" --version 2>/dev/null | grep -Fq "$uv_version"; then
  printf '    already at %s\n' "$uv_version"
else
  uv_archive="uv-$uv_target.tar.gz"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  curl -fsSLo "$tmp_dir/$uv_archive" \
    "https://github.com/astral-sh/uv/releases/download/$uv_version/$uv_archive"
  printf '%s  %s\n' "$uv_sha256" "$tmp_dir/$uv_archive" | sha256sum --check --status
  tar -xzf "$tmp_dir/$uv_archive" -C "$tmp_dir"
  mkdir -p "$local_bin"
  install -m 0755 "$tmp_dir/uv-$uv_target/uv" "$local_bin/uv"
  install -m 0755 "$tmp_dir/uv-$uv_target/uvx" "$local_bin/uvx"
  rm -rf "$tmp_dir"
  trap - EXIT
fi
finish_step

start_step "Installing locked Lattice dependencies"
pnpm install --frozen-lockfile
pnpm --dir collab-server install --frozen-lockfile
bun_bin="$repo_root/node_modules/.bin/bun"
if ! "$bun_bin" --version >/dev/null 2>&1; then
  node node_modules/bun/install.js
fi
finish_step

start_step "Installing pinned Synara dependencies"
synara_repository="$(node -p "require('./scripts/synara-runtime.json').repository")"
synara_revision="$(node -p "require('./scripts/synara-runtime.json').revision")"
synara_source="${SYNARA_SOURCE_DIR:-$(node -p "require('./scripts/synara-runtime.json').sourceDirectory")}"
if [[ "$synara_source" != /* ]]; then
  synara_source="$repo_root/$synara_source"
fi

if [[ ! -d "$synara_source/.git" ]]; then
  if [[ -e "$synara_source" ]]; then
    if [[ ! -d "$synara_source" || -n "$(ls -A "$synara_source")" ]]; then
      echo "Synara source path exists but is not an empty directory: $synara_source" >&2
      exit 1
    fi
  fi
  mkdir -p "$synara_source"
  git init -q "$synara_source"
  git -C "$synara_source" remote add origin "$synara_repository"
  git -C "$synara_source" fetch --depth=1 origin "$synara_revision"
  git -C "$synara_source" -c advice.detachedHead=false checkout --detach FETCH_HEAD
else
  if ! git -C "$synara_source" remote get-url origin >/dev/null 2>&1; then
    git -C "$synara_source" remote add origin "$synara_repository"
  fi
  synara_head="$(git -C "$synara_source" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$synara_head" != "$synara_revision" ]]; then
    if [[ -n "$(git -C "$synara_source" status --short)" ]]; then
      echo "Synara has local changes; leaving it at $synara_head instead of checking out $synara_revision."
    else
      git -C "$synara_source" fetch --depth=1 origin "$synara_revision"
      git -C "$synara_source" -c advice.detachedHead=false checkout --detach FETCH_HEAD
    fi
  fi
fi

(
  cd "$synara_source"
  "$bun_bin" install --frozen-lockfile
)

# Cargo compiles Tauri's resource manifest even when tests never launch the
# sidecar. The desktop dev/build commands replace this stub with the real
# pinned runtime through their beforeDevCommand/beforeBuildCommand hooks.
if [[ ! -e src-tauri/synara-runtime/manifest.json ]]; then
  mkdir -p src-tauri/synara-runtime
  printf 'stub\n' > src-tauri/synara-runtime/placeholder.txt
fi
finish_step

start_step "Fetching Rust crates"
cargo fetch --manifest-path src-tauri/Cargo.toml
finish_step

printf '\nSetup complete in %ss.\n' "$SECONDS"
printf '\nThis script did not touch your shell profile. Add this line to it\n'
printf 'yourself (or run it in each shell) so the toolchains are on PATH:\n\n'
printf '  %s\n\n' "$path_line"
