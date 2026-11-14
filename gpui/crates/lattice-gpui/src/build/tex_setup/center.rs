//! The TeX toolchain check (the doctor), the setup wizard and the installs
//! of single packages a build reported missing, as the Tauri app's
//! `useTexSetup` runs them (`src/app/use-tex-setup.ts`).
//!
//! The doctor runs once a few seconds after launch and only reads: no
//! dialog lands on a window just opened. The wizard opens when asked for
//! (the palette's "Install LaTeX tools", the TeX doctor), and when a build
//! cannot start for missing TeX. Missing TeX or conference fonts hold the
//! window in it: nothing compiles without them. Missing paper tools alone
//! can be put off with "Install later".
//!
//! One center per app ([`install`]), drawn by each window's shell.

use std::{path::PathBuf, sync::Arc, time::Duration};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Global, Task};
use lattice_core::{
    doctor::DoctorReport,
    tex_setup::{TexDependencyInstall, TexInstallMode, TexInstallProgress},
};
use lattice_ui::components::ToastLevel;

use super::{
    TEX_INSTALL_CANCELLED,
    backend::{self, TexSetupBackend},
    conference_fonts_missing, dependency_install_failure, distribution_name, missing_paper_tools,
    missing_tex_tools, only_paper_tools_missing,
    package_updates::{PackageUpdates, UpdateRun},
    required_setup_missing,
};
use lattice_i18n::t;

use crate::notices::{self, Notice};

/// How long after launch the doctor first looks, so it never competes with
/// the first paint and the project's open.
const LAUNCH_CHECK_DELAY: Duration = Duration::from_secs(4);

/// Toasts from setup carry this source, as the Tauri app's do.
const SOURCE: &str = "LaTeX setup";

#[derive(Clone, Debug, PartialEq)]
pub struct InstallProgress {
    pub stage: String,
    pub progress: f64,
}

impl From<TexInstallProgress> for InstallProgress {
    fn from(progress: TexInstallProgress) -> Self {
        Self {
            stage: progress.stage().to_string(),
            progress: progress.progress(),
        }
    }
}

impl InstallProgress {
    fn at(stage: &str) -> Self {
        Self {
            stage: stage.into(),
            progress: 0.,
        }
    }

    /// The bar's percentage, clamped.
    pub fn percent(&self) -> u32 {
        (self.progress.clamp(0., 1.) * 100.).round() as u32
    }
}

/// A missing package's install, while its dialog is up.
#[derive(Clone, Debug)]
pub struct DependencyInstall {
    pub missing_file: String,
    pub progress: InstallProgress,
    pub installing: bool,
    pub error: Option<String>,
    /// Several TeX Live packages provide the file equally well: the writer
    /// picks one.
    pub packages: Option<Vec<String>>,
}

/// The wizard's own install, while it runs or after it failed.
#[derive(Clone, Debug, Default)]
pub struct WizardInstall {
    pub installing: bool,
    pub progress: Option<InstallProgress>,
    pub error: Option<String>,
}

pub enum TexSetupEvent {
    /// A package a build was missing is installed: build again.
    Rebuild,
}

pub struct TexSetupCenter {
    /// The project the doctor checks besides the tools.
    root: Option<PathBuf>,
    report: Option<DoctorReport>,
    busy: bool,
    generation: u64,
    pub(super) wizard_open: bool,
    /// The wizard is open because a paper feature failed without the tools.
    pub(super) paper_tools_needed: bool,
    pub(super) wizard: WizardInstall,
    pub(super) dependency: Option<DependencyInstall>,
    dependency_attempt: u64,
    pub(super) doctor_open: bool,
    /// Whether a failed install's own words are unfolded under its summary.
    pub(super) details_open: bool,
    /// The doctor's package-update check and the update.
    pub(super) packages: PackageUpdates,
    /// Bumped per dialog opened, so each one enters afresh.
    pub(super) serial: usize,
    _launch_check: Option<Task<()>>,
    _install: Option<Task<()>>,
}

impl EventEmitter<TexSetupEvent> for TexSetupCenter {}

struct TexSetupCenterGlobal(Entity<TexSetupCenter>);

impl Global for TexSetupCenterGlobal {}

/// The center, once a shell has made it.
pub fn center(cx: &App) -> Option<Entity<TexSetupCenter>> {
    cx.try_global::<TexSetupCenterGlobal>()
        .map(|global| global.0.clone())
}

/// The center every window's shell draws; made on first use.
pub fn install(cx: &mut App) -> Entity<TexSetupCenter> {
    if let Some(center) = cx.try_global::<TexSetupCenterGlobal>() {
        return center.0.clone();
    }
    let center = cx.new(|_| TexSetupCenter {
        root: None,
        report: None,
        busy: false,
        generation: 0,
        wizard_open: false,
        paper_tools_needed: false,
        wizard: WizardInstall::default(),
        dependency: None,
        dependency_attempt: 0,
        doctor_open: false,
        details_open: false,
        packages: PackageUpdates::default(),
        serial: 0,
        _launch_check: None,
        _install: None,
    });
    cx.set_global(TexSetupCenterGlobal(center.clone()));
    center
}

impl TexSetupCenter {
    fn backend(cx: &App) -> Arc<dyn TexSetupBackend> {
        backend::backend(cx)
    }

    /// Whether a setup dialog or the TeX doctor is up.
    pub fn dialog_open(&self) -> bool {
        self.wizard_open || self.doctor_open || self.dependency.is_some()
    }

    pub fn packages(&self) -> &PackageUpdates {
        &self.packages
    }

    pub fn report(&self) -> Option<&DoctorReport> {
        self.report.as_ref()
    }

    pub fn busy(&self) -> bool {
        self.busy
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn wizard_open(&self) -> bool {
        self.wizard_open
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn doctor_open(&self) -> bool {
        self.doctor_open
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn dependency(&self) -> Option<&DependencyInstall> {
        self.dependency.as_ref()
    }

    /// The project the doctor checks; `None` once it closes.
    pub fn set_root(&mut self, root: Option<PathBuf>) {
        self.root = root;
    }

    /// The launch check: once, a few seconds in, reading only.
    pub fn check_at_launch(&mut self, cx: &mut Context<Self>) {
        if self._launch_check.is_some() {
            return;
        }
        self._launch_check = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(LAUNCH_CHECK_DELAY).await;
            let Ok(task) = this.update(cx, |this, cx| this.run_doctor(false, cx)) else {
                return;
            };
            task.await;
        }));
    }

    /// Run the doctor; the report it makes, unless a newer run superseded
    /// it. `open_wizard_if_missing` opens setup when a required tool is.
    pub fn run_doctor(
        &mut self,
        open_wizard_if_missing: bool,
        cx: &mut Context<Self>,
    ) -> Task<Option<DoctorReport>> {
        self.generation += 1;
        let generation = self.generation;
        self.busy = true;
        cx.notify();
        let backend = Self::backend(cx);
        let root = self.root.clone();
        cx.spawn(async move |this, cx| {
            let report = cx
                .background_spawn(async move { backend.run_doctor(root.as_deref()) })
                .await;
            this.update(cx, |this, cx| {
                if generation != this.generation {
                    return None;
                }
                this.busy = false;
                let missing = required_setup_missing(Some(&report));
                if open_wizard_if_missing && missing {
                    this.open_wizard_now(cx);
                }
                // Setup that is complete has nothing left to offer: the
                // wizard closes once a check finds everything.
                if !missing && this.wizard_open && !this.wizard.installing {
                    this.wizard_open = false;
                    this.paper_tools_needed = false;
                    this.wizard = WizardInstall::default();
                }
                this.report = Some(report.clone());
                cx.notify();
                Some(report)
            })
            .ok()
            .flatten()
        })
    }

    fn open_wizard_now(&mut self, cx: &mut Context<Self>) {
        if !self.wizard_open {
            self.serial += 1;
        }
        self.wizard_open = true;
        cx.notify();
    }

    /// Asked for by name (the palette, the doctor), so it always looks
    /// again, tools may have arrived since the last check, and always
    /// answers: the wizard when something is missing, a toast when nothing
    /// is. A report that already knows something is missing opens the
    /// wizard at once and rechecks under it.
    pub fn open_wizard(&mut self, cx: &mut Context<Self>) {
        if required_setup_missing(self.report.as_ref()) {
            self.open_wizard_now(cx);
        }
        let check = self.run_doctor(true, cx);
        cx.spawn(async move |_, cx| {
            if let Some(report) = check.await
                && !required_setup_missing(Some(&report))
            {
                cx.update(|cx| {
                    notices::show(
                        Notice::new(ToastLevel::Success, t!("LaTeX is ready to build"))
                            .detail(t!("Every tool Lattice needs is installed")),
                        cx,
                    )
                });
            }
        })
        .detach();
    }

    /// A build found no TeX toolchain: drop the stale report and show setup.
    pub fn open_for_missing_tex(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self.report = None;
        self.busy = false;
        self.open_wizard_now(cx);
    }

    /// [`Self::open_for_missing_tex`] while Get started is on screen: its
    /// first step reports the missing TeX, from a fresh check, and offers
    /// the install, so no dialog lands on the checklist.
    pub fn recheck_for_missing_tex(&mut self, cx: &mut Context<Self>) {
        self.report = None;
        self.run_doctor(false, cx).detach();
    }

    pub fn close_wizard(&mut self, cx: &mut Context<Self>) {
        if self.wizard.installing {
            return;
        }
        self.wizard_open = false;
        self.paper_tools_needed = false;
        self.wizard = WizardInstall::default();
        cx.notify();
    }

    /// The doctor's report as the Settings pane shows it, in a sheet of its
    /// own until the GPUI app has Settings; opening it checks again.
    pub fn open_doctor(&mut self, cx: &mut Context<Self>) {
        if !self.doctor_open {
            self.serial += 1;
        }
        self.doctor_open = true;
        self.run_doctor(false, cx).detach();
        // The repository may have news since the last look.
        self.check_package_updates(false, cx);
    }

    /// Ask the repository what it has newer. Never while an update runs: it
    /// would only see the packages before it. `after_update` keeps the
    /// update's result on show.
    pub fn check_package_updates(&mut self, after_update: bool, cx: &mut Context<Self>) {
        if self.packages.run.as_ref().is_some_and(|run| run.running) {
            return;
        }
        self.packages.generation += 1;
        let generation = self.packages.generation;
        self.packages.checking = true;
        cx.notify();
        let backend = Self::backend(cx);
        cx.spawn(async move |this, cx| {
            let report = cx
                .background_spawn(async move { backend.check_package_updates() })
                .await;
            this.update(cx, |this, cx| {
                if generation != this.packages.generation {
                    return;
                }
                this.packages.report = report;
                this.packages.checking = false;
                if !after_update {
                    this.packages.run = None;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The one-click update of Lattice's BasicTeX, behind the
    /// administrator prompt; it checks again once it is done.
    pub fn update_packages(&mut self, cx: &mut Context<Self>) {
        if self.packages.run.as_ref().is_some_and(|run| run.running) {
            return;
        }
        // A check still running answers for the packages before the update.
        self.packages.generation += 1;
        self.packages.checking = false;
        self.packages.run = Some(UpdateRun {
            progress: InstallProgress::at("authorizing"),
            running: true,
            error: None,
        });
        cx.notify();
        let backend = Self::backend(cx);
        let (sender, mut received) = mpsc::unbounded::<TexInstallProgress>();
        cx.spawn(async move |this, cx| {
            let update = cx.background_spawn(async move {
                backend.update_packages(Box::new(move |progress| {
                    sender.unbounded_send(progress).ok();
                }))
            });
            while let Some(progress) = received.next().await {
                this.update(cx, |this, cx| {
                    if let Some(run) = this.packages.run.as_mut().filter(|run| run.running) {
                        run.progress = progress.into();
                        cx.notify();
                    }
                })
                .ok();
            }
            let outcome = update.await;
            this.update(cx, |this, cx| {
                if let Some(run) = this.packages.run.as_mut() {
                    run.running = false;
                    match outcome {
                        Ok(()) => {
                            run.progress = InstallProgress {
                                stage: "complete".into(),
                                progress: 1.,
                            };
                            this.check_package_updates(true, cx);
                        }
                        Err(error) => run.error = Some(error),
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn close_doctor(&mut self, cx: &mut Context<Self>) {
        self.doctor_open = false;
        cx.notify();
    }

    /// The wizard's install: BasicTeX (or TeX Live on Windows), or only the
    /// paper tools when they are all that is missing; then the doctor again,
    /// which must find everything before the wizard closes.
    pub fn start_install(&mut self, cx: &mut Context<Self>) {
        if self.wizard.installing {
            return;
        }
        let paper_only = only_paper_tools_missing(self.report.as_ref());
        self.wizard = WizardInstall {
            installing: true,
            progress: Some(InstallProgress::at(if paper_only {
                "installing-tools"
            } else {
                "downloading"
            })),
            error: None,
        };
        cx.notify();
        let mode = if paper_only {
            TexInstallMode::ToolsOnly
        } else {
            TexInstallMode::Full
        };
        let backend = Self::backend(cx);
        let (sender, mut received) = mpsc::unbounded::<TexInstallProgress>();
        self._install = Some(cx.spawn(async move |this, cx| {
            let install = cx.background_spawn(async move {
                backend.install_tex(
                    mode,
                    Box::new(move |progress| {
                        sender.unbounded_send(progress).ok();
                    }),
                )
            });
            while let Some(progress) = received.next().await {
                this.update(cx, |this, cx| {
                    this.wizard.progress = Some(progress.into());
                    cx.notify();
                })
                .ok();
            }
            let outcome = install.await;
            let product = if paper_only {
                t!("The required tools")
            } else {
                distribution_name()
            };
            let verified = match outcome {
                Err(error) if error == TEX_INSTALL_CANCELLED => Err(None),
                Err(error) => Err(Some(error)),
                Ok(warning) => {
                    this.update(cx, |this, cx| {
                        this.wizard.progress = Some(InstallProgress {
                            stage: "complete".into(),
                            progress: 1.,
                        });
                        cx.notify();
                    })
                    .ok();
                    let recheck = this.update(cx, |this, cx| this.run_doctor(false, cx));
                    let report = match recheck {
                        Ok(task) => task.await,
                        Err(_) => return,
                    };
                    verify_install(product, report.as_ref())
                        .map(|()| warning)
                        .map_err(Some)
                }
            };
            this.update(cx, |this, cx| this.finish_install(paper_only, verified, cx))
                .ok();
        }));
    }

    fn finish_install(
        &mut self,
        paper_only: bool,
        verified: Result<Option<String>, Option<String>>,
        cx: &mut Context<Self>,
    ) {
        self.wizard.installing = false;
        match verified {
            Ok(warning) => {
                let title = match (paper_only, cfg!(windows)) {
                    (true, _) => t!("Required paper tools installed"),
                    (false, true) => t!("TeX Live installed"),
                    (false, false) => t!("BasicTeX installed"),
                };
                let mut notice = Notice::new(ToastLevel::Success, title);
                if paper_only && self.paper_tools_needed {
                    notice = notice.detail(t!("Try that again now"));
                }
                notices::show(notice, cx);
                if let Some(warning) = warning {
                    notices::show(Notice::new(ToastLevel::Warning, warning).key(SOURCE), cx);
                }
                self.wizard = WizardInstall::default();
                self.wizard_open = false;
                self.paper_tools_needed = false;
            }
            // Cancelled: nothing to say, the dialog stays for another try.
            Err(None) => self.wizard.progress = None,
            Err(Some(error)) => self.wizard.error = Some(error),
        }
        cx.notify();
    }

    /// Stop the install that is running (only Windows can).
    pub fn cancel_install(&mut self, cx: &mut Context<Self>) {
        let backend = Self::backend(cx);
        cx.background_spawn(async move { backend.cancel_install() })
            .detach();
    }

    /// Install the TeX Live package that provides `missing_file`;
    /// `package` is the writer's pick after the installer found several.
    pub fn install_dependency(
        &mut self,
        missing_file: String,
        package: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self
            .dependency
            .as_ref()
            .is_some_and(|install| install.installing)
        {
            return;
        }
        if self.dependency.is_none() {
            self.serial += 1;
        }
        self.dependency_attempt += 1;
        let attempt = self.dependency_attempt;
        self.dependency = Some(DependencyInstall {
            missing_file: missing_file.clone(),
            progress: InstallProgress::at("searching-packages"),
            installing: true,
            error: None,
            packages: None,
        });
        cx.notify();
        let backend = Self::backend(cx);
        let (sender, mut received) = mpsc::unbounded::<TexInstallProgress>();
        self._install = Some(cx.spawn(async move |this, cx| {
            let file = missing_file.clone();
            let install = cx.background_spawn(async move {
                backend.install_dependency(
                    &file,
                    package.as_deref(),
                    Box::new(move |progress| {
                        sender.unbounded_send(progress).ok();
                    }),
                )
            });
            while let Some(progress) = received.next().await {
                this.update(cx, |this, cx| {
                    if let Some(install) = this.current_dependency(attempt) {
                        install.progress = progress.into();
                        cx.notify();
                    }
                })
                .ok();
            }
            let outcome = install.await;
            this.update(cx, |this, cx| this.finish_dependency(attempt, outcome, cx))
                .ok();
        }));
    }

    fn current_dependency(&mut self, attempt: u64) -> Option<&mut DependencyInstall> {
        if attempt != self.dependency_attempt {
            return None;
        }
        self.dependency.as_mut()
    }

    fn finish_dependency(
        &mut self,
        attempt: u64,
        outcome: Result<TexDependencyInstall, String>,
        cx: &mut Context<Self>,
    ) {
        let Some(install) = self.current_dependency(attempt) else {
            return;
        };
        install.installing = false;
        match outcome {
            Ok(TexDependencyInstall::ChoosePackage { packages }) => {
                install.packages = Some(packages);
            }
            Ok(TexDependencyInstall::Installed) => {
                let file = install.missing_file.clone();
                self.dependency_attempt += 1;
                self.dependency = None;
                notices::show(
                    Notice::new(ToastLevel::Success, t!("LaTeX package installed")).detail(file),
                    cx,
                );
                cx.emit(TexSetupEvent::Rebuild);
            }
            Err(error) => install.error = Some(error),
        }
        cx.notify();
    }

    pub fn close_dependency(&mut self, cx: &mut Context<Self>) {
        if self
            .dependency
            .as_ref()
            .is_some_and(|install| install.installing)
        {
            return;
        }
        self.dependency_attempt += 1;
        self.dependency = None;
        cx.notify();
    }

    /// The failure's summary and the installer's words, for the dialog.
    pub(super) fn dependency_failure(install: &DependencyInstall) -> Option<(String, String)> {
        install.error.as_deref().map(dependency_install_failure)
    }
}

/// What the doctor found after an install: every required tool, and the
/// conference fonts. An install that left any out says which.
fn verify_install(product: &str, report: Option<&DoctorReport>) -> Result<(), String> {
    let Some(report) = report else {
        return Err(t!(
            "{installedProduct} finished installing, but Lattice could not run the final verification.",
            installedProduct = product
        ));
    };
    let mut missing = missing_tex_tools(Some(report));
    missing.extend(missing_paper_tools(Some(report)));
    let mut issues = Vec::new();
    if !missing.is_empty() {
        issues.push(t!("Missing tools: {0}", missing.join(", ")));
    }
    if conference_fonts_missing(Some(report)) {
        let fonts = report
            .checks
            .iter()
            .find(|check| check.name == "conference-fonts");
        issues.push(fonts.map_or_else(
            || t!("Conference font verification is missing.").to_string(),
            super::super::doctor::check_detail,
        ));
    }
    if issues.is_empty() {
        Ok(())
    } else {
        // The catalog's message has a named and a positional placeholder.
        let issues = issues.join("\n");
        Err(lattice_i18n::fill_named(
            lattice_i18n::tr(
                "{installedProduct} finished installing, but Lattice could not verify:\n{0}",
            ),
            &[
                ("installedProduct", &product as &dyn std::fmt::Display),
                ("0", &issues as &dyn std::fmt::Display),
            ],
        ))
    }
}
