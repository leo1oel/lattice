//! The shell's build pipeline: lattice-core's build of the open project, one
//! at a time, with a build asked for meanwhile queued behind it, and the
//! jump to the PDF's check that the PDF is of the sources as they are now.

use futures::{StreamExt as _, channel::mpsc, channel::oneshot};
use gpui::{App, AppContext as _, AsyncWindowContext, Context, Entity, WeakEntity, Window};
use lattice_core::latex::{self, BuildResult, BuildStep, BuildSteps};

use super::{Build, Shell};
use crate::project::Project;

const NO_DOCUMENT: &str = "This project has no LaTeX document to build yet. Add a .tex file, or \
                           set one as the root document in project settings.";

/// How a build was asked for, which decides what it may do.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct BuildRequest {
    /// Typeset from scratch.
    force: bool,
    /// Lattice started it (a save, an outside edit), nobody asked: a failing
    /// document nothing changed in is not typeset again (`latex::build`).
    unattended: bool,
    /// The writer asked (⌘B, the chip): its failure brings the problems up.
    requested: bool,
}

impl BuildRequest {
    pub(super) fn automatic() -> Self {
        Self {
            unattended: true,
            ..Self::default()
        }
    }

    pub(super) fn requested() -> Self {
        Self {
            requested: true,
            ..Self::default()
        }
    }

    /// The build queued behind a running one stands for both asks.
    fn merge(self, other: Self) -> Self {
        Self {
            force: self.force || other.force,
            unattended: self.unattended && other.unattended,
            requested: self.requested || other.requested,
        }
    }
}

impl Shell {
    /// ⌘B and the build chip: save, then build, bringing the problems up if
    /// it fails.
    pub fn build(&mut self, _: &Build, window: &mut Window, cx: &mut Context<Self>) {
        self.run_build(BuildRequest::requested(), window, cx);
    }

    /// Save every edited file, then run lattice-core's build of the project
    /// in the background, its passes streaming into the build panel, and show
    /// the diagnostics and reload the PDF. A build asked for while one runs
    /// waits for it, as one build standing for every ask made meanwhile.
    pub(super) fn run_build(
        &mut self,
        request: BuildRequest,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let open_document = self.open_document(cx);
        let compilable = open_document
            .as_ref()
            .is_some_and(|(_, compilable)| *compilable);
        let main = project.read(cx).main_document().map(str::to_string);
        if main.is_none() && !compilable {
            if request.requested {
                self.build_panel
                    .update(cx, |panel, cx| panel.failed(NO_DOCUMENT.into(), cx));
            }
            self.settle_builds();
            return;
        }
        if self.build_task.is_some() {
            self.queued_build = Some(match self.queued_build {
                Some(queued) => queued.merge(request),
                None => request,
            });
            return;
        }
        let open_document = open_document.map(|(path, _)| path);
        let editors = self.open_editors();
        let saves = Self::save_dirty(&editors, cx);
        let root = project.read(cx).root().to_path_buf();
        let label = main.or_else(|| open_document.clone()).unwrap_or_default();
        self.build_panel
            .update(cx, |panel, cx| panel.started(&root, &label, cx));

        let build_panel = self.build_panel.clone();
        self.build_task = Some(cx.spawn_in(window, async move |this, cx| {
            for save in saves {
                if let Err(error) = save.await {
                    log::error!("{error:#}");
                }
            }
            let (revision, active) = project.read_with(cx, |project, _| {
                (project.input_revision(), project.active_build().clone())
            });
            let (progress, mut received) = mpsc::unbounded::<Vec<BuildStep>>();
            let steps = BuildSteps::new(move |_, steps| {
                progress.unbounded_send(steps.to_vec()).ok();
            });
            let build = cx.background_spawn({
                let root = root.clone();
                async move {
                    latex::build(
                        &root,
                        request.force,
                        request.unattended,
                        &active,
                        open_document.as_deref(),
                        &steps,
                    )
                }
            });
            while let Some(steps) = received.next().await {
                let mut latest = steps;
                while let Ok(steps) = received.try_recv() {
                    latest = steps;
                }
                build_panel.update(cx, |panel, cx| panel.steps(latest, cx));
            }
            let outcome = build.await;
            this.update_in(cx, |this, window, cx| {
                this.finish_build(&project, revision, request, outcome, window, cx)
            })
            .ok();
        }));
        cx.notify();
    }

    /// The .tex in the editor the writer was last in, and whether it holds
    /// `\documentclass`: such a file builds even when the manifest names no
    /// document, as lattice-core adopts it, as Overleaf does.
    fn open_document(&self, cx: &App) -> Option<(String, bool)> {
        let editor = self.active_editor()?;
        let editor = editor.read(cx);
        editor
            .relative()
            .to_ascii_lowercase()
            .ends_with(".tex")
            .then(|| {
                (
                    editor.relative().to_string(),
                    editor
                        .editor()
                        .read(cx)
                        .text(cx)
                        .contains("\\documentclass"),
                )
            })
    }

    /// Whether a build has a document to typeset: the project's main
    /// document, or the open one (`open_document`).
    pub(super) fn has_document(&self, cx: &App) -> bool {
        self.project
            .as_ref()
            .is_some_and(|project| project.read(cx).main_document().is_some())
            || self
                .open_document(cx)
                .is_some_and(|(_, compilable)| compilable)
    }

    fn finish_build(
        &mut self,
        project: &Entity<Project>,
        revision: u64,
        request: BuildRequest,
        outcome: Result<BuildResult, String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.build_task = None;
        let current = self.project.as_ref() == Some(project);
        match outcome {
            // A build of the project open before shows nothing in this one.
            _ if !current => self.build_panel.update(cx, |panel, cx| panel.cleared(cx)),
            Ok(result) => {
                self.build_panel
                    .update(cx, |panel, cx| panel.finished(&result, cx));
                let root = project.read(cx).root().to_path_buf();
                project.update(cx, |project, cx| {
                    // A build may adopt the open document or switch the
                    // engine, which it writes to the manifest.
                    project.reload_manifest(cx);
                    if result.has_pdf {
                        project.record_compiled(
                            revision,
                            result.root_document.clone(),
                            result.one_off,
                        );
                    }
                });
                if result.has_pdf {
                    let pdf = root.join(&result.root_document).with_extension("pdf");
                    self.pdf.update(cx, |panel, cx| panel.open(pdf, window, cx));
                }
                let errors = result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.level == "error");
                if request.requested && errors {
                    self.show_build_panel(true, window, cx);
                }
            }
            Err(error) => {
                let failure = latex::classify_build_error(&error);
                log::warn!("build {}: {error}", failure.kind);
                self.build_panel
                    .update(cx, |panel, cx| panel.failed(error, cx));
                if request.requested {
                    self.show_build_panel(true, window, cx);
                }
            }
        }
        // `set_project` drops the queue, so what is queued now was asked of
        // the project open now.
        match self.queued_build.take() {
            Some(queued) => self.run_build(queued, window, cx),
            None => self.settle_builds(),
        }
        cx.notify();
    }

    /// Tell whoever waits for the builds that they are over.
    fn settle_builds(&mut self) {
        if self.build_task.is_none() {
            for waiter in self.build_waiters.drain(..) {
                waiter.send(()).ok();
            }
        }
    }

    /// Resolves once no build is under way or queued.
    fn builds_settled(&mut self) -> oneshot::Receiver<()> {
        let (settled, receiver) = oneshot::channel();
        self.build_waiters.push(settled);
        self.settle_builds();
        receiver
    }

    /// Whether the PDF on screen is of the sources as they are now, building
    /// when it is not, as the Tauri app's `ensureCompiled` does: inputs that
    /// keep changing under the build get a few passes, not a loop.
    pub(super) async fn ensure_compiled(
        this: &WeakEntity<Self>,
        cx: &mut AsyncWindowContext,
    ) -> bool {
        for _ in 0..3 {
            let Ok(current) = this.update(cx, |this, cx| this.compiled_is_current(cx)) else {
                return false;
            };
            if current {
                return true;
            }
            let Ok(settled) = this.update_in(cx, |this, window, cx| {
                if this.build_task.is_none() {
                    this.run_build(BuildRequest::default(), window, cx);
                }
                this.builds_settled()
            }) else {
                return false;
            };
            settled.await.ok();
        }
        this.update(cx, |this, cx| this.compiled_is_current(cx))
            .unwrap_or(false)
    }

    fn compiled_is_current(&self, cx: &App) -> bool {
        let Some(project) = &self.project else {
            return false;
        };
        let open = self
            .active_editor()
            .map(|editor| editor.read(cx).relative().to_string());
        project.read(cx).compiled_is_current(open.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_queued_build_stands_for_every_ask() {
        let queued = BuildRequest::automatic().merge(BuildRequest::requested());
        assert!(queued.requested && !queued.unattended && !queued.force);
        let automatic = BuildRequest::automatic().merge(BuildRequest::automatic());
        assert!(automatic.unattended && !automatic.requested);
    }
}
