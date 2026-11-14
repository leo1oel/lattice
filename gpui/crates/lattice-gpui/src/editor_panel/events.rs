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
    /// The caret or the selection changed at all (Overleaf's remote caret
    /// and the Agent's host context follow).
    CaretMoved,
    /// The writer changed the text (not live editing, `overleaf_text`).
    Typed,
    /// The editor took focus: it is the one the reader works in now.
    Focused,
    /// Open the project-relative `path` (a link followed in a Markdown file's
    /// visual editor).
    OpenFile { path: String },
    /// An outline rail row: open `path` at the 1-based `line`, then show
    /// the same place in the PDF.
    OutlineJump { path: String, line: u32 },
    /// The buffer's text changed: what the live preview follows.
    Edited,
}
