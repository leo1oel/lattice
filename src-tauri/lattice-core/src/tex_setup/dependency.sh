# Continues installer-prelude.sh: installs the one TeX Live package that
# provides a missing file.
TLMGR=__TLMGR_PATH__
PACKAGE=__PACKAGE_NAME__
# The repository the package was found in; "" is the configured one.
TEX_REPOSITORY=__REPOSITORY__

# The log stays protected, but the TeX files tlmgr writes must be readable and
# executable by the signed-in user who runs Lattice.
umask 022

# While the repository holds a newer tlmgr, tlmgr refuses every install until
# it updates itself; when it is current this changes nothing.
CURRENT_STEP="Updating the TeX Live package manager"
status installing-dependency
tlmgr_with_fallback update --self
CURRENT_STEP="Installing TeX Live package ${PACKAGE}"
tlmgr_with_fallback install "${PACKAGE}" 2>&1 | relay_progress installing-dependency
