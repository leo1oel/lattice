#!/usr/bin/env bash
# Setup and teardown for the signing macOS jobs: release.yml's `release` and
# gpui-package.yml's `macos`. They run on the Mac mini through runner-up
# unless the LATTICE_MACOS_RUNNER repository variable names a GitHub runner
# (docs/release-process.md, "Where the macOS jobs run").
#
# A runner-up host place is the Mac mini itself, signed in as its owner, not
# a fresh VM: the job shares the owner's home, keychains and disk with the
# crew's own work. It never opens a window (the dmg steps run headless:
# tauri's bundle_dmg.sh skips its Finder script under CI=true, and
# gpui-bundle.mjs uses hdiutil alone), so it takes no in-app lock and runs
# beside an e2e or a gate. On a self-hosted runner only:
#   begin    refuses to start below the disk floor, sizes cargo's jobs to the
#            place, and turns off the owner's sccache (~/.cargo/config.toml)
#            so nothing the build compiles in, such as LATTICE_FIRECRAWL_KEY,
#            lands in a cache that outlives the job.
# On every runner:
#   import-certificate  makes the job's own keychain and puts it in front of
#            the user's search list (never replacing the list: the owner's
#            login keychain stays in it), deletes the .p12 at once, and
#            exports APPLE_SIGNING_IDENTITY.
#   api-key  writes the App Store Connect key (mode 600) and exports
#            APPLE_API_KEY_PATH.
#   cleanup  (if: always()) deletes the keychain, takes it off the search
#            list, deletes the key files and the licensed fonts, and fails
#            when a signing keychain is still listed.
set -euo pipefail

keychain="$RUNNER_TEMP/lattice-signing.keychain-db"
certificate="$RUNNER_TEMP/apple-developer-certificate.p12"
# Free space the Mac mini must have when the job starts. The job's own
# build, about 8 GB at its peak, goes with the job's folder when it ends.
min_free_gb="${LATTICE_RELEASE_MIN_FREE_GB:-20}"

self_hosted() { [[ "${RUNNER_ENVIRONMENT:-}" == self-hosted ]]; }

# The user search list without our keychain, or a stale one that a killed
# job left behind (its file went with that job's folder).
search_list_without_ours() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' |
    while IFS= read -r entry; do
      [[ -z "$entry" || "$entry" == "$keychain" ]] && continue
      [[ "$entry" == */lattice-signing.keychain-db && ! -e "$entry" ]] && continue
      printf '%s\n' "$entry"
    done
}

# Sets the search list to the arguments followed by the lines on stdin. An
# empty result would leave the user with no keychains at all, so it is
# refused.
set_search_list() {
  local entries=("$@")
  while IFS= read -r entry; do entries+=("$entry"); done
  if ((${#entries[@]} == 0)); then
    echo "::error::Refusing to empty the keychain search list."
    return 1
  fi
  security list-keychains -d user -s "${entries[@]}"
}

case "${1:-}" in
  begin)
    self_hosted || exit 0
    free_gb="$(df -g "$GITHUB_WORKSPACE" | awk 'NR == 2 { print $4 }')"
    if ((free_gb < min_free_gb)); then
      echo "::error::$free_gb GB free on this Mac, under the ${min_free_gb} GB floor. Free space and re-run, or set the LATTICE_MACOS_RUNNER variable to macos-latest."
      exit 1
    fi
    # rustc peaks near 2 GB on Zed's largest crates: stay inside the place.
    jobs=$((${RUNNER_UP_MEMORY_MB:-8192} / 2048))
    cores="${RUNNER_UP_CORES:-4}"
    ((jobs > cores)) && jobs="$cores"
    ((jobs < 1)) && jobs=1
    echo "$free_gb GB free; place of ${RUNNER_UP_CORES:-?} cores and ${RUNNER_UP_MEMORY_MB:-?} MB; cargo -j $jobs."
    {
      echo "CARGO_BUILD_JOBS=$jobs"
      # Empty overrides build.rustc-wrapper in the owner's cargo config.
      echo "RUSTC_WRAPPER="
    } >> "$GITHUB_ENV"
    ;;

  import-certificate)
    : "${APPLE_CERTIFICATE:?}" "${APPLE_CERTIFICATE_PASSWORD:?}" "${KEYCHAIN_PASSWORD:?}"
    (umask 077 && printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate")
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
    security set-keychain-settings -lut 21600 "$keychain"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
    security import "$certificate" \
      -k "$keychain" \
      -P "$APPLE_CERTIFICATE_PASSWORD" \
      -T /usr/bin/codesign
    rm -f "$certificate"
    security set-key-partition-list \
      -S apple-tool:,apple:,codesign: \
      -s \
      -k "$KEYCHAIN_PASSWORD" \
      "$keychain" > /dev/null
    search_list_without_ours | set_search_list "$keychain"

    signing_identity="$(
      security find-identity -v -p codesigning "$keychain" |
        awk -F '"' '/Developer ID Application/ { print $2; exit }'
    )"
    test -n "$signing_identity"
    echo "APPLE_SIGNING_IDENTITY=$signing_identity" >> "$GITHUB_ENV"
    ;;

  api-key)
    : "${APPLE_API_KEY:?}" "${APPLE_API_PRIVATE_KEY:?}"
    api_key_path="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY}.p8"
    (umask 077 && printf '%s' "$APPLE_API_PRIVATE_KEY" > "$api_key_path")
    echo "APPLE_API_KEY_PATH=$api_key_path" >> "$GITHUB_ENV"
    ;;

  cleanup)
    status=0
    if [[ -e "$keychain" ]]; then
      security delete-keychain "$keychain" || status=1
    fi
    search_list_without_ours | set_search_list || status=1
    rm -rf "$certificate" "$RUNNER_TEMP"/AuthKey_*.p8 "$RUNNER_TEMP/lattice-fonts" "$RUNNER_TEMP"/lattice-fonts-ssh.* || status=1
    if security list-keychains -d user | grep -q 'lattice-signing'; then
      echo "::error::A signing keychain is still on the search list."
      status=1
    fi
    exit "$status"
    ;;

  *)
    echo "usage: $0 begin | import-certificate | api-key | cleanup" >&2
    exit 2
    ;;
esac
