//! Hover cards: what a feature shows for the text the pointer rests on.
//!
//! CodeMirror's `hoverTooltip` asks each source for a tooltip at the
//! position under the pointer; the Tauri app's citation, reference and
//! diagnostic cards are such sources. A [`HoverProvider`] answers the same
//! question here, with the range the card belongs to and a builder for the
//! card. Zed's editor only hovers for its own language servers, so the
//! adapter runs the pointer itself (`adapter.rs`): after the pointer rests on
//! its targets for [`HOVER_DELAY`] (CodeMirror's `hoverTime`), every
//! provider's card there opens, stacked in provider order as CodeMirror's
//! hover host stacks its sources' tooltips (a citation card over the lint
//! card of a diagnostic on the same key). The stack rises above the targets'
//! first character (below when there is no room), stays while the pointer is
//! over the targets or the stack, and goes when it leaves both, on a key
//! press, or when the text changes.

use std::{ops::Range, rc::Rc, time::Duration};

use gpui::{AnyElement, App, Pixels, WeakEntity, Window};
use language::BufferSnapshot;

use crate::LatticeEditor;

/// How long the pointer rests on a target before its card opens.
pub const HOVER_DELAY: Duration = Duration::from_millis(300);
/// How long the pointer may be off both the target and the card (crossing
/// the gap between them) before the card closes.
pub const HOVER_GRACE: Duration = Duration::from_millis(150);

/// What a card is built with.
#[derive(Clone)]
pub struct HoverCardContext {
    /// The editor the card belongs to: a card asks the host to open a
    /// location through it ([`crate::LatticeEditorEvent`]).
    pub editor: WeakEntity<LatticeEditor>,
    /// The widest the card may be: the editor's width less a margin, as the
    /// Tauri app caps its cards (`createHoverCard`).
    pub max_width: Pixels,
    /// The buffer as it is now. A card is built while the editor draws, so
    /// it reads the text from here, never from `editor`.
    pub text: BufferSnapshot,
}

impl HoverCardContext {
    /// Ask the host to open `path` (project-relative) at the 1-based `line`.
    pub fn open_location(&self, path: String, line: u32, cx: &mut App) {
        self.editor
            .update(cx, |editor, cx| {
                editor.request_open_location(path, line, cx)
            })
            .ok();
    }
}

/// Builds a card's content each frame it shows.
pub type HoverCard = Rc<dyn Fn(&HoverCardContext, &mut Window, &mut App) -> AnyElement>;

/// A provider's answer: the range the card belongs to and the card.
#[derive(Clone)]
pub struct HoverTarget {
    /// Byte offsets of the buffer; the card stays while the pointer is over it.
    pub range: Range<usize>,
    /// Told apart from the target shown, so a pointer moving within one
    /// target does not reopen its card; two providers' targets over the
    /// same range differ by it.
    pub id: &'static str,
    pub card: HoverCard,
}

/// A source of hover cards.
pub trait HoverProvider {
    /// The card for the text at `offset`, if this provider has one.
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget>;
}

impl<F> HoverProvider for F
where
    F: Fn(&BufferSnapshot, usize, &App) -> Option<HoverTarget>,
{
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget> {
        self(text, offset, cx)
    }
}
