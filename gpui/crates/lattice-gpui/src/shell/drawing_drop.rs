//! A drawing dropped from Finder onto a LaTeX editor, as the Tauri app takes
//! it (`dropDrawingFile`, `dropDrawingAt`): one `.svg`, `.drawio` or `.dio`
//! is copied into `figures/` (or used where it lies in the project) and made
//! an editable figure by lattice-core (`import_drawing_path`: Inkscape or
//! draw.io renders it beside its source, with an entry file whose first line
//! names the drawing, so Edit figure source finds it), then its `\input` goes
//! in at the line under the pointer, as a whole float on an empty body line,
//! with what a root document's preamble lacks (`insert/editable_figure.rs`).
//!
//! The figure goes into the editor it was dropped on (the Tauri app uses the
//! LaTeX editor last focused, the one under the pointer when it is there).
//! Several drawings, or one dropped on a Markdown editor, take the usual
//! figure path.

use std::path::{Path, PathBuf};

use gpui::{AppContext as _, Context, WeakEntity, Window};
use lattice_core::project as core_project;
use lattice_i18n::t;

use super::Shell;
use crate::{editor_panel::EditorPanel, insert::editable_figure::figure_changes, notices};

/// Whether `path` is a drawing lattice-core can render (`isConvertibleDrawing`).
pub(super) fn is_drawing(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "svg" | "drawio" | "dio"
            )
        })
}

/// Whether a drop of `paths` on `editor` is one drawing made an editable
/// figure there: exactly one drawing, on a LaTeX source.
pub(super) fn takes_drawing(paths: &[PathBuf], editor: &EditorPanel) -> bool {
    matches!(paths, [path] if is_drawing(path))
        && editor.relative().to_ascii_lowercase().ends_with(".tex")
}

impl Shell {
    /// Make the dropped `drawing` an editable figure, and put it into
    /// `editor` at `at` (the offset under the pointer), else at its caret.
    pub(super) fn drop_drawing(
        &mut self,
        drawing: PathBuf,
        editor: WeakEntity<EditorPanel>,
        at: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(project) = self.project.clone() else {
            return;
        };
        let root = project.read(cx).root().to_path_buf();
        let dropped = drawing.to_string_lossy().into_owned();
        let made = cx.background_spawn(async move {
            core_project::import_drawing_path(&root, &dropped)
        });
        cx.spawn_in(window, async move |this, cx| {
            let made = made.await;
            this.update_in(cx, |this, window, cx| {
                if let Some(project) = &this.project {
                    project.update(cx, |project, cx| project.entries_changed(cx));
                }
                let figure = match made {
                    Ok(figure) => figure,
                    Err(error) => {
                        notices::error(t!("Could not update the figure"), error, cx);
                        return;
                    }
                };
                // The editor may have closed meanwhile: the files stay.
                let Some(editor) = editor.upgrade() else {
                    return;
                };
                let (text, caret) = editor.read(cx).text_and_caret(cx);
                let at = at.unwrap_or(caret).min(text.len());
                let at = (0..=at).rev().find(|at| text.is_char_boundary(*at)).unwrap_or(0);
                let changes =
                    figure_changes(&text, at, at, &figure.directory, &figure.entry, &figure.packages);
                // The preamble's lines first, last offset first: each lies
                // before the include, which then moves down by what they add.
                let mut shift = 0;
                let mut preamble = changes.preamble.clone();
                preamble.sort_by_key(|edit| std::cmp::Reverse(edit.from));
                editor.update(cx, |editor, cx| {
                    for edit in &preamble {
                        shift += edit.insert.len() - (edit.to - edit.from);
                        let end = edit.from + edit.insert.len();
                        editor.replace_range(edit.from, edit.to, &edit.insert, end, window, cx);
                    }
                    let from = changes.body.from + shift;
                    let to = changes.body.to + shift;
                    editor.replace_range(
                        from,
                        to,
                        &changes.body.insert,
                        from + changes.caret,
                        window,
                        cx,
                    );
                });
                this.active_editor = Some(editor.downgrade());
                window.focus(&gpui::Focusable::focus_handle(editor.read(cx), cx), cx);
                if !changes.unplaced.is_empty() {
                    let lines = changes.unplaced.join(" ");
                    notices::info(
                        t!("Figures"),
                        t!("Add to the main document's preamble: {lines}", lines = lines),
                        cx,
                    );
                }
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drawings_are_svg_drawio_and_dio() {
        for name in ["a.svg", "b.DRAWIO", "c.dio"] {
            assert!(is_drawing(Path::new(name)), "{name}");
        }
        for name in ["a.png", "b.pdf", "c"] {
            assert!(!is_drawing(Path::new(name)), "{name}");
        }
    }
}
