#!/bin/bash
# The shared start of every privileged installer script. ROOT is a fresh
# folder this script creates and removes; the app polls STATUS for progress,
# and on failure the failed step plus the telling lines of LOG go to the
# original stderr, which the app shows.
set -euo pipefail
ROOT=__ROOT_PATH__
STATUS="${ROOT}/status"
LOG="${ROOT}/install.log"
CURRENT_STEP="Preparing the __INSTALLER_NAME__ installation"

umask 077
if ! /bin/mkdir -m 711 "${ROOT}"; then
  echo "Could not create the privileged __INSTALLER_NAME__ installer folder." >&2
  exit 1
fi
: > "${STATUS}"
/bin/chmod 644 "${STATUS}"
: > "${LOG}"
exec 3>&2

cleanup() {
  /bin/rm -rf "${ROOT}"
}

fail() {
  code=$?
  trap - ERR EXIT
  set +e
  printf '%s failed.\n' "${CURRENT_STEP}" >&3
  DIAGNOSTIC="$(
    /usr/bin/grep -Eai 'not present|not found|failed|failure|error|cannot|could not|unavailable|needs to be updated|older than|no space|denied|not permitted|read-only' "${LOG}" \
      | /usr/bin/grep -Ev 'An error has occurred|See above messages|Exiting' \
      | /usr/bin/tail -n 4
  )"
  if [[ -n "${DIAGNOSTIC}" ]]; then
    printf '%s\n' "${DIAGNOSTIC}" >&3
  else
    /usr/bin/tail -n 8 "${LOG}" >&3
  fi
  cleanup
  exit "${code}"
}

trap fail ERR
trap cleanup EXIT
exec > "${LOG}" 2>&1

status() {
  printf '%s\n' "$1" > "${STATUS}"
}

# Copy tlmgr's output into LOG and report its "[n/total," lines as
# "<stage> n total". A function rather than an inline loop: /bin/bash 3.2 skips
# the ERR trap when a failing pipeline ends in a compound command, so the
# script would exit without telling the app why.
relay_progress() {
  local line
  while IFS= read -r line; do
    printf '%s\n' "${line}"
    if [[ "${line}" =~ ^\[([0-9]+)/([0-9]+), ]]; then
      status "$1 ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
    fi
  done
}

# mirror.ctan.org can redirect to a mirror that is unreachable from the
# current network. Try TEX_REPOSITORY first ("" is the one the user
# configured), then the configured repository and two direct CTAN mirrors that
# are reachable from mainland China. --repository is per-command, so a
# fallback does not permanently rewrite their TeX setup. Runs TLMGR, which the
# installer script sets.
TEX_REPOSITORIES=(
  ""
  "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet"
  "https://mirrors.ustc.edu.cn/CTAN/systems/texlive/tlnet"
)
TEX_REPOSITORY=""
tlmgr_with_fallback() {
  local repository
  local label
  local candidates=("${TEX_REPOSITORY}")

  for repository in "${TEX_REPOSITORIES[@]}"; do
    if [[ "${repository}" != "${TEX_REPOSITORY}" ]]; then
      candidates+=("${repository}")
    fi
  done

  for repository in "${candidates[@]}"; do
    if [[ -n "${repository}" ]]; then
      if "${TLMGR}" --repository "${repository}" "$@"; then
        TEX_REPOSITORY="${repository}"
        return 0
      fi
      label="${repository}"
    else
      if "${TLMGR}" "$@"; then
        TEX_REPOSITORY=""
        return 0
      fi
      label="the configured TeX Live repository"
    fi
    echo "tlmgr failed with ${label}."
  done
  return 1
}
