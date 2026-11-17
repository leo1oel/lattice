//! A plugin command's place in the window and its actions
//! (docs/plugins.md, "Actions"): the project it runs in, read from the
//! editor in front, and each verb done through the app's own path. A
//! citation goes in at the caret of the LaTeX source in front, joining the
//! citation the caret is in; a bibliography entry, which the palette shows
//! first, is written once the writer confirms it, through the project's
//! history like every citation edit; a file opens at its line; a link opens in the browser;
//! text goes to the clipboard.

use editor::ToOffset as _;
use gpui::{App, AppContext as _, ClipboardItem, Context, Task, Window};
use lattice_core::plugins::protocol::{Cursor, Selection};
use lattice_core::plugins::{ActionKind, Position, ProjectInput};
use lattice_i18n::t;

use super::Shell;
use crate::{notices, plugins::actions as bib};

/// 1-based line and column (in characters) of byte `offset` of `text`.
fn position(text: &str, offset: usize) -> Position {
    let before = &text[..offset.min(text.len())];
    let line_start = before.rfind('\n').map_or(0, |at| at + 1);
    Position {
        line: before.matches('\n').count() as u32 + 1,
        column: before[line_start..].chars().count() as u32 + 1,
    }
}

impl Shell {
    /// The project a plugin command runs in: its root and name, the main
    /// document, and the file, selection and caret of the editor in front.
    pub(crate) fn plugin_project(&self, cx: &App) -> Option<ProjectInput> {
        let project = self.project.as_ref()?.read(cx);
        let root = project.root().to_path_buf();
        let mut input = ProjectInput {
            name: root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            main_document: project.main_document().map(str::to_string),
            root,
            ..Default::default()
        };
        let Some(editor) = self.active_editor() else {
            return Some(input);
        };
        let editor = editor.read(cx);
        let file = editor.relative().replace('\\', "/");
        let (text, tail, head) = {
            let view = editor.editor().read(cx);
            let snapshot = view.buffer().read(cx).snapshot(cx);
            let selection = view.selections.newest_anchor();
            (
                snapshot.text(),
                selection.tail().to_offset(&snapshot).0,
                selection.head().to_offset(&snapshot).0,
            )
        };
        let (from, to) = (tail.min(head), tail.max(head));
        if from < to && text.is_char_boundary(from) && text.is_char_boundary(to) {
            input.selection = Some(Selection {
                text: text[from..to].to_string(),
                file: file.clone(),
                from: position(&text, from),
                to: position(&text, to),
            });
        }
        input.cursor = Some(Cursor {
            file: file.clone(),
            position: position(&text, head),
        });
        input.active_file = Some(file);
        Some(input)
    }

    /// Do `action` for the writer, once the palette has closed. The
    /// bibliography writes are the palette's to ask about first
    /// (`plugin_bib_target`, `write_plugin_bib`).
    pub(crate) fn perform_plugin_action(
        &mut self,
        action: ActionKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            ActionKind::InsertCitation { key } => self.insert_plugin_citation(&key, window, cx),
            ActionKind::AddBibEntry { .. } | ActionKind::ReplaceBibEntry { .. } => {}
            ActionKind::Reveal { file, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(file), line, window, cx);
                }
            }
            ActionKind::OpenUrl { url } => cx.open_url(&url),
            ActionKind::Copy { text } => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                notices::copied(t!("Copied"), cx);
            }
        }
    }

    fn insert_plugin_citation(&mut self, key: &str, window: &mut Window, cx: &mut Context<Self>) {
        let editor = self
            .active_editor()
            .filter(|_| self.latex_source_in_front(cx));
        let Some(editor) = editor else {
            notices::warning(t!("Open a LaTeX file to insert a citation"), cx);
            return;
        };
        editor.update(cx, |editor, cx| {
            let (text, caret) = editor.text_and_caret(cx);
            match crate::papers::drag::citation::latex_citation_at_caret(&text, caret, key) {
                Some(edit) => {
                    let caret = edit.range.start + edit.insert.len();
                    editor.replace_range(
                        edit.range.start,
                        edit.range.end,
                        &edit.insert,
                        caret,
                        window,
                        cx,
                    );
                }
                None => notices::info(t!("Already cited here"), key.to_string(), cx),
            }
        });
    }

    /// Where a bibliography action writes, and for an update the entry as
    /// it is now: the plugin's file, else the project's bibliography, read
    /// off the main thread. A problem comes back as the words to show.
    pub(crate) fn plugin_bib_target(
        &self,
        file: Option<String>,
        replacing: Option<String>,
        cx: &App,
    ) -> Task<BibTarget> {
        let Some(root) = self.root(cx) else {
            return Task::ready(BibTarget::refused(String::new(), no_bibliography()));
        };
        cx.background_spawn(async move {
            let found = file.or_else(|| {
                lattice_core::project::citation_bibliography(&root)
                    .ok()
                    .map(|bibliography| bibliography.path)
            });
            let Some(file) = found else {
                return BibTarget::refused(String::new(), no_bibliography());
            };
            let Some(key) = replacing else {
                return BibTarget {
                    file,
                    before: None,
                    error: None,
                };
            };
            let source = match std::fs::read_to_string(root.join(&file)) {
                Ok(source) => source,
                Err(error) => {
                    return BibTarget::refused(file, crate::host_errors::text(&error.to_string()));
                }
            };
            match bib::find_entry(&source, &key) {
                Ok(Some((text, _, _))) => BibTarget {
                    file,
                    before: Some(text),
                    error: None,
                },
                Ok(None) => {
                    let error = t!(
                        "There is no entry “{key}” in {file}.",
                        key = key,
                        file = file
                    );
                    BibTarget::refused(file, error)
                }
                Err(error) => BibTarget::refused(file, error),
            }
        })
    }

    /// Write a bibliography change the writer confirmed: the open editors
    /// saved first, the change worked out on the file as it is now, and the
    /// write made through the project's history like every citation edit.
    pub(crate) fn write_plugin_bib(
        &mut self,
        file: String,
        change: BibChange,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), String>> {
        let Some(root) = self.root(cx) else {
            return Task::ready(Err(no_bibliography()));
        };
        let saved = self.save_editors(cx);
        cx.spawn_in(window, async move |this, cx| {
            if !saved.await {
                return Err(t!("Save the open file first.").to_string());
            }
            let written = cx
                .background_spawn(async move {
                    let before = std::fs::read_to_string(root.join(&file)).unwrap_or_default();
                    let after = match &change {
                        BibChange::Add { bibtex } => bib::append_entry(&before, bibtex.trim())?,
                        BibChange::Replace { key, bibtex } => {
                            bib::replace_entry(&before, key, bibtex)?
                        }
                    };
                    let label = format!("Edit {file}");
                    lattice_core::project::apply_citation_transaction_checked(
                        &root,
                        &label,
                        vec![(file, before, after)],
                    )
                    .map(|_| ())
                    .map_err(|error| crate::host_errors::text(&error.to_string()))
                })
                .await;
            if written.is_ok() {
                this.update(cx, |shell, cx| shell.bibliography_written(cx))
                    .ok();
            }
            written
        })
    }

    /// The bibliography changed on disk: the editors and Papers read it again.
    pub(super) fn bibliography_written(&mut self, cx: &mut Context<Self>) {
        for editor in self.open_editors() {
            editor.update(cx, |editor, cx| editor.check_disk(cx));
        }
        self.papers.update(cx, |papers, cx| papers.reload(cx));
    }
}

fn no_bibliography() -> String {
    t!("This project has no bibliography to add to.").to_string()
}

/// A bibliography change a plugin proposed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BibChange {
    Add { bibtex: String },
    Replace { key: String, bibtex: String },
}

/// Where a bibliography change goes (`Shell::plugin_bib_target`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct BibTarget {
    /// Relative to the project root.
    pub file: String,
    /// The entry an update replaces, as it is now.
    pub before: Option<String>,
    /// Why it can't be done.
    pub error: Option<String>,
}

impl BibTarget {
    fn refused(file: String, error: String) -> Self {
        Self {
            file,
            before: None,
            error: Some(error),
        }
    }
}
