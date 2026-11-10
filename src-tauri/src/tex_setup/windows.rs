// @ratchet-files-ignore: one install flow over one Host; splitting its steps would scatter the cancel and cleanup rules they share.
//! Running the Windows installers: the pinned downloads, TeX Live's own
//! installer for the current user, the managed uv, and verification as the
//! signed-in user, who is the one Lattice runs its tools as.
//!
//! Nothing here elevates. TeX Live installs under the user's profile
//! (`install-tl -non-admin`), packages install into that tree, MiKTeX's
//! package manager runs in user mode, and uv goes into Lattice's own folder,
//! so no step can need a UAC prompt, and none is ever raised on the user's
//! behalf. A TeX Live somewhere the user cannot write is left alone and a
//! user-level one is installed beside it.
//!
//! Every external effect goes through [`Host`], so the whole flow runs in
//! tests against stand-in programs and a scratch machine (`tests.rs`).

use super::installer::{
    dependency_install_error, tex_live_year, valid_tex_dependency_name, PinnedDownload,
    REUSABLE_TEX_ENGINES, REUSABLE_TEX_TOOLS,
};
use super::package_providers::{tex_live_package_for_file, TexLiveProviders};
use super::run::{self, Ended};
use super::{
    miktex, tex_live, uv_zip, windows_pins, TexDependencyInstall, TexInstallMode,
    TexInstallProgress,
};
use crate::util::{swap_in_dir, DirSwapError};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

mod system;
#[cfg(test)]
mod tests;

/// What an install says when the user cancelled it.
pub(super) const CANCELLED: &str = "The TeX installation was cancelled.";
/// The profile file `install-tl` reads, in the folder it runs in.
const PROFILE_FILE: &str = "profile.txt";

static INSTALL_RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

/// One install at a time across every window.
struct InstallGuard;

impl InstallGuard {
    fn acquire() -> Result<Self, String> {
        INSTALL_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| {
                CANCEL.store(false, Ordering::Release);
                Self
            })
            .map_err(|_| "Required setup is already running in another Lattice window.".into())
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALL_RUNNING.store(false, Ordering::Release);
    }
}

/// End the install that is running: its processes stop and it returns
/// [`CANCELLED`]. A download in flight finishes first (they are short); the
/// installer and package manager stop at once. `false` when none is running.
pub fn cancel_install() -> bool {
    if INSTALL_RUNNING.load(Ordering::Acquire) {
        CANCEL.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

pub fn install_tex(
    mode: TexInstallMode, on_progress: &Channel<TexInstallProgress>,
) -> Result<Option<String>, String> {
    let _guard = InstallGuard::acquire()?;
    let send = |stage: &str, progress: f64| send_progress(on_progress, stage, progress);
    // Windows has no package-update step to fail, so there is never a warning.
    Flow { host: &system::SystemHost, progress: &send, cancel: &CANCEL }
        .install_tex(mode)
        .map(|()| None)
}

/// `package` is the writer's pick among several TeX Live packages that tie as
/// providers of the file; it only counts when it is one of them. A MiKTeX file
/// with several owners stays an error: MiKTeX has no ranking to fall back on.
pub fn install_dependency(
    missing_file: &str, package: Option<&str>, on_progress: &Channel<TexInstallProgress>,
) -> Result<TexDependencyInstall, String> {
    if !valid_tex_dependency_name(missing_file) {
        return Err("Invalid missing TeX dependency name.".into());
    }
    let _guard = InstallGuard::acquire()?;
    let send = |stage: &str, progress: f64| send_progress(on_progress, stage, progress);
    Flow { host: &system::SystemHost, progress: &send, cancel: &CANCEL }
        .install_dependency(missing_file, package)
}

fn send_progress(channel: &Channel<TexInstallProgress>, stage: &str, progress: f64) {
    let _ = channel.send(TexInstallProgress { stage: stage.to_string(), progress });
}

/// The machine the installer acts on: its folders, downloads and programs.
pub(super) trait Host {
    fn local_app_data(&self) -> Option<PathBuf>;
    /// The 8.3 short name of the existing folder `path` (an ASCII path even for
    /// a user whose name is not), when the volume has short names.
    fn short_path(&self, path: &Path) -> Option<PathBuf>;
    fn current_year(&self) -> i32;
    fn temp_dir(&self) -> PathBuf;
    /// Where Lattice keeps its managed `uv.exe` and `uvx.exe`.
    fn tools_dir(&self) -> Option<PathBuf>;
    fn download(
        &self, pinned: &PinnedDownload, path: &Path, cancel: &AtomicBool,
        on_bytes: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String>;
    /// `install-tl-windows.bat` with `args`, run in `cwd`.
    fn installer_command(&self, installer: &Path, args: &[String], cwd: &Path) -> Command;
    /// The program at `path`, with the search path builds get.
    fn program(&self, path: &Path) -> Command;
    /// The tool `name` the way a build would start it.
    fn tool_command(&self, name: &str) -> Command;
    /// The file `name` resolves to among Lattice's tool folders, if any.
    fn resolved_tool(&self, name: &str) -> Option<PathBuf>;
    /// The managed `uv` or `uvx` runs and reports the pinned version.
    fn uv_status(&self, name: &str) -> Result<(), String>;
    /// The same for a copy at `path` that is not yet in place.
    fn uv_status_at(&self, path: &Path, name: &str) -> Result<(), String>;
}

struct Flow<'a> {
    host: &'a dyn Host,
    progress: &'a dyn Fn(&str, f64),
    cancel: &'a AtomicBool,
}

/// A folder for downloads and unpacked installers, removed when dropped.
struct Workspace(PathBuf);

impl Workspace {
    fn create_in(parent: &Path) -> Result<Self, String> {
        let path = parent.join(format!("lattice-setup-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&path)
            .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
        Ok(Self(path))
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A TeX Live already on the machine.
struct ExistingTexLive {
    root: PathBuf,
    tlmgr: PathBuf,
    year: i32,
}

/// The TeX distribution a missing-package install talks to.
enum Distribution {
    TexLive { tlmgr: PathBuf, kpsewhich: PathBuf },
    Miktex { miktex: PathBuf, kpsewhich: PathBuf },
}

/// Why a package-manager run failed, for the caller to word.
enum Failure {
    Cancelled,
    /// The last lines it printed.
    Failed(Vec<String>),
    /// It could not be started at all.
    Start(String),
}

impl Failure {
    fn into_message(self, wording: impl FnOnce(&[String]) -> String) -> String {
        match self {
            Self::Cancelled => CANCELLED.into(),
            Self::Failed(tail) => wording(&tail),
            Self::Start(message) => message,
        }
    }
}

impl Flow<'_> {
    fn send(&self, stage: &str, progress: f64) {
        (self.progress)(stage, progress);
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }

    fn install_tex(&self, mode: TexInstallMode) -> Result<(), String> {
        match mode {
            TexInstallMode::ToolsOnly => self.install_tools_only(),
            TexInstallMode::Full => self.install_full(),
        }
    }

    fn install_tools_only(&self) -> Result<(), String> {
        let workspace = Workspace::create_in(&self.host.temp_dir())?;
        self.verify_reusable_tex().map_err(|error| {
            format!(
                "Your LaTeX setup changed before the required tools install started. Recheck setup and try again.\n{error}"
            )
        })?;
        self.ensure_uv(&workspace.0, 0.05, 0.95)?;
        self.send("verifying", 0.98);
        self.verify_reusable_tex()?;
        self.verify_uv()?;
        self.send("complete", 1.0);
        Ok(())
    }

    fn install_full(&self) -> Result<(), String> {
        let existing = self.existing_tex_live().filter(|existing| {
            existing.year >= windows_pins::TEX_LIVE_YEAR
                && is_writable(&existing.root)
                // A half-installed tree (an earlier cancel or failure) is not reused.
                && tex_live::is_finished_install(&existing.root)
        });
        let (tlmgr, fresh) = match existing {
            Some(existing) => (existing.tlmgr, false),
            None => {
                // Only a new install needs a folder, so a profile that has none
                // usable does not stop the use of a TeX Live that is there.
                let location = self.location()?;
                self.install_tex_live(&location)?;
                (tex_live::tlmgr_path(&location.texdir), true)
            }
        };
        self.install_packages(&tlmgr, !fresh)?;
        let workspace = Workspace::create_in(&self.host.temp_dir())?;
        self.ensure_uv(&workspace.0, 0.94, 0.97)?;
        self.send("verifying", 0.98);
        self.verify_tex_install()?;
        self.verify_uv()?;
        self.send("complete", 1.0);
        Ok(())
    }

    /// Where a new TeX Live goes, or why none can: see [`tex_live::install_location`].
    fn location(&self) -> Result<tex_live::Location, String> {
        tex_live::install_location(
            self.host.local_app_data().as_deref(),
            |path| self.host.short_path(path),
            windows_pins::TEX_LIVE_YEAR,
        )
    }

    /// [`Host::download`], ended with [`CANCELLED`] when the user cancelled.
    fn download(
        &self, pinned: &PinnedDownload, path: &Path, on_bytes: &mut dyn FnMut(u64, u64),
    ) -> Result<(), String> {
        self.host.download(pinned, path, self.cancel, on_bytes).map_err(|error| {
            if self.cancel.load(Ordering::Acquire) {
                CANCELLED.to_string()
            } else {
                error
            }
        })
    }

    /// The TeX Live `tlmgr` resolves to, if it runs and reports its year.
    fn existing_tex_live(&self) -> Option<ExistingTexLive> {
        let tlmgr = self.host.resolved_tool("tlmgr")?;
        let root = tex_live::root_of_bin(tlmgr.parent()?)?;
        let output =
            self.host.program(&tlmgr).arg("--version").stdin(Stdio::null()).output().ok()?;
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Some(ExistingTexLive { root, tlmgr, year: tex_live_year(&text)? })
    }

    /// Download, unpack and run TeX Live's installer for `location`; a failed
    /// or cancelled run leaves no half-installed tree behind.
    fn install_tex_live(&self, location: &tex_live::Location) -> Result<(), String> {
        if self.host.current_year() > windows_pins::TEX_LIVE_YEAR {
            return Err(format!(
                "This Lattice version includes TeX Live {}. Update Lattice to install the current TeX Live release.",
                windows_pins::TEX_LIVE_YEAR
            ));
        }
        // The installer is unpacked, checked and run from a folder of this
        // run's own inside the user's private `%LOCALAPPDATA%\Temp`, so no other
        // user can swap a file between its check and its execution; only the
        // finished tree goes to the install folder.
        fs::create_dir_all(&location.parent)
            .map_err(|error| format!("Could not create {}: {error}", location.parent.display()))?;
        let workspace = Workspace::create_in(&location.work_parent)?;
        self.send("downloading", 0.01);
        let archive = workspace.0.join("install-tl.zip");
        let mut last_percent = 0;
        self.download(&windows_pins::TEX_LIVE_INSTALLER, &archive, &mut |downloaded, total| {
            let percent = (downloaded.saturating_mul(7) / total.max(1)).min(7);
            if percent > last_percent {
                last_percent = percent;
                self.send("downloading", 0.01 + percent as f64 / 100.0);
            }
        })?;
        self.check_cancelled()?;
        self.send("downloading", 0.09);
        let installer = tex_live::extract_installer(
            &archive,
            windows_pins::TEX_LIVE_ARCHIVE_ROOT,
            &workspace.0,
        )?;
        let mut profile = super::create_private_file(&workspace.0.join(PROFILE_FILE))?;
        std::io::Write::write_all(
            &mut profile,
            tex_live::install_profile(&location.texdir, windows_pins::TEX_LIVE_YEAR).as_bytes(),
        )
        .map_err(|error| format!("Could not write the TeX Live install profile: {error}"))?;
        drop(profile);
        self.check_cancelled()?;

        let outcome = self.run_installer_with_fallbacks(&installer, &workspace.0, location);
        if outcome.is_err() {
            remove_partial_install(location);
        }
        outcome?;
        if !tex_live::tlmgr_path(&location.texdir).is_file() {
            return Err("TeX Live installed, but its package manager is missing.".into());
        }
        log::info!(
            target: "lattice::tex-setup",
            "Installed TeX Live {} in {}",
            windows_pins::TEX_LIVE_YEAR,
            location.texdir.display()
        );
        Ok(())
    }

    fn run_installer_with_fallbacks(
        &self, installer: &Path, workspace: &Path, location: &tex_live::Location,
    ) -> Result<(), String> {
        let mut failure = Vec::new();
        for repository in tex_live::REPOSITORIES {
            // A previous attempt's half-written tree would not be reused.
            remove_partial_install(location);
            let args = tex_live::installer_args(PROFILE_FILE, repository);
            let command = self.host.installer_command(installer, &args, workspace);
            let mut last = 0.0;
            let ended = run::run(command, self.cancel, |line| {
                if let Some((done, total)) = tex_live::progress_of_line(line) {
                    let progress = 0.12 + f64::from(done) / f64::from(total) * 0.56;
                    if progress > last + 0.002 {
                        last = progress;
                        self.send("installing-base", progress);
                    }
                }
            })?;
            match ended {
                Ended::Cancelled => return Err(CANCELLED.into()),
                Ended::Finished { success: true, .. } => return Ok(()),
                Ended::Finished { tail, .. } => {
                    let retry = tex_live::looks_like_network_failure(&tail);
                    failure = tail;
                    if !retry {
                        break;
                    }
                }
            }
        }
        Err(tex_live::installer_failure(&failure))
    }

    /// Install the packages Lattice needs into the TeX Live `tlmgr` manages,
    /// after updating `tlmgr` itself when `update_self` (a TeX Live that was
    /// there before is as old as it is).
    fn install_packages(&self, tlmgr: &Path, update_self: bool) -> Result<(), String> {
        self.send("installing-packages", 0.72);
        // A TeX Live installed just now was set up from an explicit https
        // mirror and says so; one that was there before keeps the repository
        // its owner configured.
        let first = (!update_self).then_some(tex_live::PRIMARY_REPOSITORY);
        if update_self {
            self.tlmgr_with_fallback(
                tlmgr,
                &["update", "--self"],
                None,
                "installing-packages",
                (0.72, 0.74),
            )
            .map_err(|failure| failure.into_message(tex_live::packages_failure))?;
        }
        let mut args = vec!["install"];
        args.extend(tex_live::REQUIRED_PACKAGES);
        self.tlmgr_with_fallback(tlmgr, &args, first, "installing-packages", (0.74, 0.93))
            .map(drop)
            .map_err(|failure| failure.into_message(tex_live::packages_failure))
    }

    /// `tlmgr <args>`, then the same against each fallback mirror while the
    /// failure looks like the network's. `first` is tried before them. Returns
    /// the repository that worked (`None` for the configured one). The
    /// command's `[done/total` lines move `stage` along through `slice` of
    /// the whole install's progress, and never beyond it.
    fn tlmgr_with_fallback(
        &self, tlmgr: &Path, args: &[&str], first: Option<&'static str>, stage: &str,
        slice: (f64, f64),
    ) -> Result<Option<&'static str>, Failure> {
        let mut candidates = vec![first];
        for repository in std::iter::once(None).chain(tex_live::FALLBACK_REPOSITORIES.map(Some)) {
            if !candidates.contains(&repository) {
                candidates.push(repository);
            }
        }
        let mut failure = Vec::new();
        for repository in candidates {
            let mut command = self.host.program(tlmgr);
            if let Some(repository) = repository {
                command.args(["--repository", repository]);
            }
            command.args(args);
            let (from, to) = slice;
            let ended = run::run(command, self.cancel, |line| {
                if let Some((done, total)) = tex_live::progress_of_line(line) {
                    self.send(stage, from + f64::from(done) / f64::from(total) * (to - from));
                }
            })
            .map_err(Failure::Start)?;
            match ended {
                Ended::Cancelled => return Err(Failure::Cancelled),
                Ended::Finished { success: true, .. } => return Ok(repository),
                Ended::Finished { tail, .. } => {
                    let retry = tex_live::looks_like_network_failure(&tail);
                    failure = tail;
                    if !retry {
                        break;
                    }
                }
            }
        }
        Err(Failure::Failed(failure))
    }

    /// Install the managed uv pair unless it already verifies, reporting
    /// progress between `start` and `end`.
    fn ensure_uv(&self, workspace: &Path, start: f64, end: f64) -> Result<(), String> {
        if self.verify_uv().is_ok() {
            return Ok(());
        }
        self.check_cancelled()?;
        let archive = workspace.join("uv.zip");
        self.send("installing-tools", start);
        let download_end = start + (end - start) * 0.8;
        let mut last_step = 0;
        self.download(&windows_pins::UV, &archive, &mut |downloaded, total| {
            let fraction = (downloaded as f64 / total.max(1) as f64).clamp(0.0, 1.0);
            let progress = start + fraction * (download_end - start);
            let step = (progress * 1_000.0) as u64;
            if step > last_step {
                last_step = step;
                self.send("installing-tools", progress);
            }
        })?;
        self.send("installing-tools", download_end);
        self.check_cancelled()?;

        let destination = self
            .host
            .tools_dir()
            .ok_or_else(|| crate::tex_setup::user_dirs::APP_SUPPORT_MISSING.to_string())?;
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
        let staging = parent.join(format!(
            ".uv-{}-lattice-install-{}",
            crate::commands::MANAGED_UV_VERSION,
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&staging)
            .map_err(|error| format!("Could not prepare the uv installer: {error}"))?;
        let installed = uv_zip::extract_uv_zip(&archive, &staging)
            .and_then(|()| {
                ["uv", "uvx"].iter().try_for_each(|name| {
                    self.host.uv_status_at(&staging.join(format!("{name}.exe")), name)
                })
            })
            .and_then(|()| activate_uv_pair(&staging, &destination));
        if installed.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        installed?;
        log::info!(
            target: "lattice::tex-setup",
            "Installed managed uv {} in {}",
            crate::commands::MANAGED_UV_VERSION,
            destination.display()
        );
        self.send("installing-tools", end);
        self.verify_uv()
    }

    fn verify_uv(&self) -> Result<(), String> {
        for tool in ["uv", "uvx"] {
            self.host.uv_status(tool).map_err(|error| {
                format!("Lattice's managed {tool} failed user-level verification.\n{error}")
            })?;
        }
        Ok(())
    }

    fn verify_tex_tool(&self, tool: &str, version_arg: &str) -> Result<(), String> {
        let mut command = self.host.tool_command(tool);
        let resolved = command.get_program().to_string_lossy().into_owned();
        let output = command.arg(version_arg).stdin(Stdio::null()).output().map_err(|error| {
            format!(
                "Lattice could not run {tool} as your Windows user.\nResolved tool: {resolved}\n{error}"
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

    fn verify_conference_fonts(&self) -> Result<(), String> {
        for required_file in crate::doctor::CONFERENCE_FONT_FILES {
            let output = self
                .host
                .tool_command("kpsewhich")
                .arg(required_file)
                .stdin(Stdio::null())
                .output()
                .map_err(|error| {
                    format!(
                        "TeX Live was installed, but Lattice could not look up required file {required_file}.\n{error}"
                    )
                })?;
            let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !output.status.success() || resolved.is_empty() {
                return Err(format!(
                    "TeX Live was installed, but required file {required_file} could not be found.\n{}",
                    command_failure_detail(&output)
                ));
            }
            fs::File::open(&resolved).map_err(|error| {
                format!(
                    "TeX Live was installed, but Lattice could not read required file {required_file}.\nResolved file: {resolved}\n{error}"
                )
            })?;
        }
        Ok(())
    }

    fn verify_reusable_tex(&self) -> Result<(), String> {
        for (tool, version_arg) in REUSABLE_TEX_TOOLS {
            self.verify_tex_tool(tool, version_arg)?;
        }
        if REUSABLE_TEX_ENGINES
            .into_iter()
            .all(|engine| self.verify_tex_tool(engine, "--version").is_err())
        {
            return Err("No supported LaTeX engine could be run as your Windows user.".into());
        }
        self.verify_conference_fonts()
    }

    fn verify_tex_install(&self) -> Result<(), String> {
        for (tool, version_arg) in [
            ("latexmk", "-version"),
            ("pdflatex", "--version"),
            ("synctex", "help"),
            ("bibtex", "--version"),
            ("biber", "--version"),
            ("texcount", "-version"),
            ("kpsewhich", "--version"),
        ] {
            self.verify_tex_tool(tool, version_arg)?;
        }
        self.verify_conference_fonts()?;
        self.verify_template_files()
    }

    /// Every package file Lattice's bundled templates and tutorial load is
    /// found by `kpsewhich`; the ones that are not are named together, so a
    /// package the install selection missed is told now and not by the first
    /// build that stops on it.
    fn verify_template_files(&self) -> Result<(), String> {
        let mut missing = Vec::new();
        for file in tex_live::TEMPLATE_FILES {
            let found = self
                .host
                .tool_command("kpsewhich")
                .arg(file)
                .stdin(Stdio::null())
                .output()
                .is_ok_and(|output| {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    output.status.success() && !path.is_empty() && fs::File::open(&path).is_ok()
                });
            if !found {
                missing.push(file);
            }
        }
        if missing.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "TeX Live was installed, but Lattice's templates need files it could not find: {}. Click Install TeX Live again, or install their packages with tlmgr.",
                missing.join(", ")
            ))
        }
    }

    fn install_dependency(
        &self, missing_file: &str, choice: Option<&str>,
    ) -> Result<TexDependencyInstall, String> {
        let Some(distribution) = self.distribution() else {
            return Err("TeX Live's package manager is not installed.".into());
        };
        let kpsewhich = match &distribution {
            Distribution::TexLive { kpsewhich, .. } | Distribution::Miktex { kpsewhich, .. } => {
                kpsewhich
            }
        };
        if self.verify_tex_dependency(kpsewhich, missing_file).is_ok() {
            self.send("complete", 1.0);
            return Ok(TexDependencyInstall::Installed);
        }
        self.send("searching-packages", 0.02);
        match &distribution {
            Distribution::TexLive { tlmgr, .. } => {
                // Nothing is installed while the writer still has to pick.
                if let Some(packages) =
                    self.install_tex_live_package(tlmgr, missing_file, choice)?
                {
                    return Ok(TexDependencyInstall::ChoosePackage { packages });
                }
            }
            Distribution::Miktex { miktex, .. } => {
                self.install_miktex_package(miktex, missing_file)?
            }
        }
        self.send("verifying-dependency", 0.95);
        self.verify_tex_dependency(kpsewhich, missing_file)?;
        self.send("complete", 1.0);
        Ok(TexDependencyInstall::Installed)
    }

    /// The distribution the `kpsewhich` a build would run belongs to.
    fn distribution(&self) -> Option<Distribution> {
        let kpsewhich = self.host.resolved_tool("kpsewhich")?;
        let bin = kpsewhich.parent()?;
        if miktex::is_miktex_bin(bin) {
            let miktex = bin.join("miktex.exe");
            return miktex.is_file().then_some(Distribution::Miktex { miktex, kpsewhich });
        }
        let tlmgr = tex_live::tlmgr_in_bin(bin);
        tlmgr.is_file().then_some(Distribution::TexLive { tlmgr, kpsewhich })
    }

    /// Install the package providing `missing_file`; `Ok(Some(packages))` when
    /// several tie and `choice` is not one of them, with nothing installed.
    fn install_tex_live_package(
        &self, tlmgr: &Path, missing_file: &str, choice: Option<&str>,
    ) -> Result<Option<Vec<String>>, String> {
        let (providers, repository) = self.find_tex_live_package(tlmgr, missing_file)?;
        let package = match providers {
            TexLiveProviders::One(package) => package,
            TexLiveProviders::Several(packages) => {
                match choice.filter(|pick| packages.iter().any(|package| package == pick)) {
                    Some(pick) => pick.to_string(),
                    None => return Ok(Some(packages)),
                }
            }
        };
        self.send("installing-dependency", 0.2);
        // While the repository holds a newer tlmgr, tlmgr refuses every
        // install until it updates itself; when it is current this changes
        // nothing.
        let failure_message = |failure: Failure| {
            failure.into_message(|tail| dependency_install_error(&tail.join("\n")))
        };
        let repository = self
            .tlmgr_with_fallback(
                tlmgr,
                &["update", "--self"],
                repository,
                "installing-dependency",
                (0.2, 0.3),
            )
            .map_err(failure_message)?;
        self.tlmgr_with_fallback(
            tlmgr,
            &["install", &package],
            repository,
            "installing-dependency",
            (0.3, 0.9),
        )
        .map(drop)
        .map_err(failure_message)?;
        Ok(None)
    }

    /// The package providing `missing_file`, and the fallback repository it
    /// was found in (`None` for the one the user configured).
    fn find_tex_live_package(
        &self, tlmgr: &Path, missing_file: &str,
    ) -> Result<(TexLiveProviders, Option<&'static str>), String> {
        let search_pattern = format!("/{}$", regex::escape(missing_file));
        let mut failures = Vec::new();
        for repository in std::iter::once(None).chain(tex_live::FALLBACK_REPOSITORIES.map(Some)) {
            self.check_cancelled()?;
            let mut command = self.host.program(tlmgr);
            if let Some(repository) = repository {
                command.args(["--repository", repository]);
            }
            let output = command
                .args(["search", "--global", "--file", &search_pattern])
                .stdin(Stdio::null())
                .output()
                .map_err(|error| format!("Could not search the TeX Live repository: {error}"))?;
            if output.status.success() {
                let search_output = String::from_utf8_lossy(&output.stdout);
                return tex_live_package_for_file(&search_output, missing_file)
                    .map(|providers| (providers, repository));
            }
            failures.push(command_failure_detail(&output));
        }
        failures.dedup();
        Err(format!("The TeX Live repository could not be searched.\n{}", failures.join("\n")))
    }

    fn install_miktex_package(&self, miktex_exe: &Path, missing_file: &str) -> Result<(), String> {
        let listing = self
            .host
            .program(miktex_exe)
            .args(miktex::list_args())
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Could not search the MiKTeX packages: {error}"))?;
        if !listing.status.success() {
            return Err(format!(
                "The MiKTeX packages could not be searched.\n{}",
                command_failure_detail(&listing)
            ));
        }
        let package =
            miktex::package_for_file(&String::from_utf8_lossy(&listing.stdout), missing_file)?;
        self.check_cancelled()?;
        self.send("installing-dependency", 0.42);
        let mut command = self.host.program(miktex_exe);
        command.args(miktex::install_args(&package));
        let mut steps = 0_u32;
        let ended = run::run(command, self.cancel, |_| {
            // MiKTeX names each step it takes, with no count to follow.
            steps += 1;
            self.send(
                "installing-dependency",
                0.42 + 0.48 * (1.0 - 1.0 / (1.0 + f64::from(steps) / 6.0)),
            );
        })?;
        match ended {
            Ended::Cancelled => Err(CANCELLED.into()),
            Ended::Finished { success: true, .. } => Ok(()),
            Ended::Finished { tail, .. } => Err(miktex::install_failure(&tail.join("\n"))),
        }
    }

    fn verify_tex_dependency(&self, kpsewhich: &Path, missing_file: &str) -> Result<(), String> {
        let output = self
            .host
            .program(kpsewhich)
            .arg(missing_file)
            .stdin(Stdio::null())
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

/// Whether the current user can add files under the TeX Live `root` (a system
/// install usually refuses them without administrator rights).
fn is_writable(root: &Path) -> bool {
    let probe =
        root.join("tlpkg").join(format!(".lattice-write-{}", uuid::Uuid::new_v4().simple()));
    fs::File::create(&probe).is_ok_and(|_| fs::remove_file(&probe).is_ok())
}

/// Delete the TeX Live tree a failed or cancelled install started at
/// `location`, unless it is a finished install (`tlpkg/texlive.profile` is
/// there: having `tlmgr.bat` is not enough, see [`tex_live::is_finished_install`])
/// or the path is not the one this installer makes (`…\texlive\<year>`, not a
/// link).
fn remove_partial_install(location: &tex_live::Location) {
    let texdir = &location.texdir;
    let ours = texdir
        .file_name()
        .is_some_and(|name| name.to_string_lossy() == windows_pins::TEX_LIVE_YEAR.to_string())
        && texdir.parent() == Some(location.parent.as_path())
        && location.parent.file_name().is_some_and(|name| name == "texlive");
    let Ok(metadata) = fs::symlink_metadata(texdir) else { return };
    if ours
        && metadata.is_dir()
        && !metadata.file_type().is_symlink()
        && !tex_live::is_finished_install(texdir)
    {
        let _ = fs::remove_dir_all(texdir);
    }
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
