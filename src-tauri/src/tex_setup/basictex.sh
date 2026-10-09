# Continues installer-prelude.sh: installs the pinned BasicTeX package (when
# INSTALL_BASE is 1) and the TeX Live packages Lattice requires.
SOURCE_PACKAGE=__SOURCE_PACKAGE__
EXPECTED_SHA256=__EXPECTED_SHA256__
INSTALL_BASE=__INSTALL_BASE__
TEXBIN="/Library/TeX/texbin"
TLMGR="${TEXBIN}/tlmgr"
PACKAGE="${ROOT}/BasicTeX.pkg"

EXPECTED_TEXMFROOT="/usr/local/texlive/2026basic"
repair_basictex_permissions() {
  local texmfroot
  local owner_uid

  if ! texmfroot="$("${TEXBIN}/kpsewhich" -var-value=TEXMFROOT 2>/dev/null)"; then
    return 0
  fi
  if [[ "${texmfroot}" != "${EXPECTED_TEXMFROOT}" ]]; then
    return 0
  fi

  CURRENT_STEP="Repairing BasicTeX permissions"
  if [[ -L "${EXPECTED_TEXMFROOT}" ]]; then
    echo "Refusing to repair a symbolic-link BasicTeX installation root: ${EXPECTED_TEXMFROOT}"
    false
  fi
  if [[ ! -d "${EXPECTED_TEXMFROOT}" ]]; then
    echo "BasicTeX reported ${EXPECTED_TEXMFROOT}, but it is not a directory."
    false
  fi
  owner_uid="$(/usr/bin/stat -f '%u' "${EXPECTED_TEXMFROOT}")"
  if [[ "${owner_uid}" != "0" ]]; then
    echo "Refusing to repair a BasicTeX tree not owned by root: ${EXPECTED_TEXMFROOT}"
    false
  fi

  /bin/chmod -R -P a+rX "${EXPECTED_TEXMFROOT}"
}

if [[ "${INSTALL_BASE}" == "1" ]]; then
  /bin/cp "${SOURCE_PACKAGE}" "${PACKAGE}"
  ACTUAL_SHA256="$(/usr/bin/shasum -a 256 "${PACKAGE}" | /usr/bin/awk '{print $1}')"
  if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
    echo "The privileged BasicTeX package failed its security check."
    false
  fi
fi

# The private package copy and log stay protected, but system TeX files must
# be readable and executable by the signed-in user who runs Lattice.
umask 022

if [[ "${INSTALL_BASE}" == "1" ]]; then
  CURRENT_STEP="Installing BasicTeX"
  status installing-base
  /usr/sbin/installer -pkg "${PACKAGE}" -target /
fi

if [[ ! -x "${TLMGR}" ]]; then
  echo "BasicTeX installed, but ${TLMGR} is missing."
  false
fi

repair_basictex_permissions

CURRENT_STEP="Updating the TeX Live package manager"
status installing-packages
tlmgr_with_fallback update --self
# latexmk is intentionally not part of the BasicTeX base package. The
# collections and Type1 fonts cover Lattice's bundled conference templates.
CURRENT_STEP="Installing the required LaTeX packages"
tlmgr_with_fallback install \
  latexmk \
  biber \
  texcount \
  collection-latexextra \
  collection-fontsrecommended \
  algorithms \
  algorithmicx \
  tex-gyre \
  helvetic \
  courier \
  times \
  psnfss \
  cmap \
  csquotes 2>&1 | relay_progress installing-packages

if [[ -x "${TEXBIN}/updmap-sys" ]]; then
  CURRENT_STEP="Refreshing the TeX font maps"
  "${TEXBIN}/updmap-sys"
fi
