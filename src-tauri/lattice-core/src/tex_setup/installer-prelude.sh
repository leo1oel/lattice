#!/bin/bash
# The shared start of every privileged installer script. ROOT is a fresh
# folder this script creates and removes; the app polls STATUS for progress,
# and on failure the failed step plus the telling lines of LOG go to the
# original stderr, which the app shows. A step that may fail without failing
# the install writes its warning to fd 4, the original stdout, which
# `do shell script` hands back to the app on success.
set -euo pipefail
ROOT=__ROOT_PATH__
STATUS="${ROOT}/status"
LOG="${ROOT}/install.log"
CURRENT_STEP="Preparing the __INSTALLER_NAME__ installation"
# The TeX Live year tree to give the signed-in user (HANDOFF_UID) when this
# script's tlmgr runs end, successful or not, so later updates and package
# installs run as that user without the administrator prompt; files tlmgr
# just wrote as root are handed over with the rest. "" when the script runs
# as that user already, or the TeX is not a TeX Live year tree.
HANDOFF_TREE=__HANDOFF_TREE__
HANDOFF_UID=__HANDOFF_UID__

umask 077
if ! /bin/mkdir -m 711 "${ROOT}"; then
  echo "Could not create the privileged __INSTALLER_NAME__ installer folder." >&2
  exit 1
fi
: > "${STATUS}"
/bin/chmod 644 "${STATUS}"
: > "${LOG}"
exec 3>&2
exec 4>&1

cleanup() {
  /bin/rm -rf "${ROOT}"
}

# The telling lines of LOG: the last errors tlmgr or the installer logged,
# else its last lines.
log_diagnostic() {
  local diagnostic
  diagnostic="$(
    /usr/bin/grep -Eai 'not present|not found|failed|failure|error|cannot|could not|unavailable|needs to be updated|older than|no space|denied|not permitted|read-only' "${LOG}" \
      | /usr/bin/grep -Ev 'An error has occurred|See above messages|Exiting' \
      | /usr/bin/tail -n 4
  )" || true
  if [[ -n "${diagnostic}" ]]; then
    printf '%s\n' "${diagnostic}"
  else
    /usr/bin/tail -n 8 "${LOG}"
  fi
}

# -P: a symbolic link inside the tree is re-owned itself, never followed.
hand_over_tree() {
  if [[ -z "${HANDOFF_TREE}" || ! -d "${HANDOFF_TREE}" ]]; then
    return 0
  fi
  if [[ -L "${HANDOFF_TREE}" ]]; then
    echo "Refusing to hand over a symbolic-link TeX Live tree: ${HANDOFF_TREE}"
    return 1
  fi
  /usr/sbin/chown -R -P "${HANDOFF_UID}" "${HANDOFF_TREE}"
}

fail() {
  code=$?
  trap - ERR EXIT
  set +e
  printf '%s failed.\n' "${CURRENT_STEP}" >&3
  log_diagnostic >&3
  # A failed run still hands the tree over, so trying again needs no prompt.
  hand_over_tree >> "${LOG}" 2>&1
  cleanup
  exit "${code}"
}

trap fail ERR
trap cleanup EXIT
exec > "${LOG}" 2>&1

status() {
  printf '%s\n' "$1" > "${STATUS}"
}

# Copy tlmgr's output into LOG and report its "[n/total," lines (n padded with
# spaces to the width of total) as "<stage> n total". A function rather than
# an inline loop: /bin/bash 3.2 skips the ERR trap when a failing pipeline ends
# in a compound command, so the script would exit without telling the app why.
relay_progress() {
  local line
  while IFS= read -r line; do
    printf '%s\n' "${line}"
    if [[ "${line}" =~ ^\[\ *([0-9]+)/([0-9]+), ]]; then
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
