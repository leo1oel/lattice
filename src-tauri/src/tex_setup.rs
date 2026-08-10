//! One-click TeX install helpers for macOS (opens a Terminal `.command` script).

#[cfg(target_os = "macos")]
use std::{fs::OpenOptions, io::Write, process::Command};

#[cfg(target_os = "macos")]
use std::os::unix::fs::OpenOptionsExt;

#[cfg(target_os = "macos")]
const BASIC_SCRIPT: &str = r#"#!/bin/bash
set -euo pipefail
echo "=== Lattice: BasicTeX install ==="
echo ""

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi
  echo "Homebrew not found. Installing Homebrew first…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Could not find brew after install. Open a new Terminal window and try again."
    exit 1
  fi
}

ensure_brew

# Optional editor/research helpers the TeX doctor reports: texlab (LaTeX
# language server) and uv (literature fetching + bibliography management).
# Installed FIRST, before the TeX steps that can abort on a tlmgr/font error,
# so they land regardless of how the TeX install goes. Each is `|| echo`-guarded
# so a failure here never aborts the run.
echo "Installing optional editor/research tools (texlab, uv) — safe to skip if these fail…"
brew install texlab || echo "  (skipped texlab — install later with: brew install texlab)"
brew install uv || echo "  (skipped uv — install later with: brew install uv)"

echo ""
echo "Installing / repairing BasicTeX (safe if already installed)…"
echo "This also installs latexmk + conference fonts/packages."
brew install --cask basictex

eval "$(/usr/libexec/path_helper -s)" 2>/dev/null || true
export PATH="/Library/TeX/texbin:${PATH}"
TEXBIN="/Library/TeX/texbin"

wait_for_tex() {
  local tool="$1"
  if [[ -x "${TEXBIN}/${tool}" ]]; then
    return 0
  fi
  echo "Waiting for ${TEXBIN}/${tool}…"
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    [[ -x "${TEXBIN}/${tool}" ]] && return 0
    sleep 2
  done
  return 1
}

if ! wait_for_tex tlmgr; then
  echo "BasicTeX is marked installed, but ${TEXBIN}/tlmgr is missing."
  echo "Trying a clean reinstall of the BasicTeX package…"
  brew reinstall --cask basictex
  eval "$(/usr/libexec/path_helper -s)" 2>/dev/null || true
  export PATH="/Library/TeX/texbin:${PATH}"
fi
if ! wait_for_tex tlmgr; then
  echo "Still no ${TEXBIN}/tlmgr. Run: ls -la /Library/TeX/texbin"
  exit 1
fi

echo ""
echo "Installing latexmk + conference fonts/packages (admin password may be required)…"
echo "Already-installed packages are skipped — re-running this button is fine."
sudo "${TEXBIN}/tlmgr" update --self
# latexmk is intentionally NOT in the BasicTeX base package.
# tex-gyre / helvetic / courier / times keep NeurIPS/ICML Times+Helvetica looking sharp.
sudo "${TEXBIN}/tlmgr" install \
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
  mathptmx \
  cmap \
  csquotes

# ICML templates need algorithm.sty / algorithmic.sty (TeX Live package: algorithms).
if path="$("${TEXBIN}/kpsewhich" "algorithm.sty" 2>/dev/null)" && [[ -n "$path" ]]; then
  echo "  OK  algorithm.sty → $path"
else
  echo "  MISSING  algorithm.sty — installing algorithms again…"
  sudo "${TEXBIN}/tlmgr" install algorithms || true
fi

# Refresh font maps so PDF preview picks up the new Type1 faces.
if [[ -x "${TEXBIN}/updmap-sys" ]]; then
  echo "Refreshing font maps (updmap-sys)…"
  sudo "${TEXBIN}/updmap-sys" || true
fi

if [[ ! -x "${TEXBIN}/latexmk" ]]; then
  echo ""
  echo "FAILED: latexmk is still missing after tlmgr install."
  exit 1
fi

echo ""
echo "Verifying conference fonts (NeurIPS/ICML Times + Helvetica Type1)…"
FONT_FAIL=0
for f in t1ptm.fd ptmr8t.tfm t1phv.fd utmr8a.pfb utmb8a.pfb uhvr8a.pfb; do
  if path="$("${TEXBIN}/kpsewhich" "$f" 2>/dev/null)" && [[ -n "$path" ]]; then
    echo "  OK  $f → $path"
  else
    echo "  MISSING  $f"
    FONT_FAIL=1
  fi
done

if [[ "$FONT_FAIL" -ne 0 ]]; then
  echo ""
  echo "FAILED: fonts are incomplete. Scroll up for tlmgr errors, then click Install BasicTeX again in Lattice."
  exit 1
fi

echo ""
echo "Compiling a tiny NeurIPS-style probe (no poppler needed)…"
PROBE="$(mktemp -d)/probe"
mkdir -p "$(dirname "$PROBE")"
cat > "${PROBE}.tex" <<'TEX'
\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{times}
\begin{document}
NeurIPS font probe.
\end{document}
TEX
if "${TEXBIN}/pdflatex" -interaction=nonstopmode -output-directory "$(dirname "$PROBE")" "${PROBE}.tex" >/tmp/lattice-font-probe.log 2>&1 \
  && python3 - "$PROBE.pdf" <<'PY'
import re, sys
from pathlib import Path
data = Path(sys.argv[1]).read_bytes()
names = sorted({m.decode("latin1", "replace").rsplit("+", 1)[-1]
                for m in re.findall(rb"/BaseFont\s*/([^\s/]+)", data)})
print("Embedded fonts:", ", ".join(names) or "(none)")
ok = any("NimbusRom" in n or "Times" in n for n in names)
sys.exit(0 if ok else 1)
PY
then
  echo "PROBE OK — PDF embeds Times/NimbusRom."
else
  echo "PROBE WARNING — Type1 files exist but probe PDF did not embed Times."
  echo "See /tmp/lattice-font-probe.log"
fi

echo ""
echo "FONTS OK — Type1 Times/Helvetica outlines are present."
echo "Lattice will re-check the real paper PDF on Build / Recheck (no pdffonts install)."
echo "Verified tools:"
ls -la "${TEXBIN}/latexmk" "${TEXBIN}/pdflatex" "${TEXBIN}/synctex" "${TEXBIN}/bibtex"
echo ""
echo "Go back to Lattice → click Recheck → Shift-click Build (clean rebuild)."
echo ""
read -r -p "Press Enter to close this window…"
"#;

#[cfg(target_os = "macos")]
const FULL_SCRIPT: &str = r#"#!/bin/bash
set -euo pipefail
echo "=== Lattice: MacTeX full install (~4 GB) ==="
echo "This takes a while. Leave this window open."
echo ""

ensure_brew() {
  if command -v brew >/dev/null 2>&1; then
    return 0
  fi
  echo "Homebrew not found. Installing Homebrew first…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  if ! command -v brew >/dev/null 2>&1; then
    echo "Could not find brew after install. Open a new Terminal window and try again."
    exit 1
  fi
}

ensure_brew

# Optional editor/research helpers the TeX doctor reports (MacTeX already ships
# biber + texcount): texlab (LaTeX language server) and uv (literature fetching
# + bibliography management). Installed FIRST so they land even if the long
# MacTeX install hits trouble. `|| echo`-guarded.
echo "Installing optional editor/research tools (texlab, uv) — safe to skip if these fail…"
brew install texlab || echo "  (skipped texlab — install later with: brew install texlab)"
brew install uv || echo "  (skipped uv — install later with: brew install uv)"

echo ""
echo "Installing MacTeX…"
brew install --cask mactex

eval "$(/usr/libexec/path_helper -s)" 2>/dev/null || true
export PATH="/Library/TeX/texbin:${PATH}"
TEXBIN="/Library/TeX/texbin"
if [[ ! -x "${TEXBIN}/latexmk" ]]; then
  echo "FAILED: MacTeX finished but latexmk is missing."
  exit 1
fi

echo ""
echo "Verifying conference fonts (Type1 outlines)…"
FONT_FAIL=0
for f in t1ptm.fd ptmr8t.tfm t1phv.fd utmr8a.pfb utmb8a.pfb uhvr8a.pfb; do
  if path="$("${TEXBIN}/kpsewhich" "$f" 2>/dev/null)" && [[ -n "$path" ]]; then
    echo "  OK  $f → $path"
  else
    echo "  MISSING  $f"
    FONT_FAIL=1
  fi
done
if [[ "$FONT_FAIL" -ne 0 ]]; then
  echo "FAILED: fonts incomplete after MacTeX install."
  exit 1
fi

echo ""
echo "FONTS OK — Type1 Times/Helvetica outlines are present."
echo "Lattice checks the paper PDF on Build / Recheck (no pdffonts needed)."
ls -la "${TEXBIN}/latexmk" "${TEXBIN}/pdflatex" "${TEXBIN}/synctex" "${TEXBIN}/bibtex"
echo ""
echo "Go back to Lattice → Recheck → Shift-click Build."
echo ""
read -r -p "Press Enter to close this window…"
"#;

#[cfg(any(target_os = "macos", test))]
const DEPENDENCY_SCRIPT: &str = r#"#!/bin/bash
set -u
echo "=== Lattice: install missing LaTeX package ==="
echo ""

MISSING_FILE="__MISSING_FILE__"
TLMGR=__TLMGR_PATH__
KPSEWHICH=__KPSEWHICH_PATH__
SEARCH_PATTERN=__SEARCH_PATTERN__

if [[ ! -x "${TLMGR}" || ! -x "${KPSEWHICH}" ]]; then
  echo "TeX Live's package manager could not be found beside the compiler Lattice uses."
  echo "Install BasicTeX or MacTeX from Lattice first."
  echo ""
  read -r -p "Press Enter to close this window…"
  exit 1
fi

echo "Looking up the TeX Live package that provides ${MISSING_FILE}…"
SEARCH_OUTPUT="$("${TLMGR}" search --global --file "${SEARCH_PATTERN}" 2>&1)"
SEARCH_STATUS=$?
printf '%s\n' "${SEARCH_OUTPUT}"

if [[ "${SEARCH_STATUS}" -ne 0 ]]; then
  echo ""
  echo "The TeX Live repository could not be searched."
  echo "The output above usually explains whether the repository or TeX Live version needs attention."
  echo ""
  read -r -p "Press Enter to close this window…"
  exit 1
fi

PACKAGE="$(printf '%s\n' "${SEARCH_OUTPUT}" | awk -v wanted="/${MISSING_FILE}" '
  /^[[:alnum:]][[:alnum:]_.+-]*:$/ { package=$0; sub(/:$/, "", package); next }
  /^[[:space:]]/ {
    path=$0
    sub(/^[[:space:]]+/, "", path)
    if (length(path) >= length(wanted) && substr(path, length(path) - length(wanted) + 1) == wanted) {
      if (owner != "" && owner != package) { print "__AMBIGUOUS__"; exit }
      owner=package
    }
  }
  END { if (owner != "") print owner }
')"
if [[ "${PACKAGE}" == "__AMBIGUOUS__"* ]]; then
  echo ""
  echo "More than one TeX Live package claims ${MISSING_FILE}; nothing was installed automatically."
  echo "Review the search results above and install the appropriate package manually."
  echo ""
  read -r -p "Press Enter to close this window…"
  exit 1
elif [[ -z "${PACKAGE}" ]]; then
  echo ""
  echo "No TeX Live package provides ${MISSING_FILE}."
  echo "It may be a custom project or conference-template file; sync or copy it from Overleaf into the project folder."
  echo ""
  read -r -p "Press Enter to close this window…"
  exit 1
fi

echo ""
echo "Installing TeX Live package: ${PACKAGE}"
TEXMFROOT="$("${KPSEWHICH}" -var-value=TEXMFROOT 2>/dev/null || true)"
if [[ -n "${TEXMFROOT}" && -w "${TEXMFROOT}" ]]; then
  "${TLMGR}" install "${PACKAGE}"
else
  sudo "${TLMGR}" install "${PACKAGE}"
fi

echo ""
if FOUND="$("${KPSEWHICH}" "${MISSING_FILE}" 2>/dev/null)" && [[ -n "${FOUND}" ]]; then
  echo "Installed ${MISSING_FILE} → ${FOUND}"
  echo "Return to Lattice and Build again."
else
  echo "The package installed, but ${MISSING_FILE} is still unavailable."
  echo "Review the tlmgr output above or install full MacTeX from Lattice."
fi
echo ""
read -r -p "Press Enter to close this window…"
"#;

#[cfg(target_os = "macos")]
fn open_terminal_script(path: &std::path::Path, script: &str) -> Result<(), String> {
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(path)
            .map_err(|error| format!("Could not create install script: {error}"))?;
        file.write_all(script.as_bytes())
            .map_err(|error| format!("Could not write install script: {error}"))?;
    }

    let status = Command::new("open")
        .arg(path)
        .status()
        .map_err(|error| format!("Could not open Terminal for TeX install: {error}"))?;
    if !status.success() {
        return Err("Could not open Terminal for TeX install.".into());
    }
    Ok(())
}

pub fn start_tex_install(kind: &str) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        Err("One-click TeX install is only available on macOS.".into())
    }

    #[cfg(target_os = "macos")]
    {
        let (label, script) = match kind {
            "basic" => ("basic", BASIC_SCRIPT),
            "full" => ("full", FULL_SCRIPT),
            _ => return Err("Unknown TeX install option.".into()),
        };

        let path = std::env::temp_dir().join(format!(
            "lattice-tex-install-{label}-{}.command",
            uuid::Uuid::new_v4().simple()
        ));
        open_terminal_script(&path, script)
    }
}

pub fn start_tex_dependency_install(missing_file: &str) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = missing_file;
        Err("One-click TeX package install is only available on macOS.".into())
    }

    #[cfg(target_os = "macos")]
    {
        if !valid_tex_dependency_name(missing_file) {
            return Err("Invalid missing TeX dependency name.".into());
        }

        let tlmgr = crate::commands::resolve("tlmgr");
        if !tlmgr.is_file() {
            return Err("TeX Live's package manager is not installed.".into());
        }
        let kpsewhich = tlmgr
            .parent()
            .map(|parent| parent.join("kpsewhich"))
            .filter(|path| path.is_file())
            .ok_or_else(|| "kpsewhich was not found beside tlmgr.".to_string())?;
        let search_pattern = format!("/{}$", regex::escape(missing_file));
        let script = DEPENDENCY_SCRIPT
            .replace("__MISSING_FILE__", missing_file)
            .replace("__TLMGR_PATH__", &shell_quote(&tlmgr.to_string_lossy()))
            .replace(
                "__KPSEWHICH_PATH__",
                &shell_quote(&kpsewhich.to_string_lossy()),
            )
            .replace("__SEARCH_PATTERN__", &shell_quote(&search_pattern));
        let path = std::env::temp_dir().join(format!(
            "lattice-tex-dependency-install-{}.command",
            uuid::Uuid::new_v4().simple()
        ));
        open_terminal_script(&path, &script)
    }
}

#[cfg(any(target_os = "macos", test))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(target_os = "macos", test))]
fn valid_tex_dependency_name(missing_file: &str) -> bool {
    let valid_name = !missing_file.is_empty()
        && missing_file
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte));
    let valid_extension = ["sty", "cls", "bst", "bbx", "cbx"]
        .iter()
        .any(|extension| missing_file.ends_with(&format!(".{extension}")));
    valid_name && valid_extension
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_installer_looks_up_the_owning_tex_live_package() {
        assert!(DEPENDENCY_SCRIPT.contains("${TLMGR}\" search --global --file"));
        assert!(DEPENDENCY_SCRIPT.contains("sudo \"${TLMGR}\" install \"${PACKAGE}\""));
        assert!(DEPENDENCY_SCRIPT.contains("custom project or conference-template file"));
    }

    #[test]
    fn dependency_name_validation_prevents_terminal_injection() {
        assert!(valid_tex_dependency_name("algorithm.sty"));
        assert!(valid_tex_dependency_name("biblatex-authoryear.bbx"));
        assert!(!valid_tex_dependency_name("../../evil.sty"));
        assert!(!valid_tex_dependency_name("evil.sty; open /tmp"));
        assert!(!valid_tex_dependency_name("main.tex"));
    }

    #[test]
    fn shell_paths_are_quoted_before_being_written_to_the_installer() {
        assert_eq!(
            shell_quote("/Users/Leo's TeX/tlmgr"),
            "'/Users/Leo'\"'\"'s TeX/tlmgr'"
        );
    }
}
