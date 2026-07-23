//! One-click TeX install helpers for macOS (opens a Terminal `.command` script).

use std::fs;
use std::io::Write;
use std::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

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

# Optional editor/agent helpers the TeX doctor reports: texlab (LaTeX language
# server), uv (Python research skills + arXiv paper import), node → npx (bibcite
# .bib formatting). Installed FIRST, before the TeX steps that can abort on a
# tlmgr/font error, so they land regardless of how the TeX install goes. Each is
# `|| echo`-guarded so a failure here never aborts the run.
echo "Installing optional editor/agent tools (texlab, uv, node) — safe to skip if these fail…"
brew install texlab || echo "  (skipped texlab — install later with: brew install texlab)"
brew install uv || echo "  (skipped uv — install later with: brew install uv)"
brew install node || echo "  (skipped node/npx — install later with: brew install node)"

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

# Optional editor/agent helpers the TeX doctor reports (MacTeX already ships
# biber + texcount): texlab (LaTeX language server), uv (Python research skills +
# arXiv import), node → npx (bibcite .bib formatting). Installed FIRST so they
# land even if the long MacTeX install hits trouble. `|| echo`-guarded.
echo "Installing optional editor/agent tools (texlab, uv, node) — safe to skip if these fail…"
brew install texlab || echo "  (skipped texlab — install later with: brew install texlab)"
brew install uv || echo "  (skipped uv — install later with: brew install uv)"
brew install node || echo "  (skipped node/npx — install later with: brew install node)"

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

pub fn start_tex_install(kind: &str) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
        return Err("One-click TeX install is only available on macOS.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let (label, script) = match kind {
            "basic" => ("basic", BASIC_SCRIPT),
            "full" => ("full", FULL_SCRIPT),
            _ => return Err("Unknown TeX install option.".into()),
        };

        let path = std::env::temp_dir().join(format!("lattice-tex-install-{label}.command"));
        {
            let mut file = fs::File::create(&path)
                .map_err(|error| format!("Could not create install script: {error}"))?;
            file.write_all(script.as_bytes())
                .map_err(|error| format!("Could not write install script: {error}"))?;
        }

        let mut permissions = fs::metadata(&path)
            .map_err(|error| format!("Could not read install script permissions: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions)
            .map_err(|error| format!("Could not make install script executable: {error}"))?;

        let status = Command::new("open")
            .arg(&path)
            .status()
            .map_err(|error| format!("Could not open Terminal for TeX install: {error}"))?;
        if !status.success() {
            return Err("Could not open Terminal for TeX install.".into());
        }
        Ok(())
    }
}
