//! A plugin command's place in the window and its actions
//! (docs/plugins.md, "Actions"): the project it runs in, read from the
//! editor in front, and each verb done through the app's own path. A
//! citation goes in at the caret of the LaTeX source in front, joining the
//! citation the caret is in; a bibliography entry is shown and written only
//! when the writer confirms it, through the project's history like every
//! citation edit; a file opens at its line; a link opens in the browser;
//! text goes to the clipboard.

use editor::ToOffset as _;
use gpui::{App, AppContext as _, ClipboardItem, Context, Window};
use lattice_core::plugins::protocol::{Cursor, Selection};
use lattice_core::plugins::{ActionKind, Position, ProjectInput};
use lattice_i18n::t;

use super::Shell;
use crate::{
    confirm::{self, Confirm},
    notices,
    plugins::actions::{self as bib, BibChange},
};

/// What an action left behind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Performed {
    /// Done, or refused with a notice: the palette closes.
    Done,
    /// A confirmation is up (or about to be): the palette stays.
    Confirming,
}

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

    /// Do `action` for the writer.
    pub(crate) fn perform_plugin_action(
        &mut self,
        action: ActionKind,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Performed {
        match action {
            ActionKind::InsertCitation { key } => {
                self.insert_plugin_citation(&key, window, cx);
                Performed::Done
            }
            ActionKind::AddBibEntry { bibtex, file } => {
                self.confirm_bib_change(BibChange::Add { bibtex }, file, window, cx);
                Performed::Confirming
            }
            ActionKind::ReplaceBibEntry { key, bibtex, file } => {
                self.confirm_bib_change(BibChange::Replace { key, bibtex }, file, window, cx);
                Performed::Confirming
            }
            ActionKind::Reveal { file, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(file), line, window, cx);
                }
                Performed::Done
            }
            ActionKind::OpenUrl { url } => {
                cx.open_url(&url);
                Performed::Done
            }
            ActionKind::Copy { text } => {
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                notices::copied(t!("Copied"), cx);
                Performed::Done
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

    /// Show the entry (or the change to one) and write it once the writer
    /// confirms: the open editors are saved first, the text is read and the
    /// change worked out off the main thread, and the write only lands on
    /// the text the writer saw.
    fn confirm_bib_change(
        &mut self,
        change: BibChange,
        file: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(root) = self.root(cx) else {
            return;
        };
        let saved = self.save_editors(cx);
        cx.spawn_in(window, async move |this, cx| {
            if !saved.await {
                cx.update(|_, cx| {
                    notices::error(t!("Bibliography"), t!("Save the open file first."), cx)
                })
                .ok();
                return;
            }
            let read_root = root.clone();
            let worked_out = cx
                .background_spawn(async move {
                    let relative = match file {
                        Some(file) => file,
                        None => lattice_core::project::citation_bibliography(&read_root)?.path,
                    };
                    let path = read_root.join(&relative);
                    let before = std::fs::read_to_string(&path).unwrap_or_default();
                    let plan = bib::plan(&before, &change)?;
                    Ok::<_, String>((relative, before, plan))
                })
                .await;
            this.update_in(cx, |_, _, cx| match worked_out {
                Ok((relative, before, plan)) => ask_bib_change(root, relative, before, plan, cx),
                Err(error) => notices::error(t!("Bibliography"), error, cx),
            })
            .ok();
        })
        .detach();
    }

    /// The bibliography changed on disk: the editors and Papers read it again.
    pub(super) fn bibliography_written(&mut self, cx: &mut Context<Self>) {
        for editor in self.open_editors() {
            editor.update(cx, |editor, cx| editor.check_disk(cx));
        }
        self.papers.update(cx, |papers, cx| papers.reload(cx));
    }
}

fn ask_bib_change(
    root: std::path::PathBuf,
    relative: String,
    before: String,
    plan: bib::BibPlan,
    cx: &mut Context<Shell>,
) {
    let (title, body, answer) = match &plan.replaced {
        None => (
            t!("Add this entry to {0}?", relative),
            plan.after[before.trim_end().len()..].trim().to_string(),
            t!("Add entry"),
        ),
        Some(replaced) => {
            let entry_after = entry_text(&plan.after, &plan.key).unwrap_or_default();
            (
                t!("Update “{0}” in {1}?", plan.key, relative),
                bib::diff_lines(replaced, &entry_after),
                t!("Update entry"),
            )
        }
    };
    let shell = cx.entity().downgrade();
    let key = plan.key.clone();
    let after = plan.after.clone();
    confirm::ask(
        Confirm::new(title)
            .body(body)
            .confirm_label(answer)
            .on_confirm(move |_, cx| {
                let (root, relative, before, after, key) = (
                    root.clone(),
                    relative.clone(),
                    before.clone(),
                    after.clone(),
                    key.clone(),
                );
                let shell = shell.clone();
                let label = format!("Edit {relative}");
                let shown = relative.clone();
                let write = cx.background_spawn(async move {
                    lattice_core::project::apply_citation_transaction_checked(
                        &root,
                        &label,
                        vec![(relative, before, after)],
                    )
                });
                cx.spawn(async move |cx| {
                    let written = write.await;
                    cx.update(|cx| match written {
                        Ok(_) => {
                            shell
                                .update(cx, |shell, cx| shell.bibliography_written(cx))
                                .ok();
                            notices::show(
                                notices::Notice::new(
                                    lattice_ui::components::ToastLevel::Success,
                                    t!("Saved “{0}” in {1}", key, shown),
                                ),
                                cx,
                            );
                        }
                        Err(error) => notices::error(t!("Bibliography"), error, cx),
                    });
                })
                .detach();
            }),
        cx,
    );
}

/// The text of the entry `key` in `text`.
fn entry_text(text: &str, key: &str) -> Option<String> {
    let parsed = lattice_core::bib_document::parse(text).ok()?;
    let entry = parsed
        .entries
        .iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(key))?;
    Some(text[entry.from..entry.to].to_string())
}
