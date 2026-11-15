//! The LaTeX source's own lint in a `.tex` file's editor, run as the Tauri
//! app's editor runs `indexDiagnostics` (`latex-editor.ts`): 400 ms after
//! the last edit, and again when the project's index is read again, with
//! what the project knows (`lattice_editor::latex::lint`). The marks and
//! cards are `lattice_editor::latex::lint::marks`; this feeds them.
//!
//! What the lint reads besides the buffer: the index's citation keys, its
//! labels with the open file's unsaved ones standing in for its saved ones,
//! the project's files, the `\graphicspath` roots every TeX source sets
//! (the other sources read from disk in the background when the project's
//! files change, this one from the buffer), the root document, and, when
//! TexLab is not installed to report them itself, the labels and keys
//! nothing uses. A run reads the buffer once and lints off the main thread;
//! a later run supersedes it. What it reads of the other files also goes to
//! the editor's path and macro completion (`ProjectFacts`).

use std::{collections::HashSet, path::PathBuf, time::Duration};

use gpui::{App, AppContext as _, Context, Entity, Subscription, Task, WeakEntity};
use language::BufferEvent;
use lattice_editor::{
    LatticeEditor, TexlabService,
    index::ProjectIndex,
    latex::{
        definition::graphics_roots,
        lint::{
            LintIndex, index_lint,
            marks::{LintMarks, LintMarksEvent},
        },
        project_completions::{Facts, local_macros},
    },
};

use super::definition::project_paths;
use crate::{
    project::{Project, ProjectEvent},
    search::live_labels::{local_labels, merge_references},
};

/// How long after the last edit the lint runs (the Tauri linter's delay).
pub const LINT_DELAY: Duration = Duration::from_millis(400);

/// The lint of one `.tex` file's editor.
pub struct IndexLint {
    editor: WeakEntity<LatticeEditor>,
    project: Entity<Project>,
    marks: Entity<LintMarks>,
    /// What the completion reads of the other files.
    facts: Facts,
    path: String,
    root_document: String,
    unused: (HashSet<String>, HashSet<String>),
    generation: u64,
    _run: Option<Task<()>>,
    _read: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl IndexLint {
    /// Lint `path` (project-relative) in `editor`; `created` hears a card's
    /// Create file.
    pub fn attach(
        editor: &Entity<LatticeEditor>,
        project: &Entity<Project>,
        path: String,
        root_document: String,
        facts: Facts,
        created: impl Fn(String, &mut App) + 'static,
        cx: &mut App,
    ) -> Entity<Self> {
        let marks = LintMarks::attach(editor, cx);
        let buffer = editor.read(cx).buffer().clone();
        let index = project.read(cx).index().clone();
        cx.new(|cx: &mut Context<Self>| {
            let subscriptions = vec![
                cx.subscribe(&buffer, |this, _, event: &BufferEvent, cx| {
                    if matches!(event, BufferEvent::Edited { .. }) {
                        this.schedule(LINT_DELAY, cx);
                    }
                }),
                cx.observe(&index, |this, _: Entity<ProjectIndex>, cx| {
                    this.schedule(Duration::ZERO, cx)
                }),
                cx.subscribe(project, |this, _, event: &ProjectEvent, cx| {
                    if matches!(
                        event,
                        ProjectEvent::TreeChanged | ProjectEvent::FilesChanged(_)
                    ) {
                        this.read_project(cx);
                    }
                }),
                cx.subscribe(&marks, move |_, _, event: &LintMarksEvent, cx| {
                    let LintMarksEvent::CreateFile(path) = event;
                    created(path.clone(), cx);
                }),
            ];
            let mut this = Self {
                editor: editor.downgrade(),
                project: project.clone(),
                marks,
                facts,
                path,
                root_document,
                unused: Default::default(),
                generation: 0,
                _run: None,
                _read: None,
                _subscriptions: subscriptions,
            };
            this.read_project(cx);
            this
        })
    }

    /// The marks and cards, for the e2e checks.
    pub fn marks(&self) -> &Entity<LintMarks> {
        &self.marks
    }

    /// The file was renamed or moved within the project.
    pub fn set_path(&mut self, path: String, cx: &mut Context<Self>) {
        self.path = path;
        self.read_project(cx);
    }

    /// The manuscript's root document changed (`\input` paths are read from
    /// its folder).
    pub fn set_root_document(&mut self, root: String, cx: &mut Context<Self>) {
        if self.root_document != root {
            self.root_document = root;
            self.schedule(Duration::ZERO, cx);
        }
    }

    /// Read what the other sources set, and what nothing uses, then lint.
    fn read_project(&mut self, cx: &mut Context<Self>) {
        let project = self.project.read(cx);
        let folder: PathBuf = project.root().to_path_buf();
        let mut paths = Vec::new();
        project_paths(project.files(), &mut paths);
        let path = self.path.clone();
        let others: Vec<String> = paths
            .iter()
            .filter(|other| other.ends_with(".tex") && **other != path)
            .cloned()
            .collect();
        let texlab = TexlabService::available();
        self.facts.borrow_mut().paths = paths;
        let read = cx.background_spawn(async move {
            let sources: Vec<String> = others
                .iter()
                .filter_map(|other| lattice_core::project::read_file(&folder, other).ok())
                .collect();
            let roots = graphics_roots(sources.iter().map(String::as_str));
            let macros = local_macros(sources.iter().map(String::as_str));
            let unused = (!texlab)
                .then(|| lattice_core::project::unused_symbols(&folder).ok())
                .flatten()
                .map(|unused| {
                    (
                        unused.labels.into_iter().collect(),
                        unused.citations.into_iter().collect(),
                    )
                })
                .unwrap_or_default();
            (roots, macros, unused)
        });
        self._read = Some(cx.spawn(async move |this, cx| {
            let (roots, macros, unused) = read.await;
            this.update(cx, |this, cx| {
                {
                    let mut facts = this.facts.borrow_mut();
                    facts.graphics_roots = roots;
                    facts.macros = macros;
                }
                this.unused = unused;
                this.schedule(Duration::ZERO, cx);
            })
            .ok();
        }));
    }

    /// What the lint is given besides the text.
    fn lint_index(&self, text: &str, cx: &App) -> LintIndex {
        let index = self.project.read(cx).index().read(cx);
        let facts = self.facts.borrow();
        let mut roots = facts.graphics_roots.clone();
        for root in graphics_roots([text]) {
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        LintIndex {
            citation_keys: index
                .citations()
                .iter()
                .map(|citation| citation.key.clone())
                .collect(),
            references: merge_references(
                index.references(),
                &self.path,
                local_labels(&self.path, text),
            ),
            pending: index.is_first_read_pending(),
            unused_labels: self.unused.0.clone(),
            unused_citations: self.unused.1.clone(),
            project_paths: facts.paths.clone(),
            graphics_roots: roots,
            root_path: self.root_document.clone(),
        }
    }

    fn schedule(&mut self, delay: Duration, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        // Moved to a file that is no TeX source: nothing to lint.
        if !lattice_editor::latex::is_tex_source(std::path::Path::new(&self.path)) {
            self._run = None;
            if let Some(editor) = self.editor.upgrade() {
                let snapshot = editor.read(cx).buffer().read(cx).snapshot();
                self.marks
                    .update(cx, |marks, cx| marks.show(Vec::new(), &snapshot, cx));
            }
            return;
        }
        self._run = Some(cx.spawn(async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            let Ok(Some((snapshot, text, index, path))) = this.update(cx, |this, cx| {
                let editor = this.editor.upgrade()?;
                let snapshot = editor.read(cx).buffer().read(cx).snapshot();
                let text = snapshot.text();
                let index = this.lint_index(&text, cx);
                Some((snapshot, text, index, this.path.clone()))
            }) else {
                return;
            };
            let lints = cx
                .background_spawn(async move { index_lint(&text, &index, &path) })
                .await;
            this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.marks
                        .update(cx, |marks, cx| marks.show(lints, &snapshot, cx));
                }
            })
            .ok();
        }));
    }
}

impl super::EditorPanel {
    /// Put the LaTeX features that read the project on a `.tex` file's
    /// editor, from its opening or once a move makes it one: the cards and
    /// completion (`latex::attach`) and TexLab's diagnostics and completions.
    /// The facts the completion lists go to the lint
    /// ([`attach_index_lint`](Self::attach_index_lint)), which is put on
    /// after the spell check, as hover cards stack in the order put on.
    pub(super) fn attach_tex(&mut self, cx: &mut Context<Self>) -> Option<Facts> {
        if self.diagnostics.is_some() || !lattice_editor::latex::is_tex_source(&self.path) {
            return None;
        }
        let facts = Facts::default();
        let index = self.project.read(cx).index().clone();
        self.lattice.update(cx, |lattice, _| {
            lattice_editor::latex::attach(lattice, &index, facts.clone())
        });
        let texlab = self.project.read(cx).texlab().clone();
        self.diagnostics = Some(
            lattice_editor::latex::diagnostics::TexlabDiagnostics::attach(
                &self.lattice,
                texlab,
                self.relative.clone(),
                cx,
            ),
        );
        Some(facts)
    }

    /// Lint the `.tex` file with the `facts` [`attach_tex`](Self::attach_tex)
    /// made. A card's Create file goes to the window.
    pub(super) fn attach_index_lint(&mut self, facts: Facts, cx: &mut Context<Self>) {
        let panel = cx.weak_entity();
        let created = move |path: String, cx: &mut App| {
            panel
                .update(cx, |_, cx| {
                    cx.emit(super::EditorPanelEvent::CreateFile { path })
                })
                .ok();
        };
        self.index_lint = Some(IndexLint::attach(
            &self.lattice,
            &self.project,
            self.relative.clone(),
            self.latex_root.clone(),
            facts,
            created,
            cx,
        ));
    }

    /// The `.tex` file's lint, when it has one.
    pub fn index_lint(&self) -> Option<&Entity<IndexLint>> {
        self.index_lint.as_ref()
    }
}
