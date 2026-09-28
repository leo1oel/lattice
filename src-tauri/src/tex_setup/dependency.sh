# Continues installer-prelude.sh: installs the one TeX Live package that
# provides a missing file.
TLMGR=__TLMGR_PATH__
PACKAGE=__PACKAGE_NAME__
REPOSITORY=__REPOSITORY__

tlmgr_install() {
  if [[ -n "${REPOSITORY}" ]]; then
    "${TLMGR}" --repository "${REPOSITORY}" install "${PACKAGE}"
  else
    "${TLMGR}" install "${PACKAGE}"
  fi
}

CURRENT_STEP="Installing TeX Live package ${PACKAGE}"
status installing-dependency
tlmgr_install 2>&1 | while IFS= read -r line; do
  printf '%s\n' "${line}"
  if [[ "${line}" =~ ^\[([0-9]+)/([0-9]+), ]]; then
    status "installing-dependency ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
  fi
done
