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
    /// The control the host put at the toolbar's start
    /// ([`super::PdfView::set_toolbar_start`]).
    Start,
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
    /// Export review PDF… was chosen.
    ExportReview,
    /// The view rested at a new place, for the host to keep.
    PlaceChanged(super::ViewPlace),
    /// A drag selected text, offered to the host
    /// ([`super::PdfView::set_offers_selection`]); `None` takes the offer
    /// away (a press elsewhere, a scroll, a zoom, Escape).
    SelectionOffered(Option<OfferedSelection>),
}

/// A PDF the host is still getting for the view (the paper reader's PDF on
/// the web), shown as the Tauri app's `PdfPreviewLoading` shows it: the
/// toolbar holds only the host's start control, over the first load's
/// skeleton while it comes, or over the reason it did not.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum HostLoad {
    /// Nothing waits on the host: the view shows what it opened.
    #[default]
    Ready,
    /// The host is fetching the PDF.
    Fetching,
    /// The host could not get it, with what to say.
    Failed(gpui::SharedString),
}

/// Text a drag selected, as the host is offered it.
#[derive(Clone, Debug)]
pub struct OfferedSelection {
    /// The 0-based page the selection starts on.
    pub page: usize,
    /// What a copy of it would hold.
    pub text: String,
    /// That page's whole text, a line end after each line, to name the
    /// passage by words it holds once.
    pub page_text: String,
    /// The selection's last line, on the window.
    pub end: gpui::Bounds<gpui::Pixels>,
}

/// A context-specific action before Save, such as moving the PDF into a
/// window of its own; a narrow toolbar moves it into the overflow menu.
/// Also the control a host puts at the toolbar's start, before the page
/// controls (`toolbarStart`), such as the paper reader's way back.
#[derive(Clone)]
pub struct ToolbarAction {
    /// An `n!` message, translated where shown.
    pub label: &'static str,
    pub icon: lattice_ui::Icon,
}
