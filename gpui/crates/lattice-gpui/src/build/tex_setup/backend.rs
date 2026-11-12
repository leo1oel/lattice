//! Where the TeX doctor and the installers run: lattice-core's own
//! (`doctor::run`, `tex_setup::install_tex`, `install_dependency`, the ones
//! the Tauri app's commands call), or a stand-in that touches nothing
//! outside the project, for the scenarios and tests.
//!
//! The real installers download BasicTeX and run privileged scripts behind
//! the administrator prompt (macOS) or install TeX Live per user (Windows),
//! so nothing scripted may reach them: a scenario installs [`StubTexSetup`]
//! before its first step, and the stand-in's "install" writes the missing
//! file into the project, where the next build finds it.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use gpui::{App, Global};
use lattice_core::{
    doctor::{self, DoctorCheck, DoctorReport},
    tex_setup::{
        self, TexDependencyInstall, TexInstallMode, TexInstallProgress, TexPackageUpdates,
    },
};

/// Hears an install's progress as it goes.
pub type Progress = Box<dyn Fn(TexInstallProgress) + Send + Sync>;

pub trait TexSetupBackend: Send + Sync {
    /// Which tools a build needs are present, and whether the project's own
    /// requirements are met.
    fn run_doctor(&self, root: Option<&Path>) -> DoctorReport;
    /// Install TeX (or only the required tools). `Ok(Some(warning))` is a
    /// working install whose package update failed.
    fn install_tex(
        &self,
        mode: TexInstallMode,
        progress: Progress,
    ) -> Result<Option<String>, String>;
    /// Stop the install that is running; `false` when it cannot be stopped.
    fn cancel_install(&self) -> bool;
    /// Install the TeX Live package providing `missing_file`, or name the
    /// packages to choose from when several provide it equally.
    fn install_dependency(
        &self,
        missing_file: &str,
        package: Option<&str>,
        progress: Progress,
    ) -> Result<TexDependencyInstall, String>;
    /// What the TeX Live repository has newer than what is installed;
    /// `None` without a tlmgr to ask.
    fn check_package_updates(&self) -> Option<TexPackageUpdates>;
    /// Update tlmgr and every package of the BasicTeX Lattice installed.
    fn update_packages(&self, progress: Progress) -> Result<(), String>;
}

/// lattice-core's doctor and installers, as the Tauri app runs them.
pub struct CoreTexSetup;

impl TexSetupBackend for CoreTexSetup {
    fn run_doctor(&self, root: Option<&Path>) -> DoctorReport {
        doctor::run(root)
    }

    fn install_tex(
        &self,
        mode: TexInstallMode,
        progress: Progress,
    ) -> Result<Option<String>, String> {
        let sink = move |value: TexInstallProgress| -> Result<(), lattice_core::host::Closed> {
            progress(value);
            Ok(())
        };
        tex_setup::install_tex(mode, &sink)
    }

    fn cancel_install(&self) -> bool {
        tex_setup::cancel_install()
    }

    fn install_dependency(
        &self,
        missing_file: &str,
        package: Option<&str>,
        progress: Progress,
    ) -> Result<TexDependencyInstall, String> {
        let sink = move |value: TexInstallProgress| -> Result<(), lattice_core::host::Closed> {
            progress(value);
            Ok(())
        };
        tex_setup::install_dependency(missing_file, package, &sink)
    }

    fn check_package_updates(&self) -> Option<TexPackageUpdates> {
        tex_setup::check_package_updates()
    }

    fn update_packages(&self, progress: Progress) -> Result<(), String> {
        let sink = move |value: TexInstallProgress| -> Result<(), lattice_core::host::Closed> {
            progress(value);
            Ok(())
        };
        tex_setup::update_packages(&sink)
    }
}

/// The backend every window uses.
#[derive(Clone)]
pub struct TexSetupGlobal(pub Arc<dyn TexSetupBackend>);

impl Global for TexSetupGlobal {}

pub fn backend(cx: &App) -> Arc<dyn TexSetupBackend> {
    cx.try_global::<TexSetupGlobal>().map_or_else(
        || Arc::new(CoreTexSetup) as Arc<dyn TexSetupBackend>,
        |global| global.0.clone(),
    )
}

/// A stand-in for the installers that runs no installer at all: its doctor
/// reports what it is told to, a TeX install walks the stages and succeeds,
/// and a package install first offers the packages it is told provide the
/// file (when there are several), then writes the file into `install_into`
/// with a `\ProvidesPackage` line, so a rebuild finds it.
pub struct StubTexSetup {
    state: Mutex<StubState>,
    install_into: PathBuf,
}

struct StubState {
    /// Reports to hand out, one per run; the last one repeats.
    reports: VecDeque<DoctorReport>,
    providers: Vec<String>,
    /// Every install asked of it, for a scenario to check.
    calls: Vec<String>,
}

impl StubTexSetup {
    pub fn new(install_into: PathBuf, reports: Vec<DoctorReport>, providers: Vec<String>) -> Self {
        Self {
            state: Mutex::new(StubState {
                reports: reports.into(),
                providers,
                calls: Vec::new(),
            }),
            install_into,
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, StubState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The installs asked of it so far.
    pub fn calls(&self) -> Vec<String> {
        self.state().calls.clone()
    }

    /// The reports the next doctor runs make, in order; the last repeats.
    pub fn set_reports(&self, reports: Vec<DoctorReport>) {
        self.state().reports = reports.into();
    }

    /// A report in which everything a build needs is present, except `missing`.
    pub fn report(missing: &[&str]) -> DoctorReport {
        let names = [
            "latexmk",
            "pdflatex",
            "xelatex",
            "lualatex",
            "synctex",
            "bibtex",
            "biber",
            "uv",
            "uvx",
            "conference-fonts",
        ];
        let checks: Vec<DoctorCheck> = names
            .iter()
            .map(|name| DoctorCheck {
                name: name.to_string(),
                detail: if missing.contains(name) {
                    format!("{name}: not found on PATH")
                } else {
                    format!("{name}: present")
                },
                ok: !missing.contains(name),
                code: None,
                params: Default::default(),
            })
            .collect();
        let ok = missing.is_empty();
        DoctorReport {
            ok,
            summary: format!(
                "Lattice TeX doctor\nStatus: {}",
                if ok {
                    "ready"
                } else {
                    "missing required tools"
                }
            ),
            checks,
        }
    }

    fn walk(stages: &[(&str, f64)], progress: &Progress) {
        for (stage, at) in stages {
            progress(TexInstallProgress::new(*stage, *at));
            std::thread::sleep(Duration::from_millis(60));
        }
    }
}

impl TexSetupBackend for StubTexSetup {
    fn run_doctor(&self, _: Option<&Path>) -> DoctorReport {
        let mut state = self.state();
        let report = if state.reports.len() > 1 {
            state.reports.pop_front()
        } else {
            state.reports.front().cloned()
        };
        report.unwrap_or_else(|| DoctorReport {
            ok: true,
            summary: "Lattice TeX doctor\nStatus: ready".into(),
            checks: Vec::new(),
        })
    }

    fn install_tex(
        &self,
        mode: TexInstallMode,
        progress: Progress,
    ) -> Result<Option<String>, String> {
        self.state().calls.push(format!("install_tex {mode:?}"));
        Self::walk(
            &[
                ("downloading", 0.2),
                ("authorizing", 0.55),
                ("installing-packages", 0.8),
                ("verifying", 0.98),
                ("complete", 1.0),
            ],
            &progress,
        );
        Ok(None)
    }

    fn cancel_install(&self) -> bool {
        false
    }

    fn install_dependency(
        &self,
        missing_file: &str,
        package: Option<&str>,
        progress: Progress,
    ) -> Result<TexDependencyInstall, String> {
        let providers = {
            let mut state = self.state();
            state.calls.push(format!(
                "install_dependency {missing_file} {}",
                package.unwrap_or("-")
            ));
            state.providers.clone()
        };
        Self::walk(&[("searching-packages", 0.02)], &progress);
        let chosen = package.filter(|choice| providers.iter().any(|name| name == choice));
        if providers.len() > 1 && chosen.is_none() {
            return Ok(TexDependencyInstall::ChoosePackage {
                packages: providers,
            });
        }
        Self::walk(
            &[
                ("installing-dependency", 0.5),
                ("verifying-dependency", 0.95),
            ],
            &progress,
        );
        let name = Path::new(missing_file)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let body = format!("\\ProvidesPackage{{{name}}}\n\\endinput\n");
        std::fs::write(self.install_into.join(missing_file), body).map_err(|error| {
            format!("Lattice could not write to the TeX installation folder.\n{error}")
        })?;
        progress(TexInstallProgress::new("complete", 1.0));
        Ok(TexDependencyInstall::Installed)
    }

    /// Lattice's own BasicTeX with one package out of date, until updated.
    fn check_package_updates(&self) -> Option<TexPackageUpdates> {
        let updated = self
            .state()
            .calls
            .iter()
            .any(|call| call == "update_packages");
        Some(TexPackageUpdates {
            managed: true,
            packages: if updated {
                Vec::new()
            } else {
                vec![lattice_core::tex_setup::TexPackageUpdate {
                    name: "lineno".into(),
                    installed: "5.7".into(),
                    available: "5.8".into(),
                }]
            },
            error: None,
        })
    }

    fn update_packages(&self, progress: Progress) -> Result<(), String> {
        self.state().calls.push("update_packages".into());
        Self::walk(
            &[("authorizing", 0.1), ("updating-packages", 0.6)],
            &progress,
        );
        progress(TexInstallProgress::new("complete", 1.0));
        Ok(())
    }
}
