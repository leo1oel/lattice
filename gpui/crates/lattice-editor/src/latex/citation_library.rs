//! What a citation card knows beyond the bibliography, from the app around
//! the editor (`LatexEditorLiveData` in the Tauri app's
//! `latex-hover-cards.ts` and `citation-card-uses.ts`): the paper the key
//! cites in the library (whether it opens, its authors, Crossref's word on
//! it), the key's uses in the manuscript with their reasons, and the
//! actions that leave the card for the app: Open paper, a jump to a use,
//! and "Why cited".
//!
//! The editor crate knows nothing of the paper library or the annotations,
//! so the host fills a [`CitationSlot`] on each editor with a
//! [`CitationLibrary`]; until it does (a unit test, an editor outside a
//! project) the card shows the bibliography's facts alone, as before.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{App, SharedString, Window};
use language::BufferSnapshot;

/// Crossref's word on the cited paper (`healthFact`): a correction or
/// retraction as a warning, a lookup that found none as verified.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Health {
    /// "Verified by Crossref".
    Verified,
    /// What happened, as the badge names it ("Retracted").
    Warning(String),
}

/// The library's facts about the paper a key cites.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PaperFacts {
    /// Open paper is offered: the library has its text, can download it, or
    /// the entry names a source to open (`canOpenCitation`).
    pub can_open: bool,
    /// The library's author list, which keeps BibTeX's braces around a
    /// corporate author; the card prefers it to the entry's.
    pub authors: Option<String>,
    /// Crossref's word, and its full explanation for the badge's tip.
    pub health: Option<(Health, Option<String>)>,
}

/// One occurrence of the key, as its row in "Cited N× here" shows it
/// (`CitationUse`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CitationUse {
    /// Project-relative.
    pub path: String,
    /// 1-based.
    pub line: u32,
    /// Its bytes in this editor's buffer; `None` for another file's use,
    /// which jumps by line.
    pub range: Option<Range<usize>>,
    /// The section it sits in.
    pub section: Option<String>,
    /// The page its note names (`\cite[p.~5]{key}`).
    pub page: Option<u32>,
    /// Its reason's role (an identifier, for the chip's colour), the role as
    /// the chip names it, and the reason's note.
    pub reason: Option<(String, SharedString, String)>,
}

/// The host's side of a citation card.
pub trait CitationLibrary {
    /// The library's facts about the paper `key` cites.
    fn facts(&self, key: &str, cx: &App) -> PaperFacts;

    /// Every use of `key`: this editor's, read from `text` as it is now,
    /// then the other files' as the saved manuscript has them (which may
    /// arrive a moment later: the card is drawn again when they do).
    fn uses(&self, key: &str, text: &BufferSnapshot, cx: &mut App) -> Vec<CitationUse>;

    /// This editor's file, project-relative: its uses' rows say "Line N"
    /// where another file's say "file.tex:N".
    fn path(&self) -> String;

    /// Open the paper `key` cites, at `page` when its note names one.
    fn open_paper(&self, key: &str, page: Option<u32>, window: &mut Window, cx: &mut App);

    /// Go to a use: select it in this editor, or open its file at its line.
    fn jump(&self, at: &CitationUse, window: &mut Window, cx: &mut App);

    /// Whether this editor files citation reasons ("Why cited" is offered).
    fn files_reasons(&self, cx: &App) -> bool;

    /// Open "Why cited" on the key at `range` of this editor's buffer.
    fn why_cited(&self, key: &str, range: Range<usize>, window: &mut Window, cx: &mut App);

    /// Whether "Why cited" is open: the key's card stays away meanwhile.
    fn editing_reason(&self, cx: &App) -> bool;
}

/// Where an editor's citation card finds its library; empty until the host
/// fills it.
pub type CitationSlot = Rc<RefCell<Option<Rc<dyn CitationLibrary>>>>;
