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
    /usr/bin/grep -Eai 'not present|not found|failed|failure|error|cannot|could not|unavailable' "${LOG}" \
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
