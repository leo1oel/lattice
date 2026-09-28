//! Running the installers on macOS: pinned downloads, the privileged
//! installer (behind the administrator prompt), and verification as the
//! signed-in user, who is the one Lattice runs its tools as.

use super::installer::{
    basic_tex_script, create_private_file, dependency_install_error, dependency_script,
    extract_uv_archive, install_error, installer_stage_progress, privileged_command,
    tex_live_package_for_file, tex_live_year, valid_tex_dependency_name, PinnedDownload, BASIC_TEX,
    BASIC_TEX_YEAR, REUSABLE_TEX_ENGINES, REUSABLE_TEX_TOOLS, UV, UV_ARCHIVE_ROOT,
};
use super::{TexInstallMode, TexInstallProgress};
use crate::commands;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;

type Progress = Channel<TexInstallProgress>;

pub fn install_tex(mode: TexInstallMode, on_progress: &Progress) -> Result<(), String> {
    let _install_guard = InstallGuard::acquire()?;
    let workspace = Workspace::create()?;
    if mode == TexInstallMode::ToolsOnly {
        verify_reusable_tex_as_current_user().map_err(|error| {
            format!(
                "Your LaTeX setup changed before the required tools install started. Recheck setup and try again.\n{error}"
            )
        })?;
        ensure_uv_installed(&workspace.0, on_progress, 0.05, 0.95)?;
        send_progress(on_progress, "verifying", 0.98);
        verify_reusable_tex_as_current_user()?;
        verify_uv_as_current_user()?;
        send_progress(on_progress, "complete", 1.0);
        return Ok(());
    }

    let package_path = workspace.0.join("BasicTeX.pkg");
    let root_path = privileged_root("lattice-basictex-root");
    let tlmgr = Path::new("/Library/TeX/texbin/tlmgr");
    let install_base = active_tex_live_year(tlmgr).is_none_or(|year| year < BASIC_TEX_YEAR);
    if install_base {
        let current_year =
            chrono::Utc::now().format("%Y").to_string().parse::<i32>().unwrap_or(BASIC_TEX_YEAR);
        if current_year > BASIC_TEX_YEAR {
            return Err(format!(
                "This Lattice version includes BasicTeX {BASIC_TEX_YEAR}. Update Lattice to install the current BasicTeX release."
            ));
        }
        send_progress(on_progress, "downloading", 0.01);
        let mut last_percent = 0;
        download(&BASIC_TEX, &package_path, |downloaded, total| {
            let percent = (downloaded.saturating_mul(55) / total).min(55);
            if percent > last_percent {
                last_percent = percent;
                send_progress(on_progress, "downloading", percent as f64 / 100.0);
            }
        })?;
    }
    send_progress(on_progress, "downloading", 0.55);

    let script = basic_tex_script(&package_path, &root_path, install_base);
    run_privileged_installer(&script, &root_path, on_progress, Privileged::BasicTex)?;
    ensure_uv_installed(&workspace.0, on_progress, 0.94, 0.97)?;
    send_progress(on_progress, "verifying", 0.98);
    verify_tex_install_as_current_user()?;
    verify_uv_as_current_user()?;
    send_progress(on_progress, "complete", 1.0);
    Ok(())
}

pub fn install_dependency(missing_file: &str, on_progress: &Progress) -> Result<(), String> {
    if !valid_tex_dependency_name(missing_file) {
        return Err("Invalid missing TeX dependency name.".into());
    }
    let _install_guard = InstallGuard::acquire()?;
    let tlmgr = commands::resolve("tlmgr");
    if !tlmgr.is_file() {
        return Err("TeX Live's package manager is not installed.".into());
    }
    let kpsewhich = tlmgr
        .parent()
        .map(|parent| parent.join("kpsewhich"))
        .filter(|path| path.is_file())
        .ok_or_else(|| "kpsewhich was not found beside tlmgr.".to_string())?;
    if verify_tex_dependency(&kpsewhich, missing_file).is_ok() {
        send_progress(on_progress, "complete", 1.0);
        return Ok(());
    }

    send_progress(on_progress, "searching-packages", 0.02);
    let (package, repository) = find_tex_live_package(&tlmgr, missing_file)?;
    let root_path = privileged_root("lattice-tex-dependency-root");
    let script = dependency_script(&root_path, &tlmgr, &package, repository);
    run_privileged_installer(
        &script,
        &root_path,
        on_progress,
        Privileged::Dependency(missing_file),
    )?;
    send_progress(on_progress, "verifying-dependency", 0.95);
    verify_tex_dependency(&kpsewhich, missing_file)?;
    send_progress(on_progress, "complete", 1.0);
    Ok(())
}

fn send_progress(channel: &Progress, stage: &str, progress: f64) {
    let _ = channel.send(TexInstallProgress { stage: stage.to_string(), progress });
}

static INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);

/// One install at a time across every window.
struct InstallGuard;

impl InstallGuard {
    fn acquire() -> Result<Self, String> {
        INSTALL_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "Required setup is already running in another Lattice window.".into())
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALL_RUNNING.store(false, Ordering::Release);
    }
}

/// A private folder for downloads, removed when the install ends.
struct Workspace(PathBuf);

impl Workspace {
    fn create() -> Result<Self, String> {
        let path = std::env::temp_dir()
            .join(format!("lattice-basictex-install-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir(&path)
            .map_err(|error| format!("Could not create the BasicTeX installer folder: {error}"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the BasicTeX installer folder: {error}"))?;
        Ok(Self(path))
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Where a privileged script keeps its root-owned working folder, which the
/// script itself creates (and refuses to reuse).
fn privileged_root(prefix: &str) -> PathBuf {
    PathBuf::from("/private/var/tmp").join(format!("{prefix}-{}", uuid::Uuid::new_v4().simple()))
}

/// Stream `pinned` into a new private file at `path`, checking its SHA-256.
/// `on_bytes(downloaded, total)` follows along when the size is known.
fn download(
    pinned: &PinnedDownload, path: &Path, mut on_bytes: impl FnMut(u64, u64),
) -> Result<(), String> {
    let name = pinned.name;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(pinned.timeout)
        .user_agent(format!("Lattice/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not initialize the {name} download: {error}"))?;
    let mut response = client
        .get(pinned.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| format!("Could not download {}: {error}", pinned.source))?;
    let total = response.content_length().filter(|total| *total > 0);
    let mut file = create_private_file(path)?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("The {name} download was interrupted: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Could not save the {name} download: {error}"))?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        if let Some(total) = total {
            on_bytes(downloaded, total);
        }
    }
    file.flush().map_err(|error| format!("Could not finish saving {name}: {error}"))?;
    if format!("{:x}", hasher.finalize()) != pinned.sha256 {
        return Err(format!("The downloaded {} failed its security check.", pinned.artifact));
    }
    Ok(())
}

/// Install the managed uv pair unless it already verifies, reporting
/// progress between `progress_start` and `progress_end`.
fn ensure_uv_installed(
    workspace: &Path, on_progress: &Progress, progress_start: f64, progress_end: f64,
) -> Result<(), String> {
    if verify_uv_as_current_user().is_ok() {
        return Ok(());
    }
    let archive = workspace.join("uv.tar.gz");
    send_progress(on_progress, "installing-tools", progress_start);
    let download_end = progress_start + (progress_end - progress_start) * 0.8;
    let mut last_step = 0;
    download(&UV, &archive, |downloaded, total| {
        let fraction = (downloaded as f64 / total as f64).clamp(0.0, 1.0);
        let progress = progress_start + fraction * (download_end - progress_start);
        let step = (progress * 1_000.0) as u64;
        if step > last_step {
            last_step = step;
            send_progress(on_progress, "installing-tools", progress);
        }
    })?;
    send_progress(on_progress, "installing-tools", download_end);

    let destination = commands::managed_tools_dir()
        .ok_or_else(|| "Could not locate your macOS Application Support folder.".to_string())?;
    let parent = destination
        .parent()
        .ok_or_else(|| "The managed uv tools folder has no parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let parent_metadata = fs::symlink_metadata(parent)
        .map_err(|error| format!("Could not inspect {}: {error}", parent.display()))?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err(format!(
            "Refusing to install uv into an invalid managed tools folder: {}",
            parent.display()
        ));
    }
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|error| {
        format!("Could not secure the managed tools folder {}: {error}", parent.display())
    })?;

    let staging = parent.join(format!(
        ".uv-{}-lattice-install-{}",
        commands::MANAGED_UV_VERSION,
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&staging)
        .map_err(|error| format!("Could not prepare the uv installer: {error}"))?;
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure the uv installer: {error}"))?;
    let installed = extract_uv_archive(&archive, &staging, UV_ARCHIVE_ROOT)
        .and_then(|()| {
            ["uv", "uvx"]
                .iter()
                .try_for_each(|name| commands::uv_tool_status_at(&staging.join(name), name))
        })
        .and_then(|()| activate_uv_pair(&staging, &destination));
    if installed.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    installed?;
    log::info!(
        target: "lattice::tex-setup",
        "Installed managed uv {} in {}",
        commands::MANAGED_UV_VERSION,
        destination.display()
    );
    send_progress(on_progress, "installing-tools", progress_end);
    verify_uv_as_current_user()
}

/// Move the verified `staging` pair into place, keeping the previous pair
/// until the new one is in.
fn activate_uv_pair(staging: &Path, destination: &Path) -> Result<(), String> {
    match fs::symlink_metadata(destination) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return fs::rename(staging, destination)
                .map_err(|error| format!("Could not activate the managed uv tools: {error}"));
        }
        Err(error) => {
            return Err(format!("Could not inspect the existing managed uv tools: {error}"));
        }
        Ok(_) => {}
    }

    let backup =
        destination.with_extension(format!("lattice-backup-{}", uuid::Uuid::new_v4().simple()));
    fs::rename(destination, &backup)
        .map_err(|error| format!("Could not prepare the managed uv update: {error}"))?;
    if let Err(error) = fs::rename(staging, destination) {
        return match fs::rename(&backup, destination) {
            Ok(()) => Err(format!("Could not activate the managed uv update: {error}")),
            Err(restore_error) => Err(format!(
                "Could not activate the managed uv update ({error}) or restore the previous tools ({restore_error})."
            )),
        };
    }
    fs::remove_dir_all(&backup).map_err(|error| {
        format!("uv was updated, but its old managed copy could not be removed: {error}")
    })
}

/// The first line a failed tool printed, stderr first.
fn command_failure_detail(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .lines()
        .chain(String::from_utf8_lossy(&output.stdout).lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("No error detail was reported.")
        .to_string()
}

fn verify_uv_as_current_user() -> Result<(), String> {
    for tool in ["uv", "uvx"] {
        commands::managed_uv_tool_status(tool).map_err(|error| {
            format!("Lattice's managed {tool} failed user-level verification.\n{error}")
        })?;
    }
    Ok(())
}

fn verify_tex_tool_as_current_user(tool: &str, version_arg: &str) -> Result<(), String> {
    let mut command = commands::command(tool);
    let resolved = command.get_program().to_string_lossy().into_owned();
    let output = command.arg(version_arg).output().map_err(|error| {
        format!(
            "Lattice could not run {tool} as your macOS user.\nResolved tool: {resolved}\n{error}"
        )
    })?;
    if !output.status.success() {
        return Err(format!(
            "{tool} failed its user-level verification.\nResolved tool: {resolved}\n{}",
            command_failure_detail(&output)
        ));
    }
    Ok(())
}

fn verify_conference_fonts_as_current_user() -> Result<(), String> {
    for required_file in crate::doctor::CONFERENCE_FONT_FILES {
        let output = commands::command("kpsewhich").arg(required_file).output().map_err(|error| {
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

fn verify_reusable_tex_as_current_user() -> Result<(), String> {
    for (tool, version_arg) in REUSABLE_TEX_TOOLS {
        verify_tex_tool_as_current_user(tool, version_arg)?;
    }
    if REUSABLE_TEX_ENGINES
        .into_iter()
        .all(|engine| verify_tex_tool_as_current_user(engine, "--version").is_err())
    {
        return Err("No supported LaTeX engine could be run as your macOS user.".into());
    }
    verify_conference_fonts_as_current_user()
}

fn verify_tex_install_as_current_user() -> Result<(), String> {
    for (tool, version_arg) in [
        ("latexmk", "-version"),
        ("pdflatex", "--version"),
        ("synctex", "help"),
        ("bibtex", "--version"),
        ("biber", "--version"),
        ("texcount", "-version"),
        ("kpsewhich", "--version"),
    ] {
        verify_tex_tool_as_current_user(tool, version_arg)?;
    }
    verify_conference_fonts_as_current_user()
}

#[derive(Clone, Copy)]
enum Privileged<'a> {
    BasicTex,
    /// The package for this missing file.
    Dependency(&'a str),
}

/// Run `script` as root behind the administrator prompt, relaying the stages
/// it writes to `<root>/status` as progress.
fn run_privileged_installer(
    script: &str, root: &Path, on_progress: &Progress, install: Privileged<'_>,
) -> Result<(), String> {
    let (name, authorization_progress) = match install {
        Privileged::BasicTex => ("BasicTeX", 0.58),
        Privileged::Dependency(missing_file) => (missing_file, 0.2),
    };
    send_progress(on_progress, "authorizing", authorization_progress);
    let mut child = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "do shell script (item 1 of argv) with administrator privileges",
            "-e",
            "end run",
        ])
        .arg(privileged_command(script))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not request permission to install {name}: {error}"))?;

    let status_path = root.join("status");
    let mut last_stage = String::new();
    let exit = loop {
        let status = fs::read_to_string(&status_path).unwrap_or_default();
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
            .map_err(|error| format!("Could not monitor the {name} installer: {error}"))?
        {
            break exit;
        }
        thread::sleep(Duration::from_millis(250));
    };

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if exit.success() {
        return Ok(());
    }
    Err(match install {
        Privileged::BasicTex => install_error(&stderr),
        Privileged::Dependency(missing_file) => dependency_install_error(&stderr, missing_file),
    })
}

fn active_tex_live_year(tlmgr: &Path) -> Option<i32> {
    let output = Command::new(tlmgr).arg("--version").output().ok()?;
    let version = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    tex_live_year(&version)
}

/// The package providing `missing_file`, and the fallback repository it was
/// found in (`None` for the one the user configured).
fn find_tex_live_package(
    tlmgr: &Path, missing_file: &str,
) -> Result<(String, Option<&'static str>), String> {
    const FALLBACK_REPOSITORIES: [&str; 2] = [
        "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet",
        "https://mirrors.ustc.edu.cn/CTAN/systems/texlive/tlnet",
    ];
    let search_pattern = format!("/{}$", regex::escape(missing_file));
    let mut failures = Vec::new();
    for repository in std::iter::once(None).chain(FALLBACK_REPOSITORIES.map(Some)) {
        let mut command = Command::new(tlmgr);
        if let Some(repository) = repository {
            command.args(["--repository", repository]);
        }
        let output = command
            .args(["search", "--global", "--file", &search_pattern])
            .output()
            .map_err(|error| format!("Could not search the TeX Live repository: {error}"))?;
        if output.status.success() {
            let search_output = String::from_utf8_lossy(&output.stdout);
            return tex_live_package_for_file(&search_output, missing_file)
                .map(|package| (package, repository));
        }
        failures.push(command_failure_detail(&output));
    }
    failures.dedup();
    Err(format!("The TeX Live repository could not be searched.\n{}", failures.join("\n")))
}

fn verify_tex_dependency(kpsewhich: &Path, missing_file: &str) -> Result<(), String> {
    let output = Command::new(kpsewhich)
        .arg(missing_file)
        .output()
        .map_err(|error| format!("Could not verify {missing_file}: {error}"))?;
    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || resolved.is_empty() {
        return Err(format!(
            "The package installation finished, but {missing_file} is still unavailable.\n{}",
            command_failure_detail(&output)
        ));
    }
    fs::File::open(&resolved).map(drop).map_err(|error| {
        format!(
            "The package installation finished, but Lattice could not read {missing_file}.\nResolved file: {resolved}\n{error}"
        )
    })
}
