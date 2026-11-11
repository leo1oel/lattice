#!/usr/bin/env bash
# Usage: apt-install.sh <package>...
#
# Installs Ubuntu packages on a GitHub-hosted runner without hanging the job.
# On 2026-11-11 a bare `apt-get update && apt-get install` on ubuntu-22.04
# stalled for hours on every run until GitHub's 6 h default killed it.
#
# - Every package the workflows need is in the Ubuntu archive, so the
#   runner image's third-party lists (packages.microsoft.com and friends) are
#   disabled: an outage there can no longer stall `apt-get update`.
# - apt's own retries and connect/read timeouts catch a slow or dropped
#   mirror; `timeout` bounds each attempt for stalls apt's timeouts miss.
# - A failed attempt is retried a bounded number of times, then the step fails.
set -euo pipefail

if (($# == 0)); then
  echo "usage: $0 <package>..." >&2
  exit 2
fi

apt_opts=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=20
  -o Acquire::https::Timeout=20
  -o DPkg::Lock::Timeout=120
)

shopt -s nullglob
for list in /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  # ubuntu-24.04 keeps the Ubuntu archive itself in sources.list.d.
  if grep -Eq '(archive|security|ports)\.ubuntu\.com' "$list"; then continue; fi
  echo "Disabling third-party apt source $list"
  sudo mv "$list" "$list.disabled"
done
shopt -u nullglob

# The runner's Ubuntu sources read `mirror+file:/etc/apt/apt-mirrors.txt`,
# which names only Azure's mirror; on 2026-11-11 that mirror stopped answering
# and every fetch timed out. Canonical's archive goes first, Azure stays as a
# fallback. An image without the mirror list gets its plain Azure URLs
# rewritten instead.
if [[ -f /etc/apt/apt-mirrors.txt ]]; then
  printf '%s\n' http://archive.ubuntu.com/ubuntu/ http://azure.archive.ubuntu.com/ubuntu/ |
    sudo tee /etc/apt/apt-mirrors.txt
fi
if [[ -f /etc/apt/sources.list ]]; then
  sudo sed -i 's#http://azure\.archive\.ubuntu\.com/#http://archive.ubuntu.com/#g' /etc/apt/sources.list
fi

retry() {
  local seconds=$1
  shift
  for attempt in 1 2 3; do
    echo "::group::$* (attempt $attempt, $(date -u +%H:%M:%SZ))"
    if sudo timeout --kill-after=10 "$seconds" "$@"; then
      echo "::endgroup::"
      return 0
    fi
    echo "::endgroup::"
    echo "::warning::attempt $attempt of '$*' failed or exceeded ${seconds}s"
    if ((attempt == 3)); then return 1; fi
    # A killed install can leave dpkg half-configured; finish it first.
    sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
    sleep $((attempt * 10))
  done
}

retry 180 apt-get "${apt_opts[@]}" update
retry 600 env DEBIAN_FRONTEND=noninteractive \
  apt-get "${apt_opts[@]}" install -y --no-install-recommends "$@"
