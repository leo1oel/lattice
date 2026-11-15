//! The live preview of the math the caret is in, as the Tauri app shows it
//! (`src/editor/latex/math-preview.ts`, the `.math-preview-*` rules in
//! `src/styles/editor-workspace.css` and `surfaces.css`): KaTeX's picture of
//! the formula in a card just above it, where the eye already is while
//! typing it, set with the project's macros as it is typed.
//!
//! The card is the adapter's caret card (`caret_card.rs`), which places it
//! above the formula's first line (below its last when there is no room),
//! shows it only while the editor has the keyboard, and puts it away on
//! Escape until the caret leaves the formula. This module says which
//! formula the caret is in and draws the card: each formula gets a fresh
//! one, while typing in one updates it in place. Nothing shows until KaTeX
//! has set the formula once; half-typed math that KaTeX cannot set keeps the
//! last good picture, dimmed over the fast fade, rather than flashing an
//! error on every keystroke; an emptied formula shows nothing. While a new
//! picture is being set (a few milliseconds through the app's [`previews`]
//! host) the card keeps the one it shows. A picture taller than the card
//! scrolls in it, as far through as the caret is through the formula's
//! source, so the row being typed in a long `align` stays in view.

use std::{
    cell::RefCell,
    ops::{Range, RangeInclusive},
    rc::Rc,
    time::Instant,
};

use gpui::{
    AnyElement, App, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, ScrollHandle, StatefulInteractiveElement as _, Styled as _, WeakEntity, Window, img,
    point, px,
};
use language::{BufferSnapshot, ToOffset as _};
use lattice_ui::{
    ActiveLattice as _,
    motion::{Motion, Tween},
};
use settings::Settings as _;

use super::{
    cards::card_surface,
    previews::{self, MathPicture, MathRequest, Preview},
    syntax::{self, MathRegion},
};
use crate::{
    LatticeEditor, ProjectIndex,
    caret_card::{CaretCardContext, CaretCardProvider},
};

/// The card's widest (`max-width: min(560px, …)`) and tallest
/// (`max-height: min(240px, 40vh)`), and its padding (`--space-4`
/// `--space-6`).
const MAX_WIDTH: Pixels = px(560.);
const MAX_HEIGHT: Pixels = px(240.);
const MAX_HEIGHT_SHARE: f32 = 0.4;
const PAD_Y: Pixels = px(8.);
const PAD_X: Pixels = px(12.);
/// How far half-typed math's last picture is dimmed (`opacity: .5`).
const STALE_OPACITY: f32 = 0.5;

/// Put the live math preview on `editor` (a `.tex` file's, as the Tauri app
/// adds it), its macros read from `index`.
pub fn attach(
    editor: &mut LatticeEditor,
    index: &Entity<ProjectIndex>,
    cx: &mut Context<LatticeEditor>,
) {
    editor.set_caret_card(Rc::new(MathPreview::new(index.downgrade())), cx);
}

/// The math the caret at `caret` is in (`mathRegionInDocument`): read from
/// its paragraph alone, never the whole buffer, since no math crosses a
/// blank line.
pub fn region_at(text: &BufferSnapshot, caret: usize) -> Option<MathRegion> {
    let caret = caret.min(text.len());
    let line = |row: u32| -> String {
        text.text_for_range(
            language::Point::new(row, 0)..language::Point::new(row, text.line_len(row)),
        )
        .collect()
    };
    let rows = paragraph_rows(
        text.offset_to_point(caret).row,
        text.max_point().row,
        |row| syntax::is_blank(&line(row)),
    );
    let from = text.point_to_offset(language::Point::new(*rows.start(), 0));
    let to = text.point_to_offset(language::Point::new(
        *rows.end(),
        text.line_len(*rows.end()),
    ));
    let paragraph: String = text.text_for_range(from..to).collect();
    let mut region = syntax::math_region(&paragraph, caret - from)?;
    region.range = region.range.start + from..region.range.end + from;
    Some(region)
}

/// The rows of the paragraph around `row`: the lines between the nearest
/// blank ones, or the blank line alone.
fn paragraph_rows(row: u32, last: u32, blank: impl Fn(u32) -> bool) -> RangeInclusive<u32> {
    if blank(row) {
        return row..=row;
    }
    let (mut first, mut end) = (row, row);
    while first > 0 && !blank(first - 1) {
        first -= 1;
    }
    while end < last && !blank(end + 1) {
        end += 1;
    }
    first..=end
}

/// What the card shows: the last picture KaTeX set for this formula, and
/// whether the formula has moved on to math it cannot set.
struct Look<P> {
    picture: Option<P>,
    /// The source and kind that picture shows.
    source: Option<(String, bool)>,
    stale: bool,
}

impl<P: Clone> Look<P> {
    fn new() -> Self {
        Self {
            picture: None,
            source: None,
            stale: false,
        }
    }

    /// Take what KaTeX made of `source` so far (`None`: no host to set it).
    fn update(&mut self, source: &str, display: bool, preview: Option<Preview<Option<P>>>) {
        if source.is_empty() {
            // An emptied formula has nothing left to picture.
            *self = Self::new();
            return;
        }
        match preview {
            Some(Preview::Ready(Some(picture))) => {
                self.picture = Some(picture);
                self.source = Some((source.to_string(), display));
                self.stale = false;
            }
            Some(Preview::Ready(None)) => self.stale = self.picture.is_some(),
            // Still being set: the card keeps what it shows.
            Some(Preview::Loading) | None => {}
        }
    }
}

/// The card of one formula.
struct Card {
    /// Where the formula starts: another start is another formula.
    start: language::Anchor,
    look: Look<MathPicture>,
    dim: Tween<f32>,
    scroll: ScrollHandle,
    /// The caret, formula and picture the card last followed the caret for.
    followed: Option<(usize, Range<usize>, u32)>,
    /// The picture being set for this card, if one is.
    pending: Option<MathRequest>,
}

impl Card {
    /// What KaTeX made of `request` so far, one picture at a time: while
    /// one is being set, a newer source waits (the card keeps what it
    /// shows) and is asked for once that one lands and draws the editor
    /// again. Keys typed faster than the page sets them, or held down, so
    /// never queue a picture for every keystroke: the card goes from the
    /// picture it shows to the latest source's.
    fn ask(
        &mut self,
        request: Option<&MathRequest>,
        editor: &WeakEntity<LatticeEditor>,
        cx: &mut App,
    ) -> Option<Preview<Option<MathPicture>>> {
        let request = request?;
        if let Some(pending) = self.pending.take()
            && !same_picture(&pending, request)
        {
            match previews::math(&pending, editor, cx) {
                Some(Preview::Loading) => {
                    self.pending = Some(pending);
                    return Some(Preview::Loading);
                }
                landed => self.look.update(&pending.tex, pending.display, landed),
            }
        }
        let preview = previews::math(request, editor, cx);
        if matches!(preview, Some(Preview::Loading)) {
            self.pending = Some(request.clone());
        }
        preview
    }
}

/// Whether two requests ask for the same picture.
fn same_picture(one: &MathRequest, other: &MathRequest) -> bool {
    one.tex == other.tex
        && one.display == other.display
        && one.size == other.size
        && one.color == other.color
        && one.macros.generation == other.macros.generation
}

/// What the preview shows, for a check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shown {
    /// The math its picture is of, as written.
    pub source: String,
    pub display: bool,
    /// The formula has moved on to math KaTeX cannot set: the picture is
    /// the last good one, dimmed.
    pub stale: bool,
}

/// The live math preview: the caret card of a `.tex` file's editor.
pub struct MathPreview {
    index: WeakEntity<ProjectIndex>,
    card: RefCell<Option<Card>>,
}

impl MathPreview {
    pub fn new(index: WeakEntity<ProjectIndex>) -> Self {
        Self {
            index,
            card: RefCell::new(None),
        }
    }

    /// What the card holds now; `None` before KaTeX has set its formula.
    /// Whether it is drawn is the editor's to say
    /// ([`LatticeEditor::shown_caret_card`]).
    pub fn shown(&self) -> Option<Shown> {
        let card = self.card.borrow();
        let look = &card.as_ref()?.look;
        look.picture.as_ref()?;
        let (source, display) = look.source.clone()?;
        Some(Shown {
            source,
            display,
            stale: look.stale,
        })
    }
}

impl CaretCardProvider for MathPreview {
    fn target(&self, text: &BufferSnapshot, caret: usize, _: &App) -> Option<Range<usize>> {
        region_at(text, caret).map(|region| region.range)
    }

    fn card(
        &self,
        target: Range<usize>,
        context: &CaretCardContext,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let text = &context.text;
        let region = region_at(text, context.caret).filter(|region| region.range == target)?;
        let mut slot = self.card.borrow_mut();
        // Another formula: a fresh card.
        if slot
            .as_ref()
            .is_none_or(|card| card.start.to_offset(text) != target.start)
        {
            *slot = Some(Card {
                start: text.anchor_before(target.start),
                look: Look::new(),
                dim: Tween::settled(1., Instant::now()),
                scroll: ScrollHandle::new(),
                followed: None,
                pending: None,
            });
        }
        let card = slot.as_mut()?;
        let request = (!region.source.is_empty()).then(|| {
            let macros = self
                .index
                .upgrade()
                .map(|index| index.read(cx).macro_sources().clone())
                .unwrap_or_default();
            MathRequest {
                tex: region.source.clone(),
                display: region.display,
                // The card is in the editor's type; KaTeX sets itself at
                // 1.21 times it, in the card's ink.
                size: theme_settings::ThemeSettings::get_global(cx).buffer_font_size(cx),
                color: cx.palette().text,
                macros,
            }
        });
        let preview = card.ask(request.as_ref(), &context.editor, cx);
        card.look.update(&region.source, region.display, preview);
        let picture = card.look.picture.clone()?;

        let now = Instant::now();
        let opacity = if card.look.stale { STALE_OPACITY } else { 1. };
        card.dim.retarget(opacity, Motion::Fast, now);
        if card.dim.is_running(now) {
            window.request_animation_frame();
        }

        let width = (picture.width + PAD_X * 2.).min(MAX_WIDTH.min(context.max_width));
        let cap = MAX_HEIGHT
            .min(window.viewport_size().height * MAX_HEIGHT_SHARE)
            .min(context.max_height);
        let content = picture.height + PAD_Y * 2.;
        let height = content.min(cap);
        follow_caret(card, &region, context.caret, content - height, &picture);

        Some(
            card_surface(cx)
                .id("math-preview")
                .w(width)
                .h(height)
                .px(PAD_X)
                .py(PAD_Y)
                .overflow_scroll()
                .track_scroll(&card.scroll)
                .child(
                    img(picture.image.clone())
                        .flex_none()
                        .w(picture.width)
                        .h(picture.height)
                        .opacity(card.dim.value(now)),
                )
                .into_any_element(),
        )
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Scroll a picture taller than the card (`room` taller) as far through as
/// the caret is through the formula's source, once each time the caret,
/// the formula or the picture changes, so a reader may scroll it between.
fn follow_caret(
    card: &mut Card,
    region: &MathRegion,
    caret: usize,
    room: Pixels,
    picture: &MathPicture,
) {
    let key = (
        caret,
        region.range.clone(),
        f32::from(picture.height).to_bits(),
    );
    if card.followed.as_ref() == Some(&key) {
        return;
    }
    card.followed = Some(key);
    if room <= px(0.) {
        return;
    }
    let x = card.scroll.offset().x;
    card.scroll
        .set_offset(point(x, -(room * caret_share(&region.range, caret))));
}

/// How far through `range` the caret is, 0 to 1.
fn caret_share(range: &Range<usize>, caret: usize) -> f32 {
    if range.end <= range.start {
        return 0.;
    }
    ((caret.saturating_sub(range.start)) as f32 / (range.end - range.start) as f32).clamp(0., 1.)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paragraph a buffer is read in gives the same region as reading
    /// the whole text (`mathRegionAt` over the document).
    #[test]
    fn a_paragraph_read_alone_finds_the_same_math() {
        let text = "Intro $a+b$ text.\n\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n  \nAfter $x^2$ and\n$y$ end";
        let lines: Vec<&str> = text.split('\n').collect();
        let starts: Vec<usize> = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(at, _)| at + 1))
            .collect();
        for caret in 0..=text.len() {
            let row = starts.iter().rposition(|start| *start <= caret).unwrap() as u32;
            let rows = paragraph_rows(row, lines.len() as u32 - 1, |row| {
                syntax::is_blank(lines[row as usize])
            });
            let from = starts[*rows.start() as usize];
            let to = starts[*rows.end() as usize] + lines[*rows.end() as usize].len();
            let alone = syntax::math_region(&text[from..to], caret - from).map(|mut region| {
                region.range = region.range.start + from..region.range.end + from;
                region
            });
            assert_eq!(alone, syntax::math_region(text, caret), "at {caret}");
        }
    }

    /// Nothing shows until KaTeX has set the formula once (the Tauri card is
    /// hidden until then), and a formula still being set keeps nothing.
    #[test]
    fn nothing_shows_before_the_first_picture() {
        let mut look = Look::<u32>::new();
        look.update("x", false, Some(Preview::Loading));
        assert!(look.picture.is_none());
        look.update("x", false, Some(Preview::Ready(None)));
        assert!(look.picture.is_none() && !look.stale);
        look.update("x", false, None);
        assert!(look.picture.is_none());
    }

    /// "keeps the last good picture, dimmed, while the formula cannot be
    /// set" (`math-preview.test.ts`), and drops the dim once it can again.
    #[test]
    fn half_typed_math_keeps_the_last_picture_dimmed() {
        let mut look = Look::new();
        look.update("\\frac{a}{b}", false, Some(Preview::Ready(Some(1))));
        assert_eq!((look.picture, look.stale), (Some(1), false));
        look.update("\\frac{a}{b}\\frac{", false, Some(Preview::Ready(None)));
        assert_eq!((look.picture, look.stale), (Some(1), true));
        assert_eq!(look.source, Some(("\\frac{a}{b}".to_string(), false)));
        // Still being set: the dimmed picture stays as it is.
        look.update("\\frac{a}{b}\\frac{c", false, Some(Preview::Loading));
        assert_eq!((look.picture, look.stale), (Some(1), true));
        look.update("\\frac{a}{b}", false, Some(Preview::Ready(Some(1))));
        assert_eq!((look.picture, look.stale), (Some(1), false));
    }

    /// While the next keystroke's picture is set, the card keeps the last.
    #[test]
    fn typing_keeps_the_picture_until_the_next_is_in() {
        let mut look = Look::new();
        look.update("E = mc^2", false, Some(Preview::Ready(Some(1))));
        look.update("E = mc^2+", false, Some(Preview::Loading));
        assert_eq!((look.picture, look.stale), (Some(1), false));
        look.update("E = mc^2+1", false, Some(Preview::Ready(Some(2))));
        assert_eq!(look.picture, Some(2));
        assert_eq!(look.source, Some(("E = mc^2+1".to_string(), false)));
    }

    /// "shows nothing for an empty formula" (`math-preview.test.ts`).
    #[test]
    fn an_emptied_formula_shows_nothing() {
        let mut look = Look::new();
        look.update("x", true, Some(Preview::Ready(Some(1))));
        look.update("", true, None);
        assert!(look.picture.is_none());
    }

    /// The card scrolls as far through the picture as the caret is through
    /// the formula's source.
    #[test]
    fn the_caret_s_share_of_the_formula() {
        assert_eq!(caret_share(&(10..20), 10), 0.);
        assert_eq!(caret_share(&(10..20), 15), 0.5);
        assert_eq!(caret_share(&(10..20), 25), 1.);
        assert_eq!(caret_share(&(10..10), 10), 0.);
    }
}
