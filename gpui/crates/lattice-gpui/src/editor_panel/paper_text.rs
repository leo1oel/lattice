//! A saved paper's reading text in an editor panel: the bundle's `paper.md`
//! or `blog.md`, which the Tauri app opens as an editable Markdown document
//! of the paper's tab (`openPaper` in `use-document-opens.ts`) with the
//! canvas reading it as a paper (`activePaper` in `document-canvas.tsx`).
//!
//! The panel is the shell's own editor for the file, so the text saves,
//! reloads from disk and undoes as every Markdown file's does; the paper's
//! reader (`papers/reader.rs`) wraps it in the paper's strip. What makes it
//! a paper's text is said once here and given to its visual editor, which
//! then reads in its reading form under the paper's masthead
//! ([`PaperReading`]).

use gpui::Context;

use super::{EditorPanel, EditorPanelEvent};
use crate::structured::PaperReading;

/// The paper the panel's file is the reading text of, if any.
#[derive(Default)]
pub(super) struct PaperText {
    reading: Option<PaperReading>,
}

/// The arXiv id and the view of the reading text at the project-relative
/// `path` (`.research/papers/<id>/paper.md` or `blog.md`), if it is one.
pub fn paper_text_of(path: &str) -> Option<(String, bool)> {
    let path = path.replace('\\', "/");
    let rest = path.strip_prefix(".research/papers/")?;
    let (id, file) = rest.rsplit_once('/')?;
    if id.is_empty() {
        return None;
    }
    match file {
        "paper.md" => Some((id.to_string(), true)),
        "blog.md" => Some((id.to_string(), false)),
        _ => None,
    }
}

/// Whether the file at `path` (absolute, as the panel holds it) is a saved
/// paper's reading text: a `paper.md` or `blog.md` under a project's
/// `.research/papers/`.
pub(super) fn is_bundle_text(path: &std::path::Path) -> bool {
    let path = path.to_string_lossy().replace('\\', "/");
    path.split_once("/.research/papers/")
        .is_some_and(|(_, rest)| paper_text_of(&format!(".research/papers/{rest}")).is_some())
}

impl EditorPanel {
    /// The file is (or stops being) the reading text of a saved paper: its
    /// visual editor reads it as one.
    pub fn set_paper_reading(&mut self, reading: Option<PaperReading>, cx: &mut Context<Self>) {
        if self.paper.reading == reading {
            return;
        }
        self.paper.reading = reading.clone();
        if let Some(document) = self.markdown_document().cloned() {
            document.update(cx, |document, cx| document.set_paper(reading, cx));
        }
    }

    /// A visual editor just made for the file reads it as the paper's.
    pub(super) fn paper_document_made(
        &self,
        document: &gpui::Entity<crate::structured::StructuredDocument>,
        cx: &mut Context<Self>,
    ) {
        if let Some(reading) = self.paper.reading.clone() {
            document.update(cx, |document, cx| document.set_paper(Some(reading), cx));
        }
    }

    /// The file's text as the buffer holds it.
    pub fn text(&self, cx: &gpui::App) -> String {
        self.buffer.read(cx).text()
    }

    /// The Edit / Split / Preview switch, for the paper's reader to put in
    /// its own strip beside Blog and Paper.
    pub fn view_switch_element(
        &mut self,
        window: &mut gpui::Window,
        cx: &mut Context<Self>,
    ) -> Option<gpui::AnyElement> {
        self.view_switch(window, cx)
    }

    /// The paper's masthead came on screen or left it.
    pub(super) fn paper_masthead(&mut self, in_view: bool, cx: &mut Context<Self>) {
        cx.emit(EditorPanelEvent::Masthead(in_view));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The two reading files of `paperDocumentPath` (src/app/paper-documents.ts).
    #[test]
    fn the_reading_texts_name_their_paper_and_view() {
        assert_eq!(
            paper_text_of(".research/papers/1706.03762/paper.md"),
            Some(("1706.03762".into(), true))
        );
        assert_eq!(
            paper_text_of(".research/papers/hep-th/9901001/blog.md"),
            Some(("hep-th/9901001".into(), false))
        );
        assert_eq!(paper_text_of(".research/papers/1706.03762/notes.md"), None);
        assert_eq!(paper_text_of(".research/papers/paper.md"), None);
        assert_eq!(paper_text_of("chapters/paper.md"), None);
    }

    #[test]
    fn a_panel_path_is_known_as_a_reading_text() {
        let root = std::path::Path::new("/Users/me/thesis");
        assert!(is_bundle_text(
            &root.join(".research/papers/1706.03762/paper.md")
        ));
        assert!(is_bundle_text(
            &root.join(".research/papers/hep-th/9901001/blog.md")
        ));
        assert!(!is_bundle_text(
            &root.join(".research/papers/1706.03762/notes.md")
        ));
        assert!(!is_bundle_text(&root.join("chapters/paper.md")));
    }
}
