//! The submission checklist tool panel, ported from the Tauri app's
//! `ManuscriptChecklistPanel` (`src/project/manuscript-checklist.tsx`, its
//! parts in `deadline-card.tsx`, `submission-review.tsx` and
//! `submission-items.tsx`, `.checklist-*` in `dialogs.css`), docked as the
//! Tauri app docks the drawer: a Trellis tool panel on the input surface,
//! its content 14px in, no header of its own.
//!
//! Top to bottom: the deadline (or a line offering to add one); the verdict
//! in the title serif over a track with one segment per check; the
//! automatic rows (body words and main pages against their budgets, TODOs,
//! unused labels and citations, the last build); the double-blind and font
//! review; the writer's own materials and sign-offs; the way into the
//! figure inventory; and the word and page limits.
//!
//! The counts are the window's own (the manuscript's word count, the PDF on
//! screen, the TODO scan, the last build); what needs the disk is read off
//! the main thread when the panel opens and again after each build and each
//! change to the project's files: lattice-core's `unused_symbols`,
//! `review_submission`, where the body ends and SyncTeX's page for it
//! (`body_pages`), and each linked file's stat.

mod deadline;
mod items;
pub mod model;
mod review;
pub(crate) mod view;

use std::{collections::HashMap, path::PathBuf};

use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ScrollHandle,
    SharedString, Subscription, Task, Window,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    input::InputState,
};
use lattice_core::{
    latex::{self, SubmissionReview},
    models::{ProjectDeadline, SubmissionItem},
    project,
};
use lattice_i18n::t;

use crate::{
    build_panel::BuildPanel,
    pdf::PdfPanel,
    project::{Project, ProjectEvent},
};
use model::{Body, BodyEnd, FileStat};

/// What the panel asks of the window.
pub enum ChecklistEvent {
    OpenTodos,
    OpenFigures,
    /// Open a project file, at a line when given.
    Open {
        path: String,
        line: Option<u32>,
    },
    /// Open a requirement's source in the browser.
    OpenUrl(String),
}

/// What the background read found.
#[derive(Default)]
struct DiskFacts {
    unused_labels: usize,
    unused_citations: usize,
    review: Option<SubmissionReview>,
    body: Option<Body>,
    stats: HashMap<String, FileStat>,
}

pub struct ChecklistPanel {
    focus_handle: FocusHandle,
    project: Option<Entity<Project>>,
    build: Entity<BuildPanel>,
    pdf: Entity<PdfPanel>,
    facts: DiskFacts,
    generation: u64,
    word_budget: Entity<InputState>,
    page_budget: Entity<InputState>,
    deadline: deadline::DeadlineState,
    items: items::ItemsState,
    scroll: ScrollHandle,
    _read: Option<Task<()>>,
    _project: Option<Subscription>,
    _observed: Vec<Subscription>,
}

impl EventEmitter<ChecklistEvent> for ChecklistPanel {}
impl EventEmitter<PanelEvent> for ChecklistPanel {}

impl ChecklistPanel {
    pub fn new(
        build: Entity<BuildPanel>,
        pdf: Entity<PdfPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let field = |window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(window, cx).placeholder(t!("No limit")))
        };
        let counters = crate::status_counters::project_counters(cx);
        let words = crate::build::word_count::manuscript_words(cx);
        // A build that ends says how it went and leaves a new PDF: the disk
        // facts are read again.
        let mut built = build.read(cx).chip();
        let observed = vec![
            cx.observe(&build, move |this, build, cx| {
                let chip = build.read(cx).chip();
                let finished = matches!(built, crate::build_panel::ChipState::Running(_))
                    && !matches!(chip, crate::build_panel::ChipState::Running(_));
                built = chip;
                if finished {
                    this.refresh(cx);
                }
                cx.notify();
            }),
            cx.observe(&pdf, |_, _, cx| cx.notify()),
            cx.observe(&counters, |_, _, cx| cx.notify()),
            cx.observe(&words, |_, _, cx| cx.notify()),
        ];
        Self {
            focus_handle: cx.focus_handle(),
            project: None,
            build,
            pdf,
            facts: DiskFacts::default(),
            generation: 0,
            word_budget: field(window, cx),
            page_budget: field(window, cx),
            deadline: deadline::DeadlineState::default(),
            items: items::ItemsState::new(window, cx),
            scroll: ScrollHandle::new(),
            _read: None,
            _project: None,
            _observed: observed,
        }
    }

    pub fn set_project(
        &mut self,
        project: Entity<Project>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self._project = Some(cx.subscribe(&project, |this, _, event, cx| match event {
            ProjectEvent::FilesChanged(_) | ProjectEvent::ManifestChanged => this.refresh(cx),
            ProjectEvent::TreeChanged | ProjectEvent::GitChanged => {}
        }));
        let manifest = project.read(cx).manifest().clone();
        self.project = Some(project);
        self.facts = DiskFacts::default();
        self.deadline = deadline::DeadlineState::default();
        self.items.reset(window, cx);
        let words = manifest
            .word_budget
            .map(|budget| budget.to_string())
            .unwrap_or_default();
        let pages = manifest
            .page_budget
            .map(|budget| budget.to_string())
            .unwrap_or_default();
        self.word_budget
            .update(cx, |field, cx| field.set_value(words, window, cx));
        self.page_budget
            .update(cx, |field, cx| field.set_value(pages, window, cx));
        self.scroll
            .set_offset(gpui::point(gpui::px(0.), gpui::px(0.)));
        self.refresh(cx);
    }

    fn root(&self, cx: &App) -> Option<PathBuf> {
        Some(self.project.as_ref()?.read(cx).root().to_path_buf())
    }

    fn manifest<'a>(&self, cx: &'a App) -> Option<&'a lattice_core::models::ProjectManifest> {
        Some(self.project.as_ref()?.read(cx).manifest())
    }

    /// Read what needs the disk again, off the main thread; an answer for
    /// an older read or another project is dropped.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(project) = &self.project else { return };
        let (root, document, linked) = {
            let project = project.read(cx);
            let linked: Vec<String> = project
                .manifest()
                .submission_items
                .iter()
                .filter_map(|item| item.file.clone())
                .collect();
            (
                project.root().to_path_buf(),
                project.main_document().map(str::to_string),
                linked,
            )
        };
        self.generation += 1;
        let generation = self.generation;
        self._read = Some(cx.spawn(async move |this, cx| {
            let facts = cx
                .background_spawn(async move { read_facts(&root, document.as_deref(), &linked) })
                .await;
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.facts = facts;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// Whether the disk facts for the open project are read.
    pub(crate) fn facts_read(&self) -> bool {
        self.facts.review.is_some()
    }

    /// Type `words` into the word budget and press Save budgets.
    pub(crate) fn enter_word_budget(
        &mut self,
        words: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.word_budget.update(cx, |field, cx| {
            field.set_value(words.to_string(), window, cx)
        });
        self.save_budgets(cx);
    }

    fn save_budgets(&mut self, cx: &mut Context<Self>) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let word = model::parse_budget(&self.word_budget.read(cx).value());
        let page = model::parse_budget(&self.page_budget.read(cx).value());
        let settings = project::ManifestSettings {
            word_budget: Some(word),
            page_budget: Some(page),
            ..project::ManifestSettings::default()
        };
        self.write_manifest(
            move || project::update_manifest_settings(&root, settings),
            cx,
        );
    }

    fn save_deadline(&mut self, deadline: Option<ProjectDeadline>, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        self.write_manifest(move || project::set_deadline(&root, deadline), cx);
    }

    fn save_items(&mut self, items: Vec<SubmissionItem>, cx: &mut Context<Self>) {
        let Some(root) = self.root(cx) else { return };
        self.write_manifest(move || project::set_submission_items(&root, items), cx);
    }

    /// Write the manifest off the main thread, then have the project read
    /// it again; a refusal says why in a notice.
    fn write_manifest(
        &mut self,
        write: impl FnOnce() -> Result<lattice_core::models::ProjectManifest, String> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        cx.spawn(async move |_, cx| {
            let written = cx.background_spawn(async move { write() }).await;
            cx.update(|cx| match written {
                Ok(_) => project.update(cx, |project, cx| project.reload_manifest(cx)),
                Err(error) => crate::notices::error(t!("Submission checklist"), error, cx),
            });
        })
        .detach();
    }
}

/// The disk facts for the project at `root`.
fn read_facts(root: &std::path::Path, document: Option<&str>, linked: &[String]) -> DiskFacts {
    let unused = project::unused_symbols(root).ok();
    let body = document.map(|document| {
        let read = |path: &str| std::fs::read_to_string(root.join(path)).ok();
        match model::find_body_end(root, document, &read) {
            BodyEnd::None => Body::None,
            BodyEnd::Unread => Body::Unread,
            BodyEnd::Spans(spans) => match latex::body_pages(root, &spans) {
                Ok(Some(main_pages)) => Body::Resolved { main_pages },
                _ => Body::Unresolved,
            },
        }
    });
    let stats = linked
        .iter()
        .map(|path| {
            let stat = project::stat_file(root, path).map_or(
                FileStat {
                    exists: false,
                    mtime_ms: 0,
                },
                |stat| FileStat {
                    exists: stat.exists,
                    mtime_ms: stat.mtime_ms as u64,
                },
            );
            (path.clone(), stat)
        })
        .collect();
    DiskFacts {
        unused_labels: unused.as_ref().map_or(0, |unused| unused.labels.len()),
        unused_citations: unused.as_ref().map_or(0, |unused| unused.citations.len()),
        review: Some(latex::review_submission(root)),
        body,
        stats,
    }
}

impl Focusable for ChecklistPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for ChecklistPanel {
    fn panel_name(&self) -> &'static str {
        "ChecklistPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for ChecklistPanel {
    /// The tab's title, as Trellis names the tool (`trellis-titles.ts`).
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("Checklist").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl gpui::IntoElement {
        t!("Checklist")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}
