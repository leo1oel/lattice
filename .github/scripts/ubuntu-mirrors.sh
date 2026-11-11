#!/usr/bin/env bash
# Usage: ubuntu-mirrors.sh
#
# Prints the Ubuntu archive mirrors that answer from this runner, one per line
# in order of preference, and logs every probe on stderr. Exits non-zero when
# none answers.
#
# On 2026-11-11 the runners could not reach azure.archive.ubuntu.com (HTTP and
# HTTPS) or archive.ubuntu.com, and inside Docker the *.ubuntu.com names did
# not resolve at all, while HTTPS mirrors elsewhere answered. Probing keeps
# Azure's mirror first when it is healthy and moves past it when it is not.
set -euo pipefail

# shellcheck source=/dev/null
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
candidates=(
  http://azure.archive.ubuntu.com/ubuntu/
  https://azure.archive.ubuntu.com/ubuntu/
  http://archive.ubuntu.com/ubuntu/
  https://mirrors.edge.kernel.org/ubuntu/
  https://mirror.us.leaseweb.net/ubuntu/
  https://mirrors.ocf.berkeley.edu/ubuntu/
)
found=0
for mirror in "${candidates[@]}"; do
  if curl -fsS -4 --max-time 10 -o /dev/null "${mirror}dists/${codename}/InRelease"; then
    echo "mirror ok:   $mirror" >&2
    echo "$mirror"
    found=1
  else
    echo "mirror down: $mirror" >&2
  fi
done
if ((found == 0)); then
  echo "::error::no Ubuntu mirror answered" >&2
  exit 1
fi
