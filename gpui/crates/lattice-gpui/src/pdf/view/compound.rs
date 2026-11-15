//! A compound's key over its number in the PDF, as the Tauri app's
//! `pdf-compound-key-hover.tsx` shows it: resting the pointer 250 ms on a
//! run of text the last build printed as some compound's number traces it
//! back by reverse SyncTeX to its source line, read from disk (the PDF was
//! built from the saved file), and the card shows the line's keys that
//! number as `\cmpd{key}` (or `\rcmpd{…}` for a drawing's mark), with
//! "Click to copy the LaTeX command". A key on the card copies its command;
//! a plain click on the number copies it too when it names one key, once no
//! double-click follows. The card stays while the pointer is on the number,
//! the card or the 16px around and between them, and closes 300 ms after it
//! leaves, or at once on a click elsewhere, a scroll or zoom, or Escape.
//!
//! A project without chemnum records listens to nothing, and the citation
//! numbers, references and years of a line with a compound show none.

use std::{path::PathBuf, sync::Arc, time::Instant};

use gpui::{
    AnyElement, ClipboardItem, InteractiveElement as _, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, div, px,
};
use lattice_editor::latex::cards::card_surface;
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

use super::{hover_card::CardBounds, *};
use crate::pdf::{
    compounds::{
        CompoundNumbers, compound_command, compound_keys_on_line, compound_marks_on_line,
        keys_numbered,
    },
    text::PageText,
};

/// How long the pointer rests on a number before it is looked up.
const REST: Duration = Duration::from_millis(250);
/// How long the pointer may be off the number and its card before it closes.
const CLOSE_AFTER: Duration = Duration::from_millis(300);
/// Long enough for a double-click on the number to be seen before a single
/// click copies.
const SINGLE_CLICK: Duration = Duration::from_millis(260);
/// How far a press may travel and still be a click.
const CLICK_SLOP: f32 = 4.;
/// Around the number and its card: the path between them keeps it open.
const BRIDGE: f32 = 16.;

/// What the host tells the PDF of the last build's compounds: the project
/// whose sources SyncTeX names, and what chemnum numbered.
#[derive(Clone)]
pub struct CompoundSource {
    pub root: PathBuf,
    pub numbers: Arc<CompoundNumbers>,
}

#[derive(Default)]
pub(in crate::pdf) struct CompoundHover {
    /// The pointer resting, before the lookup.
    rest: Option<Task<()>>,
    /// The newest lookup's number: only its answer shows.
    request: u64,
    shown: Option<Shown>,
    closing: Option<Task<()>>,
    /// A single click on the number, waiting out [`SINGLE_CLICK`].
    click: Option<Task<()>>,
    pressed_at: Option<Point<Pixels>>,
    card: CardBounds,
}

struct Shown {
    page: usize,
    /// The number's box, in PDF points from the page's top-left corner.
    rect: (f32, f32, f32, f32),
    keys: Vec<String>,
    marks: Vec<String>,
    scroll: (f32, f32),
    scale: f32,
    opened: Instant,
}

/// The run of text under (`x`, `y`) on a page, as PDF.js's text-layer span
/// is: the characters around the point up to whitespace, on its line, with
/// their box.
pub(in crate::pdf) fn run_at(
    text: &PageText,
    x: f32,
    y: f32,
) -> Option<(String, (f32, f32, f32, f32))> {
    let chars = &text.chars;
    let at = chars.iter().position(|ch| {
        !ch.ch.is_whitespace()
            && ch.x1 > ch.x0
            && x >= ch.x0
            && x <= ch.x1
            && y >= ch.y0
            && y <= ch.y1
    })?;
    let line = (chars[at].y0 + chars[at].y1) / 2.;
    let on_run = |ix: usize| {
        let ch = &chars[ix];
        !ch.ch.is_whitespace() && ch.x1 > ch.x0 && line >= ch.y0 && line <= ch.y1
    };
    let mut start = at;
    while start > 0 && on_run(start - 1) {
        start -= 1;
    }
    let mut end = at;
    while end + 1 < chars.len() && on_run(end + 1) {
        end += 1;
    }
    let run = &chars[start..=end];
    let word: String = run.iter().map(|ch| ch.ch).collect();
    let rect = run
        .iter()
        .fold((f32::MAX, f32::MAX, f32::MIN, f32::MIN), |r, ch| {
            (
                r.0.min(ch.x0),
                r.1.min(ch.y0),
                r.2.max(ch.x1),
                r.3.max(ch.y1),
            )
        });
    Some((word, rect))
}

impl PdfView {
    /// Tell the viewer what the last build numbered; `None` (or a build
    /// without chemnum) looks for no compound at all.
    pub fn set_compounds(&mut self, source: Option<CompoundSource>, cx: &mut Context<Self>) {
        self.compounds = source.filter(|source| !source.numbers.is_empty());
        if self.compounds.is_none() {
            self.dismiss_compound(cx);
        }
    }

    pub(in crate::pdf) fn compound_active(&self) -> bool {
        self.compound.shown.is_some() || self.compound.rest.is_some()
    }

    /// The key card shown, for a scenario.
    pub fn compound_card(&self) -> Option<Vec<String>> {
        self.compound.shown.as_ref().map(|shown| shown.keys.clone())
    }

    /// Where on the window a point of `page` (0-based, PDF points from its
    /// top-left corner) is, for a scenario.
    pub fn page_point_on_window(&self, page: usize, x: f32, y: f32) -> Option<Point<Pixels>> {
        self.page_box_on_window(page, (x, y, x, y))
            .map(|point| point.origin)
    }

    /// Whether a window position is on the number, the card, or between.
    pub(in crate::pdf) fn in_compound_bridge(&self, position: Point<Pixels>) -> bool {
        let Some(shown) = &self.compound.shown else {
            return false;
        };
        let Some(number) = self.page_box_on_window(shown.page, shown.rect) else {
            return false;
        };
        let both = match self.compound.card.get() {
            Some(card) => number.union(&card),
            None => number,
        };
        both.dilate(px(BRIDGE)).contains(&position)
    }

    /// The pointer moved over the pages, no button held: once it rests, the
    /// run of text under it is looked up.
    pub(in crate::pdf) fn hover_compound(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if self.compounds.is_none() {
            return;
        }
        self.compound.rest = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(REST).await;
            this.update(cx, |this, cx| {
                this.compound.rest = None;
                this.look_up_compound(position, cx);
            })
            .ok();
        }));
    }

    /// The pointer left the pages: a lookup waiting does not run, and the
    /// card starts closing.
    pub(in crate::pdf) fn leave_compound(&mut self, cx: &mut Context<Self>) {
        self.compound.rest = None;
        self.compound.request += 1;
        self.close_compound_soon(cx);
    }

    fn look_up_compound(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        self.compound.request += 1;
        let request = self.compound.request;
        if self.in_compound_bridge(position) {
            self.compound.closing = None;
            return;
        }
        let Some(source) = self.compounds.clone() else {
            return;
        };
        let (x, y) = self.sheet_point(position);
        let hit = self.layout.to_page(x, y).and_then(|(page, x, y)| {
            // A link's own card and click (a citation, a reference) are its.
            if self.link_at(page, x, y).is_some() {
                return None;
            }
            let (word, rect) = run_at(self.pages.get(page)?.text.as_ref()?, x, y)?;
            source
                .numbers
                .prints(&word)
                .then_some((page, x, y, word, rect))
        });
        let Some((page, x, y, word, rect)) = hit else {
            self.close_compound_soon(cx);
            return;
        };
        self.compound.closing = None;
        let lookup = cx.background_spawn(async move {
            // No SyncTeX data, or a file it cannot read, has no key to show.
            let target = lattice_core::latex::inverse_search_in(
                &source.root,
                page as u32 + 1,
                f64::from(x),
                f64::from(y),
                None,
            )
            .ok()?;
            let text = std::fs::read_to_string(source.root.join(&target.path)).ok()?;
            let line = text
                .lines()
                .nth((target.line as usize).checked_sub(1)?)?
                .to_string();
            let keys = keys_numbered(&word, &compound_keys_on_line(&line), &source.numbers);
            Some((keys, compound_marks_on_line(&line)))
        });
        cx.spawn(async move |this, cx| {
            let found = lookup.await;
            this.update(cx, |this, cx| {
                if this.compound.request != request {
                    return;
                }
                match found.filter(|(keys, _)| !keys.is_empty()) {
                    Some((keys, marks)) => {
                        this.compound.shown = Some(Shown {
                            page,
                            rect,
                            keys,
                            marks,
                            scroll: this.scroll_offset(),
                            scale: this.layout.scale,
                            opened: Instant::now(),
                        });
                        cx.notify();
                    }
                    None => this.close_compound_soon(cx),
                }
            })
            .ok();
        })
        .detach();
    }

    fn close_compound_soon(&mut self, cx: &mut Context<Self>) {
        if self.compound.shown.is_none() || self.compound.closing.is_some() {
            return;
        }
        self.compound.closing = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CLOSE_AFTER).await;
            this.update(cx, |this, cx| this.dismiss_compound(cx)).ok();
        }));
    }

    /// Close the card at once and forget any lookup or click under way.
    pub(in crate::pdf) fn dismiss_compound(&mut self, cx: &mut Context<Self>) {
        let had = self.compound.shown.take().is_some();
        self.compound.rest = None;
        self.compound.request += 1;
        self.compound.closing = None;
        self.compound.click = None;
        if had {
            cx.notify();
        }
    }

    /// A press on the pages, remembered so its release can tell a click
    /// from a drag; a second press of a double-click cancels the copy.
    pub(in crate::pdf) fn compound_press(
        &mut self,
        event: &MouseDownEvent,
        cx: &mut Context<Self>,
    ) {
        self.compound.pressed_at = Some(event.position);
        if event.click_count > 1 {
            self.dismiss_compound(cx);
        }
    }

    /// A release on the pages: a plain click on a number that names one key
    /// copies its command once no double-click follows; any other click
    /// closes the card.
    pub(in crate::pdf) fn compound_click(&mut self, event: &MouseUpEvent, cx: &mut Context<Self>) {
        self.compound.click = None;
        let Some(shown) = &self.compound.shown else {
            return;
        };
        let still = self.compound.pressed_at.take().is_some_and(|at| {
            let (dx, dy) = (
                f32::from(at.x - event.position.x),
                f32::from(at.y - event.position.y),
            );
            dx.hypot(dy) <= CLICK_SLOP
        });
        let on_number = self
            .page_box_on_window(shown.page, shown.rect)
            .is_some_and(|number| number.contains(&event.position));
        let plain = event.click_count == 1 && !event.modifiers.secondary(cx);
        if plain && still && on_number && shown.keys.len() == 1 {
            let key = shown.keys[0].clone();
            let mark = shown.marks.contains(&key);
            self.compound.click = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(SINGLE_CLICK).await;
                this.update(cx, |this, cx| this.copy_compound(&key, mark, cx))
                    .ok();
            }));
            return;
        }
        if !self
            .compound
            .card
            .get()
            .is_some_and(|card| card.contains(&event.position))
        {
            self.dismiss_compound(cx);
        }
    }

    fn copy_compound(&mut self, key: &str, mark: bool, cx: &mut Context<Self>) {
        self.dismiss_compound(cx);
        cx.write_to_clipboard(ClipboardItem::new_string(compound_command(key, mark)));
        crate::notices::copied(t!("LaTeX command copied"), cx);
    }

    /// The card over its number; `None` when none shows, or its number has
    /// scrolled or zoomed away.
    pub(in crate::pdf) fn compound_card_element(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let shown = self.compound.shown.as_ref()?;
        if shown.scroll != self.scroll_offset() || shown.scale != self.layout.scale {
            cx.defer_in(window, |this, _, cx| this.dismiss_compound(cx));
            return None;
        }
        let about = self.page_box_on_window(shown.page, shown.rect)?;
        let palette = cx.palette().clone();
        let font = cx.lattice().fonts.editor.clone();
        let view = cx.entity().downgrade();
        let keys = shown.keys.iter().enumerate().map(|(ix, key)| {
            let mark = shown.marks.contains(key);
            let command = compound_command(key, mark);
            let key = key.clone();
            let view = view.clone();
            div()
                .id(("pdf-compound-key", ix))
                .max_w_full()
                .mb(px(4.))
                .text_color(palette.text)
                .font_family(font.clone())
                .text_size(lattice_ui::tokens::TEXT_TITLE)
                .truncate()
                .cursor_pointer()
                .on_click(move |_, _, cx| {
                    view.update(cx, |this, cx| this.copy_compound(&key, mark, cx))
                        .ok();
                })
                .child(command)
        });
        let hovered = cx.listener(|this, hovered: &bool, _, cx| {
            if *hovered {
                this.compound.closing = None;
            } else {
                this.close_compound_soon(cx);
            }
        });
        let content = div()
            .id("pdf-compound-card")
            .occlude()
            .on_hover(hovered)
            .child(
                card_surface(cx)
                    .items_start()
                    .max_w(px(360.))
                    .pt(px(12.))
                    .px(px(16.))
                    .pb(px(8.))
                    .text_role(TextRole::Body, cx)
                    .children(keys)
                    .child(
                        div()
                            .mt(px(2.))
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(t!("Click to copy the LaTeX command")),
                    ),
            );
        let id = SharedString::from(format!("pdf-compound-{}-{:?}", shown.page, shown.opened));
        let painted = self.compound.card.clone();
        Some(self.hover_card(id, about, px(200.), painted, content, window, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf::text::TextChar;

    fn chars(text: &str, y: f32) -> Vec<TextChar> {
        text.chars()
            .enumerate()
            .map(|(ix, ch)| TextChar {
                ch,
                x0: ix as f32 * 5.,
                y0: y,
                x1: ix as f32 * 5. + 5.,
                y1: y + 10.,
                generated: false,
            })
            .collect()
    }

    #[test]
    fn the_run_under_the_point_is_its_text_up_to_whitespace_on_its_line() {
        let mut all = chars("gave (2a), then", 0.);
        all.extend(chars("next", 20.));
        let text = PageText {
            chars: all,
            links: Vec::new(),
        };
        // On the `2` of "(2a),".
        let (word, rect) = run_at(&text, 32., 5.).unwrap();
        assert_eq!(word, "(2a),");
        assert_eq!(rect, (25., 0., 50., 10.));
        assert!(run_at(&text, 22., 5.).is_none(), "whitespace is no run");
        assert_eq!(run_at(&text, 2., 25.).unwrap().0, "next");
    }
}
