//! Figures and tables into the editor in front (`crate::insert`), as the
//! Tauri app's canvas inserts them (`document-canvas.tsx`):
//!
//! - Insert table (the palette, for a LaTeX source) opens the table
//!   generator on the editor's text and caret; what it writes lands only
//!   while that editor still holds the text it was opened on.
//! - A figure goes in at the start of the caret's line: in a LaTeX file
//!   after lattice-core prepares it for LaTeX (an SVG as PDF, a WebP as PNG)
//!   and the Insert figure dialog takes its options, in a Markdown file at
//!   once as an image linked from the file.
//! - ⌘V with an image in the editor, and the palette's Paste clipboard image
//!   as figure, save the image into `figures/` and insert it so.

use gpui::{AppContext as _, Context, Entity, Subscription, WeakEntity, Window, actions};

use super::Shell;
use crate::{
    editor_panel::EditorPanel,
    insert::{
        figure::{latex_figures, markdown_assets},
        figure_dialog::{FigureDialogEvent, FigureInsertDialog},
        table_dialog::{TableEvent, TableGenerator},
    },
    notices,
};

actions!(lattice, [InsertTable, PasteImageAsFigure]);

/// The figure dialog or the table generator, while one is open, with the
/// editor it writes into.
#[derive(Default)]
pub(crate) struct Inserts {
    pub(crate) figure: Option<OpenFigure>,
    pub(crate) table: Option<OpenTable>,
}

pub(crate) struct OpenFigure {
    pub(crate) dialog: Entity<FigureInsertDialog>,
    editor: WeakEntity<EditorPanel>,
    /// The start of the caret's line when the figures were asked for.
    position: usize,
    _events: Subscription,
}

pub(crate) struct OpenTable {
    pub(crate) sheet: Entity<TableGenerator>,
    editor: WeakEntity<EditorPanel>,
    /// The text the generator was opened on.
    source: String,
    _events: Subscription,
}

impl Inserts {
    pub(crate) fn open(&self) -> bool {
        self.figure.is_some() || self.table.is_some()
    }
}

fn is_latex(editor: &EditorPanel) -> bool {
    editor.relative().to_ascii_lowercase().ends_with(".tex")
}

fn is_markdown(editor: &EditorPanel) -> bool {
    editor.relative().to_ascii_lowercase().ends_with(".md")
}

/// The offset of the start of the line `offset` is on.
fn line_start(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    text[..offset].rfind('\n').map_or(0, |at| at + 1)
}

impl Shell {
    /// Whether the editor in front is a LaTeX source (the table and figure
    /// commands' `latexSource`).
    pub(crate) fn latex_source_in_front(&self, cx: &gpui::App) -> bool {
        self.active_editor()
            .is_some_and(|editor| is_latex(editor.read(cx)))
    }

    /// Insert table: the generator over the window, on the editor in front.
    pub(crate) fn open_table_generator(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self
            .active_editor()
            .filter(|editor| is_latex(editor.read(cx)))
        else {
            return;
        };
        let (source, caret) = editor.read(cx).text_and_caret(cx);
        let sheet = cx.new(|cx| TableGenerator::new(source.clone(), caret, window, cx));
        let events = cx.subscribe_in(&sheet, window, |this, _, event, window, cx| {
            this.on_table_event(event, window, cx)
        });
        self.inserts.table = Some(OpenTable {
            sheet,
            editor: editor.downgrade(),
            source,
            _events: events,
        });
        cx.notify();
    }

    fn on_table_event(&mut self, event: &TableEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            TableEvent::Close => {
                self.inserts.table = None;
                self.focus_front(window, cx);
            }
            TableEvent::Apply { from, to, insert } => {
                let Some(open) = &self.inserts.table else {
                    return;
                };
                let editor = open.editor.upgrade();
                let unchanged = editor
                    .as_ref()
                    .is_some_and(|editor| editor.read(cx).text_and_caret(cx).0 == open.source);
                let (Some(editor), true) = (editor, unchanged) else {
                    open.sheet.update(cx, |sheet, cx| sheet.failed(cx));
                    return;
                };
                let caret = from + insert.find("\\begin").unwrap_or(0);
                let (from, to, insert) = (*from, *to, insert.clone());
                self.inserts.table = None;
                editor.update(cx, |editor, cx| {
                    editor.replace_range(from, to, &insert, caret, window, cx)
                });
            }
        }
        cx.notify();
    }

    /// Insert the project's `paths` into the editor in front, at the start
    /// of the caret's line (`insertFigures`).
    pub(crate) fn insert_figures(
        &mut self,
        paths: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(editor) = self.active_editor() else {
            return;
        };
        if paths.is_empty() {
            return;
        }
        let (text, caret) = editor.read(cx).text_and_caret(cx);
        let position = line_start(&text, caret);
        if is_markdown(editor.read(cx)) {
            let relative = editor.read(cx).relative().to_string();
            let edit = markdown_assets(&text, position, &paths, &relative);
            editor.update(cx, |editor, cx| {
                editor.replace_range(
                    position,
                    position,
                    &edit.text,
                    position + edit.cursor,
                    window,
                    cx,
                )
            });
            return;
        }
        if !is_latex(editor.read(cx)) {
            return;
        }
        let Some(root) = self.root(cx) else { return };
        let prepared = cx.background_spawn(async move {
            let mut out = Vec::new();
            let mut errors = Vec::new();
            for path in paths {
                match lattice_core::project::prepare_latex_figure(&root, &path) {
                    Ok(prepared) => out.push((prepared != path, prepared)),
                    Err(error) => errors.push(error),
                }
            }
            (out, errors)
        });
        let editor = editor.downgrade();
        cx.spawn_in(window, async move |this, cx| {
            let (prepared, errors) = prepared.await;
            this.update_in(cx, |this, window, cx| {
                for error in errors {
                    notices::error(error, "", cx);
                }
                if prepared.iter().any(|(converted, _)| *converted)
                    && let Some(project) = &this.project
                {
                    project.update(cx, |project, cx| project.entries_changed(cx));
                }
                let paths: Vec<String> = prepared.into_iter().map(|(_, path)| path).collect();
                if !paths.is_empty() {
                    this.open_figure_dialog(paths, editor, position, window, cx);
                }
            })
            .ok();
        })
        .detach();
    }

    fn open_figure_dialog(
        &mut self,
        paths: Vec<String>,
        editor: WeakEntity<EditorPanel>,
        position: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let dialog = cx.new(|cx| FigureInsertDialog::new(paths, window, cx));
        let events = cx.subscribe_in(&dialog, window, |this, dialog, event, window, cx| {
            match event {
                FigureDialogEvent::Close => {}
                FigureDialogEvent::Insert(options) => {
                    let paths = dialog.read(cx).paths().to_vec();
                    if let Some(open) = &this.inserts.figure
                        && let Some(editor) = open.editor.upgrade()
                    {
                        let position = open.position;
                        let text = editor.read(cx).text_and_caret(cx).0;
                        // The text may have changed meanwhile: the line's start
                        // is clamped to it, as a stale position is in CodeMirror.
                        let position = line_start(&text, position);
                        let edit = latex_figures(&text, position, &paths, options);
                        editor.update(cx, |editor, cx| {
                            editor.replace_range(
                                position,
                                position,
                                &edit.text,
                                position + edit.cursor,
                                window,
                                cx,
                            )
                        });
                    }
                }
            }
            this.inserts.figure = None;
            if matches!(event, FigureDialogEvent::Close) {
                this.focus_front(window, cx);
            }
            cx.notify();
        });
        self.inserts.figure = Some(OpenFigure {
            dialog,
            editor,
            position,
            _events: events,
        });
        cx.notify();
    }

    /// The palette's Paste clipboard image as figure (`pasteClipboardImage`,
    /// for a `.tex` file) and ⌘V with an image in a LaTeX or Markdown
    /// editor (`pasteImageFile`): saved into `figures/`, then inserted.
    pub(crate) fn paste_image_as_figure(
        &mut self,
        from_editor: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let front = self.active_editor().filter(|editor| {
            let editor = editor.read(cx);
            is_latex(editor) || (from_editor && is_markdown(editor))
        });
        if self.project.is_none() || front.is_none() {
            notices::error(t_open_tex(), "", cx);
            return;
        }
        self.save_clipboard_image("figures".into(), window, cx, |this, path, window, cx| {
            this.insert_figures(vec![path], window, cx)
        });
    }
}

fn t_open_tex() -> String {
    lattice_i18n::t!("Open a .tex file before pasting a figure.").into()
}

#[cfg(test)]
mod tests {
    use super::line_start;

    #[test]
    fn a_figure_goes_in_at_the_start_of_the_carets_line() {
        let text = "one\ntwo three\n";
        assert_eq!(line_start(text, 0), 0);
        assert_eq!(line_start(text, 7), 4);
        assert_eq!(line_start(text, 4), 4);
        assert_eq!(line_start(text, 99), text.len());
    }
}
