//! Running the installers on macOS: pinned downloads, the privileged
//! installer (behind the administrator prompt), and verification as the
//! signed-in user, who is the one Lattice runs its tools as.

use super::installer::{
    basic_tex_script, dependency_install_error, dependency_script, extract_uv_archive,
    install_error, install_warning, installer_stage_progress, package_update_error,
    package_update_script, privileged_command, tex_live_package_for_file, tex_live_year,
    valid_tex_dependency_name, BASIC_TEX, BASIC_TEX_YEAR, REUSABLE_TEX_ENGINES, REUSABLE_TEX_TOOLS,
    UV, UV_ARCHIVE_ROOT,
};
use super::package_updates::{
    is_basic_tex_root, parse_update_list, update_list_failure, TexPackageUpdates, UPDATE_COMMAND,
};
use super::{TexInstallMode, TexInstallProgress};
use crate::commands;
use crate::util::{swap_in_dir, DirSwapError};
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

type Progress = Channel<TexInstallProgress>;

/// Install TeX (or only the required tools). `Ok(Some(warning))` is a working
/// install whose package update failed.
pub fn install_tex(mode: TexInstallMode, on_progress: &Progress) -> Result<Option<String>, String> {
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
        return Ok(None);
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
    let output = run_privileged_installer(&script, &root_path, on_progress, Privileged::BasicTex)?;
    let warning = install_warning(&output);
    if let Some(warning) = &warning {
        log::warn!(target: "lattice::tex-setup", "{warning}");
    }
    ensure_uv_installed(&workspace.0, on_progress, 0.94, 0.97)?;
    send_progress(on_progress, "verifying", 0.98);
    verify_tex_install_as_current_user()?;
    verify_uv_as_current_user()?;
    send_progress(on_progress, "complete", 1.0);
    Ok(warning)
}

/// How long the doctor waits for the repository's package list, across every
/// repository it tries: it answers a Settings page, offline included.
const UPDATE_LIST_TIMEOUT: Duration = Duration::from_secs(45);
const FALLBACK_REPOSITORIES: [&str; 2] = [
    "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet",
    "https://mirrors.ustc.edu.cn/CTAN/systems/texlive/tlnet",
];

/// The installed packages with updates, `None` without a tlmgr to ask.
/// Runs as the signed-in user: listing changes nothing.
pub fn check_package_updates() -> Option<TexPackageUpdates> {
    let tlmgr = commands::resolve("tlmgr");
    if !tlmgr.is_file() {
        return None;
    }
    let managed = managed_tex(&tlmgr);
    let deadline = Instant::now() + UPDATE_LIST_TIMEOUT;
    let mut failures = Vec::new();
    for repository in std::iter::once(None).chain(FALLBACK_REPOSITORIES.map(Some)) {
        let mut command = Command::new(&tlmgr);
        if let Some(repository) = repository {
            command.args(["--repository", repository]);
        }
        command.args(["update", "--list", "--machine-readable"]);
        match output_before(command, deadline) {
            Ok(output) if output.status.success() => {
                let packages = parse_update_list(&String::from_utf8_lossy(&output.stdout));
                return Some(TexPackageUpdates { managed, packages, error: None });
            }
            Ok(output) => failures.push(
                update_list_failure(&String::from_utf8_lossy(&output.stderr))
                    .unwrap_or_else(|| command_failure_detail(&output)),
            ),
            Err(error) => {
                failures.push(error);
                break;
            }
        }
    }
    failures.dedup();
    let error = Some(failures.join("\n"));
    Some(TexPackageUpdates { managed, packages: Vec::new(), error })
}

/// Whether the TeX at `tlmgr` is a BasicTeX tree, by the kpsewhich beside it.
fn managed_tex(tlmgr: &Path) -> bool {
    let Some(kpsewhich) = tlmgr.parent().map(|parent| parent.join("kpsewhich")) else {
        return false;
    };
    Command::new(kpsewhich).arg("-var-value=TEXMFROOT").output().is_ok_and(|output| {
        output.status.success() && is_basic_tex_root(&String::from_utf8_lossy(&output.stdout))
    })
}

/// `command`'s output, killing it (and whatever it started) at `deadline`.
fn output_before(mut command: Command, deadline: Instant) -> Result<Output, String> {
    commands::in_new_process_group(&mut command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run tlmgr: {error}"))?;
    // Read both pipes while waiting: a full pipe would stall tlmgr.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(child.stdout.take().map(|pipe| Box::new(pipe) as _));
    let stderr = drain(child.stderr.take().map(|pipe| Box::new(pipe) as _));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            result => {
                commands::signal_process_group(child.id(), libc::SIGKILL);
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("Could not wait for tlmgr: {error}"),
                    _ => format!(
                        "The TeX Live repository did not answer within {} seconds.",
                        UPDATE_LIST_TIMEOUT.as_secs()
                    ),
                });
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    Ok(Output { status, stdout, stderr })
}

/// Update tlmgr and every installed package of the BasicTeX Lattice manages,
/// behind the same administrator prompt as the install.
pub fn update_packages(on_progress: &Progress) -> Result<(), String> {
    let _install_guard = InstallGuard::acquire()?;
    let tlmgr = commands::resolve("tlmgr");
    if !tlmgr.is_file() {
        return Err("TeX Live's package manager is not installed.".into());
    }
    if !managed_tex(&tlmgr) {
        return Err(format!(
            "Lattice only updates the BasicTeX it installs. In Terminal: {UPDATE_COMMAND}"
        ));
    }
    let root_path = privileged_root("lattice-tex-update-root");
    let script = package_update_script(&root_path, &tlmgr);
    run_privileged_installer(&script, &root_path, on_progress, Privileged::PackageUpdate)?;
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

pub(crate) use super::fetch::download;

/// Install the managed uv pair unless it already verifies, reporting
/// progress between `progress_start` and `progress_end`.
fn ensure_uv_installed(
    workspace: &Path, on_progress: &Progress, progress_start: f64, progress_end: f64,
) -> Result<(), String> {
    if verify_uv_as_current_user().is_ok() {
        return Ok(());
    }
    if !matches!(std::env::consts::ARCH, "aarch64" | "x86_64") {
        return Err(format!(
            "Automatic uv installation is not available for this Mac architecture ({}).",
            std::env::consts::ARCH
        ));
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
    let backup = format!("lattice-backup-{}", uuid::Uuid::new_v4().simple());
    swap_in_dir(staging, destination, &backup).map_err(|failure| match failure {
        DirSwapError::Inspect(error) => {
            format!("Could not inspect the existing managed uv tools: {error}")
        }
        DirSwapError::Backup(error) => format!("Could not prepare the managed uv update: {error}"),
        DirSwapError::Activate { error, restore: None } => {
            format!("Could not activate the managed uv update: {error}")
        }
        DirSwapError::Activate { error, restore: Some(restore_error) } => format!(
            "Could not activate the managed uv update ({error}) or restore the previous tools ({restore_error})."
        ),
        DirSwapError::RemoveBackup(error) => {
            format!("uv was updated, but its old managed copy could not be removed: {error}")
        }
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
    PackageUpdate,
}

/// Run `script` as root behind the administrator prompt, relaying the stages
/// it writes to `<root>/status` as progress. Returns what the script wrote to
/// its original stdout (fd 4 in installer-prelude.sh).
fn run_privileged_installer(
    script: &str, root: &Path, on_progress: &Progress, install: Privileged<'_>,
) -> Result<String, String> {
    let (name, authorization_progress) = match install {
        Privileged::BasicTex => ("BasicTeX", 0.58),
        Privileged::Dependency(missing_file) => (missing_file, 0.2),
        Privileged::PackageUpdate => ("the TeX package update", 0.1),
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
        .stdout(Stdio::piped())
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

    // Both stay small (a warning, the failed step's diagnostic), so reading
    // them after exit cannot stall the script on a full pipe.
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if exit.success() {
        return Ok(stdout);
    }
    Err(match install {
        Privileged::BasicTex => install_error(&stderr),
        Privileged::Dependency(_) => dependency_install_error(&stderr),
        Privileged::PackageUpdate => package_update_error(&stderr),
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
