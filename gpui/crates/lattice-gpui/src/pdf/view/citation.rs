//! A citation's card over its link in the PDF, as the Tauri app's
//! `pdf-citation-hover.tsx` shows it: the pointer resting 250 ms on a link
//! whose destination is `cite.KEY` (biblatex's `cite.N@KEY`) opens the
//! entry's card above it (below when there is no room), kept in the window
//! 8px from its edges; the card stays while the pointer is on the link or on
//! it, and closes 180 ms after it leaves both, or at once on a click, a
//! scroll or zoom, or Escape. The key is read from the link's destination
//! name, never from the visible number.
//!
//! The card is the PDF's own (`.citation-hover-card.pdf-citation-hover`):
//! the key as a quiet chip, the title in the reading face (a button that
//! opens the paper when the host can open it, `canOpenCitation`), the
//! authors, then the venue and year in italics. It enters and leaves as
//! every hover card does (`.popup-motion`).

use std::rc::Rc;

use gpui::{
    Anchor as Corner, AnyElement, App, Bounds, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, Pixels, SharedString, StatefulInteractiveElement as _,
    Styled as _, Task, Window, anchored, canvas, deferred, div, point, prelude::FluentBuilder as _,
    px,
};
use lattice_editor::{
    index::Citation,
    latex::cards::{byline_authors, card_surface, reading_font},
};
use lattice_ui::{
    ActiveLattice as _, TextRole, TextRoleStyle as _,
    components::{PopFrom, pop_in},
};

use super::*;
use crate::pdf::citation_keys;

/// How long the pointer rests on a citation before its card opens.
const OPEN_AFTER: Duration = Duration::from_millis(250);
/// How long the pointer may be off the link and the card before it closes.
const CLOSE_AFTER: Duration = Duration::from_millis(180);
/// The card's gap from its link (`offset(8)`) and from the window's edges
/// (`shift({ padding: 8 })`).
const CARD_GAP: Pixels = px(8.);
const CARD_WIDTH: Pixels = px(360.);

/// The entry cited under a key, as the bibliography has it.
pub type FindCitation = Rc<dyn Fn(&str, &App) -> Option<Citation>>;
/// Whether a card's title opens the paper cited under a key.
pub type CanOpenCitation = Rc<dyn Fn(&str, &App) -> bool>;

/// What the host tells the PDF of the project's citations.
#[derive(Clone)]
pub struct CitationLookup {
    pub find: FindCitation,
    /// `canOpenCitation`.
    pub can_open: CanOpenCitation,
}

/// The citation link the pointer is on, by its page and its index there.
#[derive(Clone, Copy, PartialEq)]
struct Target {
    page: usize,
    link: usize,
}

#[derive(Default)]
pub(in crate::pdf) struct CitationHover {
    /// The link the pointer is on, waiting out [`OPEN_AFTER`].
    pending: Option<(Target, Task<()>)>,
    /// The card shown: its link, its entry, and the scroll it was opened at
    /// (a scroll or zoom takes it away).
    shown: Option<Shown>,
    /// The pointer left the link and the card; it closes when this ends.
    closing: Option<Task<()>>,
    /// The card's bounds last frame, for placing it above or below.
    card: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
}

struct Shown {
    target: Target,
    citation: Citation,
    scroll: (f32, f32),
    scale: f32,
}

impl PdfView {
    /// Tell the viewer how to read the project's citations; `None` shows
    /// no cards.
    pub fn set_citations(&mut self, lookup: Option<CitationLookup>, cx: &mut Context<Self>) {
        self.citations = lookup;
        if self.citations.is_none() {
            self.dismiss_citation(cx);
        }
    }

    /// The citation the link at (`x`, `y`) of `page` names, with its index.
    fn citation_at(&self, page: usize, x: f32, y: f32, cx: &App) -> Option<(Target, Citation)> {
        let lookup = self.citations.as_ref()?;
        let text = self.pages.get(page)?.text.as_ref()?;
        let (link, found) = text
            .links
            .iter()
            .enumerate()
            .find(|(_, link)| link.contains(x, y))?;
        let (key, bare) = citation_keys(found.name.as_deref()?)?;
        let citation = (lookup.find)(key, cx).or_else(|| (lookup.find)(bare?, cx))?;
        Some((Target { page, link }, citation))
    }

    /// The pointer moved over the pages at a window `position`, no button
    /// held: a citation's card opens, waits, or starts closing.
    pub(in crate::pdf) fn hover_citation(
        &mut self,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let (x, y) = self.sheet_point(position);
        let over = self
            .layout
            .to_page(x, y)
            .and_then(|(page, x, y)| self.citation_at(page, x, y, cx));
        let hover = &mut self.citation;
        match over {
            Some((target, citation)) => {
                if hover
                    .shown
                    .as_ref()
                    .is_some_and(|shown| shown.target == target)
                {
                    hover.closing = None;
                    return;
                }
                if hover.pending.as_ref().is_some_and(|(at, _)| *at == target) {
                    return;
                }
                hover.closing = None;
                let task = cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(OPEN_AFTER).await;
                    this.update(cx, |this, cx| {
                        this.citation.pending = None;
                        this.citation.shown = Some(Shown {
                            target,
                            citation,
                            scroll: this.scroll_offset(),
                            scale: this.layout.scale,
                        });
                        cx.notify();
                    })
                    .ok();
                });
                hover.pending = Some((target, task));
            }
            None => {
                hover.pending = None;
                self.close_citation_soon(cx);
            }
        }
    }

    /// Close the card after [`CLOSE_AFTER`], unless the pointer comes back.
    fn close_citation_soon(&mut self, cx: &mut Context<Self>) {
        if self.citation.shown.is_none() || self.citation.closing.is_some() {
            return;
        }
        self.citation.closing = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CLOSE_AFTER).await;
            this.update(cx, |this, cx| this.dismiss_citation(cx)).ok();
        }));
    }

    /// Close the card at once, and forget a card about to open.
    pub(in crate::pdf) fn dismiss_citation(&mut self, cx: &mut Context<Self>) {
        let had = self.citation.shown.take().is_some();
        self.citation.pending = None;
        self.citation.closing = None;
        if had {
            cx.notify();
        }
    }

    /// The key of the citation whose card is shown, for a scenario.
    pub fn citation_card(&self) -> Option<&str> {
        self.citation
            .shown
            .as_ref()
            .map(|shown| shown.citation.key.as_str())
    }

    /// Where on the window the first link to `name` that is on screen
    /// centres, for a scenario to rest the pointer on.
    pub fn named_link_center(&self, name: &str) -> Option<Point<Pixels>> {
        let scale = self.layout.scale;
        let (scroll_x, scroll_y) = self.scroll_offset();
        let origin = self.viewport.origin;
        self.pages.iter().enumerate().find_map(|(ix, slot)| {
            let link = slot
                .text
                .as_ref()?
                .links
                .iter()
                .find(|link| link.name.as_deref() == Some(name))?;
            let page = self.layout.page(ix)?;
            Some(point(
                origin.x + px(page.x + (link.x0 + link.x1) / 2. * scale - scroll_x),
                origin.y + px(page.y + (link.y0 + link.y1) / 2. * scale - scroll_y),
            ))
        })
    }

    /// The card, drawn over everything at its link; `None` when none shows
    /// or its link has scrolled or zoomed away.
    pub(in crate::pdf) fn citation_card_element(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let shown = self.citation.shown.as_ref()?;
        if shown.scroll != self.scroll_offset() || shown.scale != self.layout.scale {
            // A scroll or zoom invalidates the hover (`scroll`/`wheel`
            // dismiss), after this frame.
            cx.defer_in(window, |this, _, cx| this.dismiss_citation(cx));
            return None;
        }
        let page = self.layout.page(shown.target.page)?;
        let link = self
            .pages
            .get(shown.target.page)?
            .text
            .as_ref()?
            .links
            .get(shown.target.link)?
            .clone();
        let scale = self.layout.scale;
        let (scroll_x, scroll_y) = self.scroll_offset();
        let origin = self.viewport.origin;
        let rect = Bounds::from_corners(
            point(
                origin.x + px(page.x + link.x0 * scale - scroll_x),
                origin.y + px(page.y + link.y0 * scale - scroll_y),
            ),
            point(
                origin.x + px(page.x + link.x1 * scale - scroll_x),
                origin.y + px(page.y + link.y1 * scale - scroll_y),
            ),
        );
        // Centred above the link (`placement: "top"`), flipped below when
        // the card would cross the window's top, and shifted to stay 8px
        // inside the window's sides (`shift({ padding: 8 })`); its size is
        // last frame's.
        let last = self.citation.card.get().map(|card| card.size);
        let window_width = window.viewport_size().width;
        let width = last.map_or(card_width(window_width), |size| size.width);
        let height = last.map_or(px(0.), |size| size.height);
        let above = rect.top() - CARD_GAP - height >= CARD_GAP;
        let left = (rect.center().x - width / 2.)
            .min(window_width - CARD_GAP - width)
            .max(CARD_GAP);
        let (at, anchor, from) = if above {
            (
                point(left, rect.top() - CARD_GAP),
                Corner::BottomLeft,
                PopFrom::Below,
            )
        } else {
            (
                point(left, rect.bottom() + CARD_GAP),
                Corner::TopLeft,
                PopFrom::Above,
            )
        };
        let key = shown.citation.key.clone();
        let can_open = self
            .citations
            .as_ref()
            .is_some_and(|lookup| (lookup.can_open)(&key, cx));
        let citation = shown.citation.clone();
        let view = cx.entity().downgrade();
        let opened = {
            let view = view.clone();
            let key = key.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                view.update(cx, |this, cx| {
                    this.dismiss_citation(cx);
                    cx.emit(PdfViewEvent::OpenCitation(key.clone()));
                })
                .ok();
            }
        };
        let hovered = cx.listener(|this, hovered: &bool, _, cx| {
            if *hovered {
                this.citation.closing = None;
            } else {
                this.close_citation_soon(cx);
            }
        });
        let painted = self.citation.card.clone();
        let record = canvas(
            move |bounds, _, _| painted.set(Some(bounds)),
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        let card = citation_card(
            &citation,
            can_open.then_some(opened),
            window.viewport_size().width,
            cx,
        );
        let content = div()
            .id("pdf-citation-card")
            .occlude()
            .on_hover(hovered)
            .child(card)
            .child(record);
        Some(
            deferred(
                anchored()
                    .position(at)
                    .anchor(anchor)
                    .snap_to_window_with_margin(CARD_GAP)
                    .child(pop_in(
                        SharedString::from(format!(
                            "pdf-citation-{}-{}",
                            shown.target.page, shown.target.link
                        )),
                        from,
                        content,
                    )),
            )
            .with_priority(1)
            .into_any_element(),
        )
    }
}

/// The card's face: the key, the title (opening the paper through `open`
/// when given), the authors, the venue and year.
fn citation_card(
    citation: &Citation,
    open: Option<impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static>,
    window_width: Pixels,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let heading = if citation.title.is_empty() {
        citation.key.clone()
    } else {
        citation.title.clone()
    };
    // `width: min(360px, 100vw - 32px)`; a card that narrow steps its title
    // down to the reading size (`@container (max-width: 260px)`).
    let width = card_width(window_width);
    let narrow = width - px(32.) <= px(260.);
    let (reading, fallbacks) = reading_font(cx);
    let (size, leading) = if narrow {
        (
            lattice_ui::tokens::TEXT_TYPESET,
            lattice_ui::tokens::LEADING_BODY,
        )
    } else {
        (
            lattice_ui::tokens::TEXT_TITLE,
            lattice_ui::tokens::LEADING_TITLE,
        )
    };
    let mut title = div()
        .id("pdf-citation-card-title")
        .max_w_full()
        .font_family(reading.clone())
        .text_size(size)
        .line_height(leading)
        .font_weight(FontWeight::NORMAL)
        .text_color(palette.text)
        .line_clamp(4)
        .child(heading);
    title.text_style().font_fallbacks = Some(fallbacks.clone());
    let title = match open {
        Some(open) => title
            .cursor_pointer()
            .hover(|style| style.underline())
            .on_click(open)
            .into_any_element(),
        None => title.into_any_element(),
    };
    let byline = byline_authors(&citation.authors);
    // No-break spaces keep the year with the venue's last word.
    let publication = [citation.venue.as_str(), citation.year.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(",\u{a0}");
    let secondary: Hsla = palette.text_secondary;
    card_surface(cx)
        .w(width)
        .items_start()
        .pt(px(12.))
        .px(px(16.))
        .pb(px(8.))
        .text_role(TextRole::Body, cx)
        .child(
            div()
                .max_w_full()
                .mb(px(4.))
                .px(px(6.))
                .py(px(1.))
                .rounded(px(4.))
                .bg(palette.hover)
                .text_color(palette.text)
                .font_family(cx.lattice().fonts.editor.clone())
                .text_size(lattice_ui::tokens::TEXT_MICRO)
                .line_height(lattice_ui::tokens::LEADING_MICRO)
                .truncate()
                .child(citation.key.clone()),
        )
        .child(title)
        .when_some(byline, |card, byline| {
            card.child(
                div()
                    .mt(px(2.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(secondary)
                    .line_clamp(2)
                    .child(byline),
            )
        })
        .when(!publication.is_empty(), |card| {
            let mut venue = div()
                .font_family(reading)
                .text_size(lattice_ui::tokens::TEXT_BODY)
                .line_height(lattice_ui::tokens::LEADING_SUBTITLE)
                .italic()
                .text_color(secondary)
                .line_clamp(2)
                .child(publication);
            venue.text_style().font_fallbacks = Some(fallbacks);
            card.child(venue)
        })
        .into_any_element()
}

/// `width: min(360px, 100vw - 32px)`.
fn card_width(window_width: Pixels) -> Pixels {
    CARD_WIDTH.min(window_width - px(32.)).max(px(160.))
}
