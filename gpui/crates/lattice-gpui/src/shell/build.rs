//! The shell's build pipeline: lattice-core's build of the open project, one
//! at a time, with a build asked for meanwhile queued behind it, and the
//! jump to the PDF's check that the PDF is of the sources as they are now.
//! As the Tauri app's `use-build-pipeline.ts` runs it: a clean rebuild
//! deletes the auxiliary files first, a stopped build reports nothing, an
//! unattended build of a failing document nothing changed in restates its
//! errors (lattice-core's `build::unchanged`), and a build that finds no TeX
//! opens setup.

use std::{
    collections::HashMap,
    hash::{Hash as _, Hasher as _},
    path::{Path, PathBuf},
    time::Duration,
};

use futures::{StreamExt as _, channel::mpsc, channel::oneshot};
use gpui::{App, AppContext as _, AsyncWindowContext, Context, Entity, WeakEntity, Window};
use lattice_core::{
    latex::{self, BuildResult, BuildStep, BuildSteps},
    models::{Diagnostic, FileNode},
};
use lattice_ui::components::ToastLevel;

use super::{Build, Shell};
use crate::{
    build::{diagnostics, tex_setup},
    notices::{self, Notice, NoticeAction},
    project::Project,
};

const NO_DOCUMENT: &str = "This project has no LaTeX document to build yet. Add a .tex file, or \
                           set one as the root document in project settings.";

/// How long a build runs before Lattice says so and offers to stop it.
const SLOW_BUILD: Duration = Duration::from_secs(10 * 60);
const SLOW_BUILD_NOTICE: &str = "build-still-running";
/// A build that could not run: each autosave's failure replaces the last, and
/// a build that succeeds takes it down.
const BUILD_FAILED_NOTICE: &str = "build-failed";

/// How a build was asked for, which decides what it may do.
#[derive(Clone, Copy, Debug, Default)]
pub(super) struct BuildRequest {
    /// Typeset from scratch.
    pub(super) force: bool,
    /// Delete the auxiliary files first (a clean rebuild).
    pub(super) clean: bool,
    /// Lattice started it (a save, an outside edit), nobody asked: a failing
    /// document nothing changed in is not typeset again (`latex::build`).
    unattended: bool,
    /// The writer asked (⌘B, the chip): its failure comes back even when
    /// dismissed, and the editor goes to its first error.
    pub(super) requested: bool,
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

    /// The writer's clean rebuild: auxiliary files deleted, typeset from
    /// scratch.
    pub(super) fn clean_rebuild() -> Self {
        Self {
            force: true,
            clean: true,
            requested: true,
            unattended: false,
        }
    }

    /// The build queued behind a running one stands for both asks.
    fn merge(self, other: Self) -> Self {
        Self {
            force: self.force || other.force,
            clean: self.clean || other.clean,
            unattended: self.unattended && other.unattended,
            requested: self.requested || other.requested,
        }
    }
}

/// Every path in the project tree, parents before their children.
fn flatten(nodes: &[FileNode], out: &mut Vec<String>) {
    for node in nodes {
        if !node.path.is_empty() {
            out.push(node.path.clone());
        }
        flatten(&node.children, out);
    }
}

/// What a PDF holds, to tell whether a failed build wrote a new one. Not its
/// time: lattice-core puts the last good PDF back after a failed build
/// (`shown_pdf.rs`), which writes the file without a new page in it.
fn fingerprint(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

/// The PDF of each document a build could compile, fingerprinted before it.
fn fingerprint_pdfs(root: &Path, documents: &[String]) -> HashMap<PathBuf, u64> {
    documents
        .iter()
        .filter_map(|document| {
            let pdf = root.join(document).with_extension("pdf");
            fingerprint(&pdf).map(|hash| (pdf, hash))
        })
        .collect()
}

/// The build wrote `pdf` anew: it holds other bytes than before the build,
/// or there was none.
fn rewrote(pdf: &Path, before: &HashMap<PathBuf, u64>) -> bool {
    fingerprint(pdf) != before.get(pdf).copied()
}

/// The text of each project file the diagnostics name, keyed as they name
/// it: what the build compiled. An editor's text as the build saved it, since
/// an autosave during the build writes newer text to disk; else the file on
/// disk, and only a file in the project tree.
fn read_sources(
    root: &Path,
    diagnostics: &[Diagnostic],
    root_document: &str,
    files: &[String],
    saved: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut sources = HashMap::new();
    for diagnostic in diagnostics {
        let Some(file) = &diagnostic.file else {
            continue;
        };
        if sources.contains_key(file) {
            continue;
        }
        let path = diagnostics::resolve_path(Some(file), files, root_document);
        let text = match saved.get(&path) {
            Some(text) => Some(text.clone()),
            None if files.contains(&path) => std::fs::read_to_string(root.join(&path)).ok(),
            None => None,
        };
        if let Some(text) = text {
            sources.insert(file.clone(), text);
        }
    }
    sources
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
        // A .tex open in the editor that holds `\documentclass` builds even
        // when the manifest names no document: lattice-core adopts it, as
        // Overleaf does.
        let open_document = self.active_editor().and_then(|editor| {
            let editor = editor.read(cx);
            editor
                .relative()
                .to_ascii_lowercase()
                .ends_with(".tex")
                .then(|| (editor.relative().to_string(), editor.editor().clone()))
        });
        let compilable = open_document
            .as_ref()
            .is_some_and(|(_, editor)| editor.read(cx).text(cx).contains("\\documentclass"));
        let main = project.read(cx).main_document().map(str::to_string);
        if main.is_none() && !compilable {
            // Autosave and a jump to the PDF reach here too; only the writer
            // pressing Build is told what to add.
            if request.requested {
                notices::error("Build", NO_DOCUMENT, cx);
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
        let saved: HashMap<String, String> = editors
            .iter()
            .filter_map(|editor| {
                let editor = editor.read(cx);
                let relative = editor.relative().to_ascii_lowercase();
                (relative.ends_with(".tex") || relative.ends_with(".bib")).then(|| {
                    (
                        editor.relative().to_string(),
                        editor.editor().read(cx).text(cx),
                    )
                })
            })
            .collect();
        let root = project.read(cx).root().to_path_buf();
        let mut files = Vec::new();
        flatten(project.read(cx).files(), &mut files);
        let label = main
            .clone()
            .or_else(|| open_document.clone())
            .unwrap_or_default();
        let candidates: Vec<String> = main.iter().chain(&open_document).cloned().collect();
        self.build_panel.update(cx, |panel, cx| {
            panel.set_project_files(files.clone());
            panel.started(&root, &label, cx);
        });

        // A build still going after minutes may be looping: say so, with Stop.
        self.slow_build = Some(cx.spawn(async move |_, cx| {
            cx.background_executor().timer(SLOW_BUILD).await;
            cx.update(|cx| {
                let stop = NoticeAction::new("Stop", |window, cx| {
                    window.dispatch_action(Box::new(super::StopBuild), cx)
                });
                let notice = Notice::new(
                    ToastLevel::Warning,
                    "Still building after 10 minutes. Something in the document may be looping; \
                     stop the build if it does not finish.",
                )
                .action(stop)
                .key(SLOW_BUILD_NOTICE)
                .persistent();
                notices::show(notice, cx);
            });
        }));
        let build_panel = self.build_panel.clone();
        self.build_task = Some(cx.spawn_in(window, async move |this, cx| {
            for save in saves {
                if let Err(error) = save.await {
                    log::error!("{error:#}");
                }
            }
            // Cleaning was held back while the previous pass ran; a forced
            // build alone keeps the stale .aux the writer asked to be rid of.
            if request.clean {
                let cleaned = cx
                    .background_spawn({
                        let root = root.clone();
                        async move { latex::clean(&root) }
                    })
                    .await;
                if let Err(error) = cleaned {
                    this.update_in(cx, |this, window, cx| {
                        notices::error("Couldn’t clean the build files", error, cx);
                        this.finish_build(&project, 0, request, None, window, cx);
                    })
                    .ok();
                    return;
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
                    let before = fingerprint_pdfs(&root, &candidates);
                    let result = latex::build(
                        &root,
                        request.force,
                        request.unattended,
                        &active,
                        open_document.as_deref(),
                        &steps,
                    );
                    result.map(|result| {
                        let pdf = root.join(&result.root_document).with_extension("pdf");
                        let rewritten = rewrote(&pdf, &before);
                        let sources = read_sources(
                            &root,
                            &result.diagnostics,
                            &result.root_document,
                            &files,
                            &saved,
                        );
                        Finished {
                            result,
                            rewritten,
                            sources,
                        }
                    })
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
                this.finish_build(&project, revision, request, Some(outcome), window, cx)
            })
            .ok();
        }));
        cx.notify();
    }

    fn finish_build(
        &mut self,
        project: &Entity<Project>,
        revision: u64,
        request: BuildRequest,
        outcome: Option<Result<Finished, String>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.build_task = None;
        self.slow_build = None;
        notices::dismiss(SLOW_BUILD_NOTICE, cx);
        let current = self.project.as_ref() == Some(project);
        match outcome {
            // A build of the project open before shows nothing in this one.
            _ if !current => self.build_panel.update(cx, |panel, cx| panel.cleared(cx)),
            // The clean before it failed, and said so.
            None => {
                project.update(cx, |project, _| project.forget_compiled());
                self.build_panel.update(cx, |panel, cx| panel.failed(cx));
            }
            Some(Ok(Finished {
                result,
                rewritten,
                sources,
            })) => {
                let cancelled = result
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == Some("build-cancelled"));
                // LaTeX carries on past most errors, so a failed pass that
                // wrote a new PDF still compiled these inputs; an unchanged
                // one restates the build of these inputs whose PDF is on disk.
                let wrote_pdf = result.has_pdf
                    && !cancelled
                    && (result.success || result.unchanged || rewritten);
                self.build_panel.update(cx, |panel, cx| {
                    panel.finished(&result, wrote_pdf, request.requested, sources, cx)
                });
                let root = project.read(cx).root().to_path_buf();
                project.update(cx, |project, cx| {
                    // A build may adopt the open document or switch the
                    // engine, which it writes to the manifest.
                    project.reload_manifest(cx);
                    if wrote_pdf {
                        project.record_compiled(
                            revision,
                            result.root_document.clone(),
                            result.one_off,
                        );
                    } else {
                        project.forget_compiled();
                    }
                });
                if result.success && !cancelled {
                    notices::dismiss(BUILD_FAILED_NOTICE, cx);
                }
                if result.has_pdf {
                    let pdf = root.join(&result.root_document).with_extension("pdf");
                    self.pdf.update(cx, |panel, cx| panel.open(pdf, window, cx));
                }
                if !result.success && !cancelled {
                    // A build the writer asked for goes to its first error,
                    // and its card, over the PDF, comes into view.
                    if request.requested {
                        self.bring_build_card_forward(window, cx);
                        let first_error = result.diagnostics.iter().find(|diagnostic| {
                            diagnostic.level == "error"
                                && (diagnostic.file.is_some() || diagnostic.line.is_some())
                        });
                        let target = first_error
                            .and_then(|diagnostic| self.build_panel.read(cx).location(diagnostic));
                        if let Some(target) = target {
                            self.open_path(target.path, target.line, window, cx);
                        }
                    }
                    // Only a parsed tool diagnostic may open setup: a raw log
                    // says "not found" for every missing project file.
                    if result.diagnostics.iter().any(|diagnostic| {
                        tex_setup::is_missing_tex_build_error(&diagnostic.message)
                    }) {
                        self.tex_setup
                            .update(cx, |center, cx| center.open_for_missing_tex(cx));
                    }
                }
            }
            Some(Err(error)) => {
                let failure = latex::classify_build_error(&error);
                log::warn!("build {}: {error}", failure.kind);
                project.update(cx, |project, _| project.forget_compiled());
                self.build_panel.update(cx, |panel, cx| panel.failed(cx));
                notices::show(
                    Notice::new(ToastLevel::Error, "LaTeX compilation failed.")
                        .detail(error.clone())
                        .key(BUILD_FAILED_NOTICE),
                    cx,
                );
                if tex_setup::is_missing_tex_build_error(&error) {
                    self.tex_setup
                        .update(cx, |center, cx| center.open_for_missing_tex(cx));
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
    pub(super) fn settle_builds(&mut self) {
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
            let Ok(compiled) = this.update(cx, |this, cx| {
                this.project
                    .as_ref()
                    .is_some_and(|project| project.read(cx).has_compiled())
            }) else {
                return false;
            };
            if !compiled {
                return false;
            }
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

/// A build that ran to its end: its result, whether it wrote the PDF over
/// the one before, and the sources its diagnostics quote.
pub(super) struct Finished {
    result: BuildResult,
    rewritten: bool,
    sources: HashMap<String, String>,
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
        let clean = BuildRequest::automatic().merge(BuildRequest::clean_rebuild());
        assert!(clean.clean && clean.force && clean.requested && !clean.unattended);
    }

    #[test]
    fn a_pdf_is_rewritten_only_against_its_own_bytes_before_the_build() {
        let root = std::env::temp_dir().join(format!("lattice-rewrote-{}", std::process::id()));
        std::fs::create_dir_all(root.join("figures")).unwrap();
        std::fs::write(root.join("main.pdf"), "the paper").unwrap();
        std::fs::write(root.join("figures/plot.pdf"), "the figure").unwrap();
        let documents = ["main.tex".to_string(), "figures/plot.tex".to_string()];
        let before = fingerprint_pdfs(&root, &documents);
        let plot = root.join("figures/plot.pdf");
        let main = root.join("main.pdf");
        let chapter = root.join("chapters/intro.pdf");

        let left_in_place = rewrote(&plot, &before);
        std::fs::write(&main, "the paper, typeset again").unwrap();
        let typeset = rewrote(&main, &before);
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(&chapter, "a first chapter").unwrap();
        let first = rewrote(&chapter, &before);
        std::fs::remove_dir_all(&root).ok();

        assert!(!left_in_place);
        assert!(typeset);
        assert!(first);
    }

    fn naming(file: &str) -> Diagnostic {
        Diagnostic {
            file: Some(file.to_string()),
            line: Some(1),
            column: None,
            end_line: None,
            end_column: None,
            level: "error".into(),
            message: "Undefined control sequence.".into(),
            code: None,
            params: Default::default(),
        }
    }

    #[test]
    fn sources_are_the_text_the_build_saved_and_only_project_files() {
        let base =
            std::env::temp_dir().join(format!("lattice-read-sources-{}", std::process::id()));
        let root = base.join("paper");
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "autosaved during the build").unwrap();
        std::fs::write(root.join("chapters/intro.tex"), "on disk").unwrap();
        std::fs::write(base.join("secret.tex"), "outside the project").unwrap();
        let files = vec![
            "main.tex".to_string(),
            "chapters".to_string(),
            "chapters/intro.tex".to_string(),
        ];
        let saved = HashMap::from([("main.tex".to_string(), "as built".to_string())]);

        let sources = read_sources(
            &root,
            &[
                naming("main.tex"),
                naming("./chapters/intro.tex"),
                naming("../secret.tex"),
            ],
            "main.tex",
            &files,
            &saved,
        );
        std::fs::remove_dir_all(&base).ok();

        assert_eq!(
            sources.get("main.tex").map(String::as_str),
            Some("as built")
        );
        assert_eq!(
            sources.get("./chapters/intro.tex").map(String::as_str),
            Some("on disk")
        );
        assert_eq!(sources.get("../secret.tex"), None);
        assert_eq!(sources.len(), 2);
    }
}
