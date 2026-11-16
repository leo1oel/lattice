//! What a viewer tells whoever shows it, and the action a host may offer
//! in its toolbar.

/// What the viewer tells whoever shows it.
pub enum PdfViewEvent {
    /// A double-click at (`x`, `y`) PDF points from the top-left corner of
    /// page `page` (1-based): show its source.
    SourceAt {
        page: u32,
        x: f64,
        y: f64,
        /// The word under the click, for the caret to land on.
        word: Option<lattice_editor::latex::synctex_word::SyncTexWord>,
        /// ⌘ was held: the figure's drawing, when the point is on one.
        figure: bool,
    },
    /// The toolbar's Reveal cursor in PDF.
    RevealCursor,
    /// The toolbar action the host offered (`ToolbarAction`).
    Action,
    /// The empty state's Build project.
    Build,
    /// An Outline row: open `path` (project-relative) at `line` and show the
    /// place in the PDF.
    Outline { path: String, line: u32 },
    /// A citation card's title: open the paper cited under the key.
    OpenCitation(String),
    /// A note made here goes to Overleaf as a comment: the text selected on
    /// the PDF, placed by SyncTeX on `line` of `path` where the file read
    /// `quote`, and the comment. The host answers with
    /// [`super::PdfView::answer_overleaf_note`].
    OverleafNote {
        id: u64,
        path: String,
        line: usize,
        selection: String,
        quote: String,
        body: String,
    },
    /// A note's card asked something of it (Resolve, Reply).
    Annotation(crate::annotations::AnnotationRequest),
    /// The view rested at a new place, for the host to keep.
    PlaceChanged(super::ViewPlace),
}

/// A context-specific action before Save, such as moving the PDF into a
/// window of its own; a narrow toolbar moves it into the overflow menu.
#[derive(Clone)]
pub struct ToolbarAction {
    /// An `n!` message, translated where shown.
    pub label: &'static str,
    pub icon: lattice_ui::Icon,
}
