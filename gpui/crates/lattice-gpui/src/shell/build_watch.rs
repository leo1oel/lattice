//! The builds the window starts without an editor's save, as the Tauri
//! app's build pipeline starts them: one when a project is entered (the PDF
//! on disk may be of older sources, so latexmk checks it), and one after the
//! project's files change on disk outside the window's open documents
//! (`build::watched`), held while the last build stalled on the same inputs
//! (`build::stall`). A linked project's successful build becomes a version,
//! at most every two minutes (`use-build-autoversion.ts`). And the build's
//! diagnostics underline their lines in the open editors whose text is the
//! text it compiled (`lattice_editor::latex::build_diagnostics`).

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use gpui::{AppContext as _, Context, Entity, EntityId, Subscription, Task, Window};
use lattice_core::latex::BuildResult;
use lattice_editor::latex::{
    build_diagnostics::{BuildDiagnostics, BuildMark},
    diagnostics::{Severity, matches_file},
};

use super::{
    Shell,
    build::BuildRequest,
    parts::{self, Part},
};
use crate::{
    build::{
        inputs,
        stall::StallHold,
        watched::{self, Fire, WatchedBuilds},
    },
    project::{Project, ProjectEvent},
};

/// How often a linked project's builds may become versions.
const AUTOVERSION_EVERY: Duration = Duration::from_secs(120);

pub(super) const PART: Part = Part {
    install: |_, _| Box::new(BuildWatch::default()),
    views: &[],
    actions: |element, _| element,
    commands: parts::no_commands,
};

#[derive(Default)]
pub(crate) struct BuildWatch {
    watched: WatchedBuilds,
    stall: StallHold,
    /// The wait for the writes to pause.
    _pause: Option<Task<()>>,
    /// When a build last became a version.
    autoversioned: Option<Instant>,
    /// Each open editor's marks of the last build, by its editor.
    marks: HashMap<EntityId, Entity<BuildDiagnostics>>,
    _project: Option<Subscription>,
}

/// The project's root documents, as its manifest names them.
fn root_documents(project: &Entity<Project>, cx: &gpui::App) -> Vec<String> {
    project
        .read(cx)
        .manifest()
        .root_documents
        .iter()
        .map(|document| document.path.clone())
        .collect()
}

impl Shell {
    fn build_watch(&mut self) -> &mut BuildWatch {
        self.parts.get_mut::<BuildWatch>()
    }

    /// A project was entered: follow its watcher's reports, and build it, as
    /// the Tauri app's `enterProject` does, whatever Settings › Builds says.
    pub(super) fn watch_builds(
        &mut self,
        project: &Entity<Project>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let subscription = cx.subscribe_in(project, window, |this, _, event, window, cx| {
            if let ProjectEvent::FilesChanged(paths) = event {
                this.watched_files_changed(paths.as_deref(), window, cx);
                this.pdf_files_changed(paths.as_deref(), window, cx);
            }
        });
        let watch = self.build_watch();
        watch.watched.reset();
        watch.stall.reset();
        watch._pause = None;
        watch.marks.clear();
        watch._project = Some(subscription);
        self.repair_left_project(cx);
        self.run_build(BuildRequest::default(), window, cx);
    }

    fn watched_files_changed(
        &mut self,
        paths: Option<&[String]>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root_documents = root_documents(&project, cx);
        let root = project.read(cx).root().to_path_buf();
        // What the open editors answer for themselves: an editor's save
        // builds, and an outside edit reaches its editor. A file gone from
        // under its editor reaches it as no edit, so its report counts.
        let mut open: Vec<String> = self
            .open_editors()
            .iter()
            .filter_map(|editor| inputs::normalize(editor.read(cx).relative()))
            .collect();
        open.sort();
        open.dedup();
        let changed = self
            .build_watch()
            .watched
            .report(paths, &root_documents, |path| {
                open.binary_search_by(|open| open.as_str().cmp(path))
                    .is_ok()
                    && root.join(path).exists()
            });
        if !changed {
            return;
        }
        project.update(cx, |project, _| project.mark_inputs_changed());
        if crate::settings::builds_automatically(cx) {
            self.wait_for_writes_to_pause(window, cx);
        }
    }

    /// An open editor took in an outside edit of `path`: it builds with the
    /// other outside writes, once they pause.
    pub(super) fn outside_edit(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root_documents = root_documents(&project, cx);
        if !self.build_watch().watched.noted(path, &root_documents) {
            return;
        }
        project.update(cx, |project, _| project.mark_inputs_changed());
        if crate::settings::builds_automatically(cx) {
            self.wait_for_writes_to_pause(window, cx);
        }
    }

    fn wait_for_writes_to_pause(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pause = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(watched::IDLE).await;
            this.update_in(cx, |this, window, cx| this.writes_paused(window, cx))
                .ok();
        });
        let watch = self.build_watch();
        watch.watched.scheduled();
        watch._pause = Some(pause);
    }

    fn writes_paused(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let building = self.build_task.is_some();
        let watch = self.build_watch();
        watch._pause = None;
        if watch.watched.fire(building) == Fire::Build
            && crate::settings::builds_automatically(cx)
            && !self.defer_automatic_build(window, cx)
        {
            self.run_build(BuildRequest::automatic(), window, cx);
        }
    }

    /// An automatic build of the inputs at `revision` waits for them to
    /// change: the last build stalled on them.
    pub(super) fn build_held(&mut self, revision: u64) -> bool {
        self.build_watch().stall.holds(revision)
    }

    /// A pass is about to read the project.
    pub(super) fn build_pass_started(&mut self) {
        self.build_watch().watched.pass_started();
    }

    /// A pass of the project open now ended with `result`, of the inputs at
    /// `revision`.
    pub(super) fn build_pass_finished(
        &mut self,
        result: &BuildResult,
        revision: u64,
        cx: &mut Context<Self>,
    ) {
        self.note_repair_writable(cx);
        let watch = self.build_watch();
        watch.stall.note(&result.diagnostics, revision);
        watch.watched.pass_wrote(&result.outputs);
        // Unlinked projects never get surprise versions in a repository
        // kept by hand.
        if !result.success || !self.overleaf.read(cx).linked() {
            return;
        }
        let now = Instant::now();
        let watch = self.build_watch();
        if watch
            .autoversioned
            .is_some_and(|last| now.duration_since(last) < AUTOVERSION_EVERY)
        {
            return;
        }
        watch.autoversioned = Some(now);
        let Some(root) = self.root(cx) else {
            return;
        };
        cx.background_spawn(async move {
            if let Err(error) =
                lattice_core::git::auto_commit(&root, crate::history::messages::AUTO_SAVED, None)
            {
                log::warn!("the build's version was not recorded: {error}");
            }
        })
        .detach();
    }

    /// No build runs or waits any more: a pause that came during one is
    /// waited for again.
    pub(super) fn builds_idle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.build_watch().watched.idle() {
            self.wait_for_writes_to_pause(window, cx);
        }
    }

    /// Underline the build's diagnostics in each open editor, against
    /// `sources`, the text of each file they name as the build read it
    /// (keyed as they name it).
    pub(super) fn show_build_marks(
        &mut self,
        result: &BuildResult,
        sources: &HashMap<String, String>,
        cx: &mut Context<Self>,
    ) {
        let editors = self.open_editors();
        let watch = self.build_watch();
        let open: Vec<EntityId> = editors.iter().map(|editor| editor.entity_id()).collect();
        watch.marks.retain(|id, _| open.contains(id));
        for editor in editors {
            let (relative, lattice) = {
                let editor = editor.read(cx);
                (
                    editor.relative().to_string(),
                    editor.lattice_editor().clone(),
                )
            };
            let named: Vec<_> = result
                .diagnostics
                .iter()
                .filter(|diagnostic| matches_file(diagnostic.file.as_deref(), &relative))
                .collect();
            let compiled = named
                .iter()
                .find_map(|diagnostic| sources.get(diagnostic.file.as_deref()?))
                .cloned();
            let marks: Vec<BuildMark> = named
                .iter()
                .map(|diagnostic| BuildMark {
                    line: diagnostic.line.unwrap_or(1),
                    severity: Severity::of(&diagnostic.level),
                    message: crate::build::messages::text(diagnostic),
                })
                .collect();
            let watch = self.build_watch();
            if marks.is_empty() && !watch.marks.contains_key(&editor.entity_id()) {
                continue;
            }
            let layer = match watch.marks.get(&editor.entity_id()) {
                Some(layer) => layer.clone(),
                None => {
                    let layer = BuildDiagnostics::attach(&lattice, cx);
                    self.build_watch()
                        .marks
                        .insert(editor.entity_id(), layer.clone());
                    layer
                }
            };
            layer.update(cx, |layer, cx| layer.set(compiled, marks, cx));
        }
    }

    /// A build the writer asks for that typesets even when nothing changed,
    /// for a scenario: the project's build on opening leaves latexmk
    /// nothing to do in the next.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn build_forced(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut request = BuildRequest::requested();
        request.force = true;
        self.run_build(request, window, cx);
    }

    /// The build marks shown in `editor`, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(crate) fn build_marks_shown(&self, editor: EntityId, cx: &gpui::App) -> usize {
        self.parts
            .get::<BuildWatch>()
            .marks
            .get(&editor)
            .map_or(0, |layer| layer.read(cx).shown())
    }
}
