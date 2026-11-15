//! What an editor panel reports to the shell.

/// What the panel tells the shell.
pub enum EditorPanelEvent {
    /// A save wrote the file: the PDF is older than the sources now.
    Saved,
    /// A save just wrote the file, from a pause in typing or from leaving
    /// the editor: build now, unattended.
    SavedForBuild,
    /// An edit made outside Lattice was loaded into the clean buffer.
    DiskEdit,
    /// The file was deleted outside Lattice with nothing unsaved: close the tab.
    Close,
    /// Open the project-relative `path` at the 1-based `line` (a hover
    /// card's Go to entry, a reference card's title).
    OpenLocation { path: String, line: u32 },
    /// The caret moved to another line.
    CaretLine,
    /// ⌘V with an image (and no text) on the clipboard, in a LaTeX or
    /// Markdown file: the window saves it as a figure and inserts it.
    PasteImage,
    /// Insert the project's files as figures (a row dragged from the tree),
    /// at the start of the line holding the offset, when it is known.
    InsertFigures(Vec<String>, Option<usize>),
    /// Files dropped from Finder (`shell/drops.rs`): figures go in at the
    /// start of the line holding the offset; the window point it was
    /// dropped at.
    DropFiles(Vec<std::path::PathBuf>, Option<usize>, gpui::Point<gpui::Pixels>),
    /// The caret or the selection changed at all (Overleaf's remote caret
    /// and the Agent's host context follow).
    CaretMoved,
    /// The writer changed the text (not live editing, `overleaf_text`).
    Typed,
    /// The editor took focus: it is the one the reader works in now.
    Focused,
    /// Find the uses of a label or citation key, or rename it (`rename`),
    /// asked from a `.tex` file's Visual view.
    Symbol {
        kind: crate::submission::references::SymbolKind,
        symbol: String,
        rename: bool,
    },
    /// Wrap in environment… (`None`) or Rename the environment (its name),
    /// asked from a `.tex` file's Visual view.
    Environment { rename: Option<String> },
    /// Open the project-relative `path` (a link followed in a Markdown file's
    /// visual editor).
    OpenFile { path: String },
    /// Create the project-relative file and open it (a missing `\input`'s
    /// Create file, from the lint's card).
    CreateFile { path: String },
    /// An outline rail row: open `path` at the 1-based `line`, then show
    /// the same place in the PDF.
    OutlineJump { path: String, line: u32 },
    /// The buffer's text changed: what the live preview follows.
    Edited,
    /// Open Slide asks the Agent's composer (`OpenSlideAgentRequest`).
    AgentRequest(serde_json::Value),
    /// What the Agent is told of the panel's surface changed (a deck's
    /// selection, the visual Markdown editor's).
    SurfaceContext,
    /// A suggestion's card asked to accept or reject it.
    OverleafReview(super::ReviewAction),
    /// A saved paper's masthead came on screen (true) or left it, for the
    /// paper's reader to name the paper in its strip only while it is off.
    Masthead(bool),
    /// A source link into the paper's own PDF was followed: open it there
    /// at this 1-based page.
    PaperSource(u32),
    /// A note's pin or card asked something of the window
    /// (`editor_panel/annotations.rs`).
    Annotation(crate::annotations::AnnotationRequest),
}
