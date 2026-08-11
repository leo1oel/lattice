//! One-click TeX install helpers for macOS.

use serde::Serialize;
use tauri::ipc::Channel;

#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

#[cfg(target_os = "macos")]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[cfg(any(target_os = "macos", test))]
const BASIC_TEX_URL: &str =
    "https://mirror.ctan.org/systems/mac/mactex/mactex-basictex-20260301.pkg";
#[cfg(any(target_os = "macos", test))]
const BASIC_TEX_SHA256: &str = "19164fbfef08c30fd433f59203c8804abbbd685d3a344ef7f0ba8c1fd4157cb3";
#[cfg(any(target_os = "macos", test))]
const BASIC_TEX_YEAR: i32 = 2026;
#[cfg(any(target_os = "macos", test))]
const BASIC_SCRIPT: &str = r#"#!/bin/bash
set -euo pipefail
SOURCE_PACKAGE=__SOURCE_PACKAGE__
ROOT=__ROOT_PATH__
EXPECTED_SHA256=__EXPECTED_SHA256__
INSTALL_BASE=__INSTALL_BASE__
TEXBIN="/Library/TeX/texbin"
PACKAGE="${ROOT}/BasicTeX.pkg"
STATUS="${ROOT}/status"
LOG="${ROOT}/install.log"
CURRENT_STEP="Preparing the BasicTeX installation"

umask 077
if ! /bin/mkdir -m 711 "${ROOT}"; then
  echo "Could not create the privileged BasicTeX installer folder." >&2
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

if [[ ! -x "${TEXBIN}/tlmgr" ]]; then
  echo "BasicTeX installed, but ${TEXBIN}/tlmgr is missing."
  false
fi

repair_basictex_permissions
CURRENT_STEP="Updating the TeX Live package manager"
status installing-packages
"${TEXBIN}/tlmgr" update --self
# latexmk is intentionally not part of the BasicTeX base package. The
# collections and Type1 fonts cover Lattice's bundled conference templates.
CURRENT_STEP="Installing the required LaTeX packages"
"${TEXBIN}/tlmgr" install \
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
  csquotes 2>&1 | while IFS= read -r line; do
    printf '%s\n' "${line}"
    if [[ "${line}" =~ ^\[([0-9]+)/([0-9]+), ]]; then
      status "installing-packages ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
    fi
  done

if [[ -x "${TEXBIN}/updmap-sys" ]]; then
  CURRENT_STEP="Refreshing the TeX font maps"
  "${TEXBIN}/updmap-sys"
fi

CURRENT_STEP="Verifying the LaTeX installation"
status verifying
"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexInstallProgress {
    stage: String,
    progress: f64,
}

#[cfg(target_os = "macos")]
static TEX_INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
struct TexInstallGuard;

#[cfg(target_os = "macos")]
impl TexInstallGuard {
    fn acquire() -> Result<Self, String> {
        TEX_INSTALL_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "BasicTeX is already being installed in another Lattice window.".into())
    }
}

#[cfg(target_os = "macos")]
impl Drop for TexInstallGuard {
    fn drop(&mut self) {
        TEX_INSTALL_RUNNING.store(false, Ordering::Release);
    }
}

#[cfg(target_os = "macos")]
struct TexInstallWorkspace(PathBuf);

#[cfg(target_os = "macos")]
impl TexInstallWorkspace {
    fn create() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "lattice-basictex-install-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&path)
            .map_err(|error| format!("Could not create the BasicTeX installer folder: {error}"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the BasicTeX installer folder: {error}"))?;
        Ok(Self(path))
    }
}

#[cfg(target_os = "macos")]
impl Drop for TexInstallWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(target_os = "macos")]
fn send_progress(channel: &Channel<TexInstallProgress>, stage: &str, progress: f64) {
    let _ = channel.send(TexInstallProgress {
        stage: stage.to_string(),
        progress,
    });
}

#[cfg(target_os = "macos")]
fn create_private_file(path: &Path) -> Result<std::fs::File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))
}

#[cfg(target_os = "macos")]
fn download_basic_tex(
    path: &Path,
    on_progress: &Channel<TexInstallProgress>,
) -> Result<(), String> {
    send_progress(on_progress, "downloading", 0.01);
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(30 * 60))
        .user_agent(format!("Lattice/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not initialize the BasicTeX download: {error}"))?;
    let mut response = client
        .get(BASIC_TEX_URL)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download BasicTeX: {error}"))?;
    let total = response.content_length();
    let mut file = create_private_file(path)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_percent = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("The BasicTeX download was interrupted: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Could not save the BasicTeX download: {error}"))?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        if let Some(total) = total.filter(|total| *total > 0) {
            let percent = (downloaded.saturating_mul(55) / total).min(55);
            if percent > last_percent {
                last_percent = percent;
                send_progress(on_progress, "downloading", percent as f64 / 100.0);
            }
        }
    }
    file.flush()
        .map_err(|error| format!("Could not finish saving BasicTeX: {error}"))?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != BASIC_TEX_SHA256 {
        return Err("The downloaded BasicTeX package failed its security check.".into());
    }
    send_progress(on_progress, "downloading", 0.55);
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn installer_stage_progress(stage: &str) -> Option<f64> {
    let mut parts = stage.split_whitespace();
    match parts.next()? {
        "installing-base" => Some(0.68),
        "installing-packages" => {
            let completed = parts.next().and_then(|value| value.parse::<f64>().ok());
            let total = parts.next().and_then(|value| value.parse::<f64>().ok());
            match (completed, total) {
                (Some(completed), Some(total)) if total > 0.0 => {
                    Some(0.72 + (completed / total).clamp(0.0, 1.0) * 0.21)
                }
                _ => Some(0.72),
            }
        }
        "verifying" => Some(0.95),
        "complete" => Some(1.0),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", test))]
fn install_error(stderr: &str) -> String {
    if stderr.contains("User canceled") || stderr.contains("(-128)") {
        return "Administrator approval is required to install BasicTeX.".into();
    }
    let raw_detail = stderr.trim();
    let detail = raw_detail
        .split_once("execution error:")
        .map_or(raw_detail, |(_, detail)| detail)
        .trim();
    let detail = detail
        .rsplit_once(" (")
        .filter(|(_, status)| {
            status.strip_suffix(')').is_some_and(|code| {
                code.bytes()
                    .all(|byte| byte.is_ascii_digit() || byte == b'-')
            })
        })
        .map_or(detail, |(detail, _)| detail);
    let detail = detail
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    if detail.is_empty() {
        "BasicTeX installation failed. Please try again.".into()
    } else {
        format!("BasicTeX installation failed.\n{detail}")
    }
}

#[cfg(target_os = "macos")]
fn command_failure_detail(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .lines()
        .chain(String::from_utf8_lossy(&output.stdout).lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("No error detail was reported.")
        .to_string()
}

#[cfg(target_os = "macos")]
fn verify_tex_install_as_current_user() -> Result<(), String> {
    let required_tools = [
        ("latexmk", "-version"),
        ("pdflatex", "--version"),
        ("synctex", "help"),
        ("bibtex", "--version"),
        ("biber", "--version"),
        ("texcount", "-version"),
        ("kpsewhich", "--version"),
    ];
    for (tool, version_arg) in required_tools {
        let mut command = crate::commands::command(tool);
        let resolved = command.get_program().to_string_lossy().into_owned();
        let output = command.arg(version_arg).output().map_err(|error| {
            format!(
                "BasicTeX was installed, but Lattice could not run {tool} as your macOS user.\nResolved tool: {resolved}\n{error}"
            )
        })?;
        if !output.status.success() {
            return Err(format!(
                "BasicTeX was installed, but {tool} failed its user-level verification.\nResolved tool: {resolved}\n{}",
                command_failure_detail(&output)
            ));
        }
    }

    for required_file in [
        "t1ptm.fd",
        "ptmr8t.tfm",
        "t1phv.fd",
        "utmr8a.pfb",
        "utmb8a.pfb",
        "uhvr8a.pfb",
    ] {
        let output = crate::commands::command("kpsewhich")
            .arg(required_file)
            .output()
            .map_err(|error| {
                format!(
                    "BasicTeX was installed, but Lattice could not look up required file {required_file}.\n{error}"
                )
            })?;
        let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !output.status.success() || resolved.is_empty() {
            return Err(format!(
                "BasicTeX was installed, but required file {required_file} could not be found.\n{}",
                command_failure_detail(&output)
            ));
        }
        fs::File::open(&resolved).map_err(|error| {
            format!(
                "BasicTeX was installed, but Lattice could not read required file {required_file}.\nResolved file: {resolved}\n{error}"
            )
        })?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn run_basic_tex_installer(
    command: &str,
    status_path: &Path,
    on_progress: &Channel<TexInstallProgress>,
) -> Result<(), String> {
    send_progress(on_progress, "authorizing", 0.58);
    let mut child = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "do shell script (item 1 of argv) with administrator privileges",
            "-e",
            "end run",
        ])
        .arg(command)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not request permission to install BasicTeX: {error}"))?;

    let mut last_stage = String::new();
    let exit = loop {
        let status = fs::read_to_string(status_path).unwrap_or_default();
        let status = status.trim();
        if status != last_stage {
            if let Some(progress) = installer_stage_progress(status) {
                let stage = status.split_whitespace().next().unwrap_or(status);
                send_progress(on_progress, stage, progress);
            }
            last_stage = status.to_string();
        }
        if let Some(exit) = child
            .try_wait()
            .map_err(|error| format!("Could not monitor the BasicTeX installer: {error}"))?
        {
            break exit;
        }
        thread::sleep(Duration::from_millis(250));
    };

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if !exit.success() {
        return Err(install_error(&stderr));
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn tex_live_year(version_output: &str) -> Option<i32> {
    version_output
        .split_once("TeX Live")?
        .1
        .split(|character: char| !character.is_ascii_digit())
        .find(|part| part.len() == 4)
        .and_then(|year| year.parse().ok())
}

#[cfg(target_os = "macos")]
fn active_tex_live_year(tlmgr: &Path) -> Option<i32> {
    let output = Command::new(tlmgr).arg("--version").output().ok()?;
    let version = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    tex_live_year(&version)
}

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
  echo "Install BasicTeX from Lattice first."
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
  echo "Review the tlmgr output above for more details."
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

pub fn start_tex_install(on_progress: Channel<TexInstallProgress>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = on_progress;
        Err("One-click TeX install is only available on macOS.".into())
    }

    #[cfg(target_os = "macos")]
    {
        let _install_guard = TexInstallGuard::acquire()?;
        let workspace = TexInstallWorkspace::create()?;
        let package_path = workspace.0.join("BasicTeX.pkg");
        let root_path = PathBuf::from("/private/var/tmp").join(format!(
            "lattice-basictex-root-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let status_path = root_path.join("status");
        let tlmgr = Path::new("/Library/TeX/texbin/tlmgr");
        let install_base = active_tex_live_year(tlmgr).is_none_or(|year| year < BASIC_TEX_YEAR);
        if install_base {
            let current_year = chrono::Utc::now()
                .format("%Y")
                .to_string()
                .parse::<i32>()
                .unwrap_or(BASIC_TEX_YEAR);
            if current_year > BASIC_TEX_YEAR {
                return Err(format!(
                    "This Lattice version includes BasicTeX {BASIC_TEX_YEAR}. Update Lattice to install the current BasicTeX release."
                ));
            }
            download_basic_tex(&package_path, &on_progress)?;
        } else {
            send_progress(&on_progress, "downloading", 0.55);
        }

        let script = BASIC_SCRIPT
            .replace(
                "__SOURCE_PACKAGE__",
                &shell_quote(&package_path.to_string_lossy()),
            )
            .replace("__ROOT_PATH__", &shell_quote(&root_path.to_string_lossy()))
            .replace("__EXPECTED_SHA256__", BASIC_TEX_SHA256)
            .replace("__INSTALL_BASE__", if install_base { "1" } else { "0" });
        let command = format!("/bin/bash -c {}", shell_quote(&script));
        run_basic_tex_installer(&command, &status_path, &on_progress)?;
        send_progress(&on_progress, "verifying", 0.95);
        verify_tex_install_as_current_user()?;
        send_progress(&on_progress, "complete", 1.0);
        Ok(())
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
    fn basic_installer_is_pinned_and_reports_native_progress() {
        assert!(BASIC_TEX_URL.starts_with("https://mirror.ctan.org/"));
        assert_eq!(BASIC_TEX_YEAR, 2026);
        assert_eq!(BASIC_TEX_SHA256.len(), 64);
        assert!(BASIC_TEX_SHA256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert!(BASIC_SCRIPT.contains("status installing-base"));
        assert!(BASIC_SCRIPT.contains("status installing-packages"));
        assert!(BASIC_SCRIPT.contains("status verifying"));
        assert!(!BASIC_SCRIPT.contains("status complete"));
        assert!(BASIC_SCRIPT.contains("installing-packages ${BASH_REMATCH[1]}"));
        assert!(BASIC_SCRIPT.contains("shasum -a 256"));
        assert!(BASIC_SCRIPT.contains("/bin/mkdir -m 711"));
        let private_umask = BASIC_SCRIPT.find("umask 077").unwrap();
        let package_copy = BASIC_SCRIPT.find("/bin/cp").unwrap();
        let public_umask = BASIC_SCRIPT.find("umask 022").unwrap();
        let package_install = BASIC_SCRIPT.find("/usr/sbin/installer").unwrap();
        let tlmgr_update = BASIC_SCRIPT.find("\"${TEXBIN}/tlmgr\" update").unwrap();
        assert!(private_umask < package_copy);
        assert!(package_copy < public_umask);
        assert!(public_umask < package_install);
        assert!(public_umask < tlmgr_update);
        assert!(BASIC_SCRIPT.contains("EXPECTED_TEXMFROOT=\"/usr/local/texlive/2026basic\""));
        assert!(BASIC_SCRIPT.contains("[[ -L \"${EXPECTED_TEXMFROOT}\" ]]"));
        assert!(BASIC_SCRIPT.contains("owner_uid=\"$(/usr/bin/stat -f '%u'"));
        assert!(BASIC_SCRIPT.contains("/bin/chmod -R -P a+rX \"${EXPECTED_TEXMFROOT}\""));
        assert!(BASIC_SCRIPT.contains("  psnfss \\\n"));
        assert!(!BASIC_SCRIPT.contains("  mathptmx \\\n"));
        assert!(!BASIC_SCRIPT.contains("brew install"));
        assert!(!BASIC_SCRIPT.contains("sudo"));
    }

    #[test]
    fn package_install_progress_advances_with_tlmgr_output() {
        assert_eq!(installer_stage_progress("installing-packages"), Some(0.72));
        assert_eq!(
            installer_stage_progress("installing-packages 5 10"),
            Some(0.825)
        );
        assert_eq!(
            installer_stage_progress("installing-packages 10 10"),
            Some(0.9299999999999999)
        );
    }

    #[test]
    fn installer_errors_keep_the_useful_detail_without_applescript_noise() {
        let error = install_error(
            "7:75: execution error: Installing the required LaTeX packages failed.\n\
             tlmgr: package example not present in repository. (1)\n",
        );
        assert!(error.contains("package example not present in repository"));
        assert!(!error.contains("execution error"));
        assert!(!error.ends_with("(1)"));
    }

    #[test]
    fn tex_live_release_is_read_from_tlmgr_output() {
        assert_eq!(
            tex_live_year("tlmgr revision 76773 (2025-11-06 15:48:23 +0100)\nTeX Live (https://tug.org/texlive) version 2026"),
            Some(2026)
        );
        assert_eq!(tex_live_year("tlmgr is unavailable"), None);
    }

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
