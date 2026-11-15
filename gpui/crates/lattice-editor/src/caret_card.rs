//! Caret cards: a card for the text the caret is in, as CodeMirror shows a
//! tooltip from editor state (`showTooltip`) rather than from the pointer.
//! The Tauri app's live math preview is one (`src/editor/latex/math-preview.ts`).
//!
//! A [`CaretCardProvider`] says what text the caret is in and builds the
//! card for it; the adapter (`adapter/caret_card.rs`) does the rest, as
//! the math preview's tooltip does in the Tauri app: the card stands just
//! above the target's first line, so it never covers the line being edited,
//! and below its last line when there is no room above; when the target
//! fills the editor's height, the caret's own line stands in for it. It
//! takes no focus, shows only while the editor has the keyboard, and Escape
//! puts it away until the caret leaves that target (an Escape that closes
//! the completion menu is the menu's alone, and the key still does whatever
//! else it does).

use std::{any::Any, ops::Range};

use gpui::{AnyElement, App, Bounds, Pixels, WeakEntity, Window, point, px, size};
use language::BufferSnapshot;

use crate::LatticeEditor;

/// The gap between the card and the text it stands by (`GAP`).
pub(crate) const CARD_GAP: Pixels = px(4.);
/// How far inside the editor the card stays (`citationTooltipSpace`).
pub(crate) const CARD_INSET: Pixels = px(8.);

/// What a card is built with.
#[derive(Clone)]
pub struct CaretCardContext {
    pub editor: WeakEntity<LatticeEditor>,
    /// The widest the card may be: the editor's width less its margins,
    /// and never under 160px (`--math-preview-room`).
    pub max_width: Pixels,
    /// The tallest the card may be: the room on its side of the target,
    /// as CodeMirror shrinks a tooltip to the space it has.
    pub max_height: Pixels,
    /// The caret's buffer offset.
    pub caret: usize,
    /// The buffer as it is now.
    pub text: BufferSnapshot,
}

/// A source of the caret card.
pub trait CaretCardProvider: Any {
    /// The text the caret at `caret` is in, in buffer offsets: the card
    /// stands by it. `None`: no card.
    fn target(&self, text: &BufferSnapshot, caret: usize, cx: &App) -> Option<Range<usize>>;

    /// The card for `target`, built each frame it shows; `None` while it
    /// has nothing to show yet.
    fn card(
        &self,
        target: Range<usize>,
        context: &CaretCardContext,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement>;

    /// The provider itself, for a check that reads what it shows.
    fn as_any(&self) -> &dyn Any;
}

/// Where the target is on screen.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TargetRects {
    /// The caret rectangle at the target's start.
    pub start: Bounds<Pixels>,
    /// The bottom of the target's last line.
    pub end_bottom: Pixels,
    /// The caret's own line.
    pub caret: Bounds<Pixels>,
}

/// Where the card goes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Placement {
    pub left: Pixels,
    /// The card's bottom edge when `above`, else its top edge.
    pub edge: Pixels,
    pub above: bool,
    /// The room on that side: the card is no taller.
    pub room: Pixels,
}

/// Place a card of `card` size by `target` (`getCoords`, then CodeMirror's
/// tooltip positioning), or `None` where it is hidden. `visible` is the
/// editor's scrolling area, `space` the editor inset by [`CARD_INSET`].
pub(crate) fn place(
    target: TargetRects,
    visible: Bounds<Pixels>,
    space: Bounds<Pixels>,
    card: gpui::Size<Pixels>,
    line_height: Pixels,
) -> Option<Placement> {
    let height = card.height + CARD_GAP;
    let left = target.start.left();
    // The whole target, when the card fits above or below it in view;
    // else the caret's line, so the card stays by the line being typed.
    let (top, bottom) = if target.start.top() - height >= visible.top()
        || target.end_bottom + height <= visible.bottom()
    {
        (target.start.top(), target.end_bottom)
    } else {
        (target.caret.top(), target.caret.bottom())
    };
    if top >= space.bottom() || bottom <= space.top() {
        return None;
    }
    // Above, unless it does not fit there and below has more room.
    let mut above = true;
    if top - height < space.top() && space.bottom() - bottom > top - space.top() {
        above = false;
    }
    let room = if above {
        top - space.top()
    } else {
        space.bottom() - bottom
    } - CARD_GAP;
    if room < line_height {
        return None;
    }
    let left = left.min(space.right() - card.width).max(space.left());
    Some(Placement {
        left,
        edge: if above {
            top - CARD_GAP
        } else {
            bottom + CARD_GAP
        },
        above,
        room,
    })
}

/// `bounds` less `inset` on every side.
pub(crate) fn inset(bounds: Bounds<Pixels>, inset: Pixels) -> Bounds<Pixels> {
    Bounds {
        origin: point(bounds.left() + inset, bounds.top() + inset),
        size: size(
            (bounds.size.width - inset * 2.).max(px(0.)),
            (bounds.size.height - inset * 2.).max(px(0.)),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: f32 = 20.;

    fn rect(left: f32, top: f32) -> Bounds<Pixels> {
        Bounds {
            origin: point(px(left), px(top)),
            size: size(px(8.), px(LINE)),
        }
    }

    fn editor() -> Bounds<Pixels> {
        Bounds {
            origin: point(px(0.), px(0.)),
            size: size(px(800.), px(600.)),
        }
    }

    fn placed(start: f32, end_bottom: f32, caret: f32, height: f32) -> Option<Placement> {
        place(
            TargetRects {
                start: rect(100., start),
                end_bottom: px(end_bottom),
                caret: rect(140., caret),
            },
            editor(),
            inset(editor(), CARD_INSET),
            size(px(200.), px(height)),
            px(LINE),
        )
    }

    /// The Tauri preview's card sits above the formula's first line, its
    /// bottom the gap above it, so a multi-line `align` being typed in is
    /// never covered.
    #[test]
    fn the_card_stands_above_the_target_s_first_line() {
        let placement = placed(300., 380., 340., 60.).expect("shown");
        assert!(placement.above);
        assert_eq!(placement.edge, px(296.));
        assert_eq!(placement.left, px(100.));
    }

    /// With no room above (a formula at the editor's top), it goes below
    /// the formula's last line.
    #[test]
    fn with_no_room_above_it_goes_below_the_last_line() {
        let placement = placed(20., 100., 40., 60.).expect("shown");
        assert!(!placement.above);
        assert_eq!(placement.edge, px(104.));
    }

    /// A formula that fills the editor (a long `align`) lets the caret's
    /// line stand in for it: the card stays by the line being typed.
    #[test]
    fn a_formula_filling_the_editor_hangs_the_card_by_the_caret_line() {
        let placement = placed(-400., 900., 300., 120.).expect("shown");
        assert!(placement.above);
        assert_eq!(placement.edge, px(296.));
    }

    /// A target scrolled out of the editor takes the card with it.
    #[test]
    fn a_target_out_of_view_hides_the_card() {
        assert!(placed(-200., -100., -150., 40.).is_none());
        assert!(placed(700., 760., 720., 40.).is_none());
    }

    /// The card shifts left to stay inside the editor, never past its left
    /// inset.
    #[test]
    fn the_card_stays_inside_the_editor_s_width() {
        let near_edge = place(
            TargetRects {
                start: rect(700., 300.),
                end_bottom: px(320.),
                caret: rect(700., 300.),
            },
            editor(),
            inset(editor(), CARD_INSET),
            size(px(200.), px(40.)),
            px(LINE),
        )
        .expect("shown");
        assert_eq!(near_edge.left, px(792. - 200.));
    }
}
