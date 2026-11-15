//! A `.tex` file's Source and Visual views, as the Tauri app has them
//! (`src/editor/latex/latex-view-choice.ts`, `latex-visual-switch.ts`): one
//! choice for every `.tex` file, shared by every window and remembered
//! (Settings' `latex_view`, the Tauri app's `lattice.latex-view.v1`), Source
//! until the writer picks Visual. The switch rides in the panel's strip and
//! its ⋯ menu repeats it (`source_chrome.rs`, `strip.rs`).
//!
//! In the Tauri app Visual is the same CodeMirror editor drawn as a page, so
//! the text, its history and the caret carry across the switch. Here Visual
//! is that editor in a webview island (`crate::structured::latex_visual`),
//! made the first time the view is shown and kept while the panel lives,
//! over the panel's buffer as a Markdown file's visual editor is
//! (`markdown_view.rs`): an edit lands as the minimal change from the text it
//! was made against, undo and redo are the buffer's, so either view steps
//! back through the other's edits, and the island's caret is the status
//! bar's. The caret crosses the switch by line, the island landing on the
//! source's and the source on the island's.

use editor::{SelectionEffects, scroll::Autoscroll};
use gpui::{AppContext as _, Context, Entity, Focusable as _, Window};
use language::Point;
use lattice_settings::LatexView;

use super::EditorPanel;
use crate::structured::StructuredDocument;

/// The Visual view's island, once shown, and whether the panel is its
/// group's displayed tab.
#[derive(Default)]
pub(super) struct LatexViews {
    document: Option<Entity<StructuredDocument>>,
    shown: bool,
    /// The view the panel last drew, so a change of the shared choice
    /// carries the caret across.
    drawn: Option<LatexView>,
    /// The manuscript's outline, as the shell last read it, for the rail
    /// over the page (`latex_visual_events.rs`).
    pub(super) headings: Option<std::rc::Rc<[crate::outline::Heading]>>,
}

/// Whether `path` is a LaTeX document, which has a Visual form beside its
/// source (`isLatexDocumentPath`: packages and classes are code).
pub fn is_latex_document(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("tex"))
}

/// The writer's choice for `.tex` documents.
pub fn chosen_latex_view(cx: &gpui::App) -> LatexView {
    crate::settings::get(cx).latex_view
}

/// Choose how `.tex` documents draw; every open one follows, in every
/// window, and the choice is remembered.
pub fn choose_latex_view(view: LatexView, cx: &mut gpui::App) {
    if chosen_latex_view(cx) != view {
        crate::settings::update(cx, |settings| settings.latex_view = view);
    }
}

impl EditorPanel {
    /// The view this `.tex` document is shown in; `None` for other files.
    pub fn latex_view(&self, cx: &gpui::App) -> Option<LatexView> {
        is_latex_document(&self.path).then(|| chosen_latex_view(cx))
    }

    /// The document shows its Visual view, and the island is there to show.
    pub(super) fn shows_latex_visual(&self, cx: &gpui::App) -> bool {
        self.latex_view(cx) == Some(LatexView::Visual) && self.latex.document.is_some()
    }

    /// The Visual view's island, once the view has been shown.
    pub fn latex_visual_document(&self) -> Option<&Entity<StructuredDocument>> {
        self.latex.document.as_ref()
    }

    fn new_latex_document(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<StructuredDocument> {
        let project = self.project.clone();
        let relative = self.relative.clone();
        let source = self.buffer.read(cx).text();
        let dictionaries = super::spelling::dictionary_store(cx);
        let document = cx.new(|cx| {
            StructuredDocument::latex_visual(&project, relative, source, dictionaries, window, cx)
        });
        // Edits, undo, redo and the caret are a Markdown visual editor's;
        // the rest is the page's own (`latex_visual_events.rs`).
        self._subscriptions
            .push(cx.subscribe_in(&document, window, Self::on_latex_document));
        document
    }

    /// Follow the shared choice: make the island the first time Visual
    /// shows, show it only while the panel is displayed in Visual, and carry
    /// the caret and the keyboard across a switch.
    pub(super) fn sync_latex_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(view) = self.latex_view(cx) else {
            return;
        };
        let visual = view == LatexView::Visual;
        if visual && self.latex.document.is_none() && self.latex.shown {
            let document = self.new_latex_document(window, cx);
            self.latex.document = Some(document);
            self.forward_latex_context(cx);
        }
        let Some(document) = self.latex.document.clone() else {
            self.latex.drawn = Some(view);
            return;
        };
        let switched = self.latex.drawn.is_some_and(|drawn| drawn != view);
        let had_focus = self.holds_focus(window, cx);
        let active = visual && self.latex.shown;
        document.update(cx, |document, cx| {
            // A hidden island was not sent the buffer's edits.
            if active {
                document.set_source(self.buffer.read(cx).text(), cx);
            }
            document.set_shown(active, cx);
        });
        if switched || self.latex.drawn.is_none() {
            let line = self.cursor.0;
            if visual {
                document.update(cx, |document, cx| document.reveal_line(line, cx));
                if had_focus && let Some(focus) = document.read(cx).focus_handle(cx) {
                    window.focus(&focus, cx);
                }
            } else if switched {
                self.caret_to_line(line, window, cx);
                if had_focus {
                    window.focus(&self.editor.focus_handle(cx), cx);
                }
            }
        }
        self.latex.drawn = Some(view);
        lattice_webview::check_drawn_after_frame(window, cx);
        cx.notify();
    }

    /// The panel became, or stopped being, its group's displayed tab.
    pub(super) fn latex_views_shown(
        &mut self,
        shown: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.latex_view(cx).is_none() || self.latex.shown == shown {
            return;
        }
        self.latex.shown = shown;
        self.sync_latex_view(window, cx);
    }

    /// The buffer changed: the Visual view follows while it shows.
    pub(super) fn latex_source_changed(&mut self, cx: &mut Context<Self>) {
        if !self.shows_latex_visual(cx) || !self.latex.shown {
            return;
        }
        if let Some(document) = self.latex.document.clone() {
            let text = self.buffer.read(cx).text();
            document.update(cx, |document, cx| document.set_source(text, cx));
        }
    }

    /// What the Visual view reads beside the text: the manuscript's root
    /// document, the last build that wrote a PDF, the outline for its rail
    /// and the spell check's settings.
    pub(super) fn forward_latex_context(&mut self, cx: &mut Context<Self>) {
        let Some(document) = self.latex.document.clone() else {
            return;
        };
        let root = self.latex_root.clone();
        let build = self
            .build
            .read(cx)
            .last()
            .filter(|last| last.wrote_pdf)
            .map(|last| (last.root_document.clone(), last.aux_folder.clone()));
        document.update(cx, |document, cx| {
            document.set_root_document(root, cx);
            document.set_compiled_build(
                build
                    .as_ref()
                    .map(|(root, aux)| (root.as_str(), aux.as_str())),
                cx,
            );
        });
        self.forward_latex_outline(cx);
        self.forward_latex_spelling(cx);
    }

    /// A jump to a 1-based line lands in the Visual view while it shows:
    /// the island takes it.
    pub(super) fn jumps_in_latex_visual(&self, cx: &gpui::App) -> Option<Entity<StructuredDocument>> {
        if !self.shows_latex_visual(cx) {
            return None;
        }
        self.latex.document.clone()
    }

    /// A find (`"open"`, `"next"` or `"previous"`) while the Visual view
    /// shows goes to its page, with the keyboard; false otherwise.
    pub(super) fn find_in_latex_visual(
        &self,
        step: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(document) = self.jumps_in_latex_visual(cx) else {
            return false;
        };
        document.update(cx, |document, cx| document.find(step, cx));
        if let Some(focus) = document.read(cx).focus_handle(cx) {
            window.focus(&focus, cx);
        }
        true
    }

    /// Put the source's caret at the start of the 1-based `line`, scrolled
    /// into view.
    fn caret_to_line(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        let point = Point::new(line.saturating_sub(1), 0);
        self.editor.update(cx, |editor, cx| {
            editor.change_selections(
                SelectionEffects::scroll(Autoscroll::center()),
                window,
                cx,
                |selections| selections.select_ranges([point..point]),
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_tex_document_has_a_visual_view() {
        assert!(is_latex_document(std::path::Path::new("main.tex")));
        assert!(is_latex_document(std::path::Path::new("chapters/Intro.TEX")));
        assert!(!is_latex_document(std::path::Path::new("style.sty")));
        assert!(!is_latex_document(std::path::Path::new("class.cls")));
        assert!(!is_latex_document(std::path::Path::new("notes.md")));
    }
}
