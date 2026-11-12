# Continues installer-prelude.sh: updates TeX Live's package manager and then
# every installed package, for the BasicTeX Lattice installed (the doctor
# offers this when `tlmgr update --list` reports updates).
TLMGR=__TLMGR_PATH__

# The log stays protected, but the TeX files tlmgr writes must be readable and
# executable by the signed-in user who runs Lattice.
umask 022

CURRENT_STEP="Updating the TeX Live package manager"
status updating-packages
tlmgr_with_fallback update --self
CURRENT_STEP="Updating the installed LaTeX packages"
tlmgr_with_fallback update --all 2>&1 | relay_progress updating-packages
