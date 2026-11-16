//! Copy source link and Add to note on the original PDF
//! (`paper-selection-actions.tsx`, `.paper-selection-actions` in
//! `editor-workspace.css`): once a drag has selected text on a page, one
//! pill stands where the selection ends, right-aligned there and kept
//! inside the reader, like the compiled PDF's Annotate offer.
//!
//! The link is the one the alphaXiv overview writes: the paper's PDF at the
//! passage's page, its first and last words (the fewest that find it once on
//! that page) in the title, so following it highlights the passage. Add to
//! note appends the quote and that link to the paper's note
//! (`notes/<citation key>.md`), and its notice opens the note.
//!
//! A press anywhere else, a scroll, a zoom or Escape takes the offer away
//! (the viewer's own rules for Annotate); an action under way keeps it,
//! a new selection waiting until that action is done.
//!
//! The full text offers the same actions from its own page, where the
//! Tauri app's component runs as it is (`structured/markdown/paper_quotes.rs`
//! answers what it asks of the app).

use std::{cell::Cell, rc::Rc};

type ButtonBounds = Rc<Cell<[Option<Bounds<Pixels>>; 2]>>;

use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, InteractiveElement as _, IntoElement as _,
    ParentElement as _, Pixels, StatefulInteractiveElement as _, Styled as _, Task, canvas, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::{fill_named, t, tr};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{PopFrom, ToastLevel, pop_in},
};

use super::{PaperReader, PaperReaderEvent, pdf::pdf_source, quote_page::locate_quote};
use crate::notices::{self, Notice, NoticeAction};
use crate::papers::{
    paper_note::{add_to_note, note_path, reading_href},
    source_link::{
        SourcePlace, find_source_quote, quote_markdown, source_href, source_link,
        source_quote_anchors,
    },
};
use crate::pdf::OfferedSelection;

/// Inside the reader by at least this much (`margin` in the component).
const MARGIN: f32 = 8.;
/// Under the selection's last line by this much.
const GAP: f32 = 4.;
/// The pill's height: a compact control (28px), its buttons 2px inside it.
const HEIGHT: f32 = 28.;

/// One of the two actions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteAction {
    Copy,
    Note,
}

/// The selection offered, and the action under way on it.
struct Offer {
    selection: OfferedSelection,
    busy: Option<QuoteAction>,
}

/// The reader's offer on the PDF, and where the reader's body was drawn,
/// which the pill is placed in.
#[derive(Default)]
pub(super) struct Selecting {
    offer: Option<Offer>,
    body: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// Where each action was drawn, for a scenario's click.
    buttons: ButtonBounds,
}

impl PaperReader {
    /// The PDF offered a selection, or took its offer away.
    pub(super) fn offer_quote(
        &mut self,
        offered: Option<OfferedSelection>,
        cx: &mut Context<Self>,
    ) {
        // A new selection waits for an action under way to finish with the
        // old one.
        if self
            .selecting
            .offer
            .as_ref()
            .is_some_and(|offer| offer.busy.is_some())
        {
            return;
        }
        self.selecting.offer = offered.map(|selection| Offer {
            selection,
            busy: None,
        });
        cx.notify();
    }

    /// The actions on offer, and the one under way (for scenarios).
    pub fn quote_offer(&self) -> Option<(String, Option<QuoteAction>)> {
        let offer = self.selecting.offer.as_ref()?;
        Some((offer.selection.text.clone(), offer.busy))
    }

    /// Where `action`'s button was last drawn on the window, while the
    /// actions are on offer (for scenarios).
    pub fn quote_action_center(&self, action: QuoteAction) -> Option<gpui::Point<Pixels>> {
        self.selecting.offer.as_ref()?;
        self.selecting.buttons.get()[action as usize].map(|bounds| bounds.center())
    }

    /// Run `action` on the selection offered.
    fn run_quote(&mut self, action: QuoteAction, cx: &mut Context<Self>) {
        let Some(offer) = self
            .selecting
            .offer
            .as_mut()
            .filter(|offer| offer.busy.is_none())
        else {
            return;
        };
        offer.busy = Some(action);
        let selection = offer.selection.clone();
        // The passage's place: on its page, by the fewest words that find it
        // once there.
        let page_text = selection.page_text.clone();
        let place = source_quote_anchors(&selection.text, |first, last| {
            find_source_quote(&page_text, first, last).is_some()
        })
        .map(|(first, last)| SourcePlace {
            page: selection.page as u32 + 1,
            first,
            last,
        });
        // Only an empty selection has no place on its page; the PDF is
        // searched for it then, as for a passage of the full text.
        let pdf = self.quote_pdf();
        let located: Task<Result<Option<SourcePlace>, String>> = match (place, pdf) {
            (Some(place), _) => Task::ready(Ok(Some(place))),
            (None, Some(pdf)) => locate_quote(pdf, selection.text.clone(), cx),
            (None, None) => Task::ready(Ok(None)),
        };
        let paper = self.paper.clone();
        let root = self.root.clone();
        cx.spawn(async move |this, cx| {
            let located = located.await;
            let link_at = |place: &SourcePlace| {
                let href = source_href(&paper, place.page)?;
                let label = t!("p. {0}", place.page);
                Some(source_link(
                    &label,
                    &href,
                    &(place.first.clone(), place.last.clone()),
                ))
            };
            match action {
                QuoteAction::Copy => {
                    let link = located.map(|place| place.as_ref().and_then(link_at));
                    this.update(cx, |this, cx| {
                        copy_link(link, cx);
                        this.finish_quote(cx);
                    })
                    .ok();
                }
                QuoteAction::Note => {
                    // A passage the PDF does not hold, or a PDF out of
                    // reach, still links to the paper, in its reading here.
                    let link = located
                        .ok()
                        .flatten()
                        .as_ref()
                        .and_then(link_at)
                        .unwrap_or_else(|| {
                            let href = reading_href(&note_path(&paper), &paper.arxiv_id, true);
                            format!("[{}]({href})", t!("Full text"))
                        });
                    let entry = quote_markdown(&selection.text, &link);
                    let written = cx
                        .background_executor()
                        .spawn(async move { add_to_note(&root, &paper, &entry) })
                        .await;
                    this.update(cx, |this, cx| {
                        this.noted(written, cx);
                        this.finish_quote(cx);
                    })
                    .ok();
                }
            }
        })
        .detach();
        cx.notify();
    }

    /// The action is done: the offer goes with it.
    fn finish_quote(&mut self, cx: &mut Context<Self>) {
        self.selecting.offer = None;
        cx.notify();
    }

    /// Say where the passage went, with the way to the note.
    fn noted(&mut self, written: Result<String, String>, cx: &mut Context<Self>) {
        match written {
            Ok(path) => {
                let reader = cx.entity().downgrade();
                let open = path.clone();
                let title = fill_named(tr("Added to {path}"), &[("path", &path)]);
                notices::show(
                    Notice::new(ToastLevel::Success, title)
                        .source(t!("Papers"))
                        .action(NoticeAction::new(t!("Open note"), move |_, cx| {
                            let path = open.clone();
                            reader
                                .update(cx, |_, cx| cx.emit(PaperReaderEvent::OpenPath(path)))
                                .ok();
                        })),
                    cx,
                );
            }
            Err(reason) => notices::show(
                Notice::new(ToastLevel::Error, t!("Could not add to the note"))
                    .source(t!("Papers"))
                    .detail(reason),
                cx,
            ),
        }
    }

    /// The PDF a passage is looked up in: the one the reader shows.
    pub(super) fn quote_pdf(&self) -> Option<super::quote_page::QuotePdf> {
        use super::{pdf::PdfSource, quote_page::QuotePdf};
        Some(match pdf_source(&self.paper)? {
            PdfSource::Local(relative) => QuotePdf::File(self.root.join(relative)),
            PdfSource::Remote(url) => QuotePdf::Web(url),
        })
    }

    /// The PDF's place in the reader, recorded as it is drawn, so the pill
    /// is placed within it.
    pub(super) fn quote_bounds(&self) -> impl gpui::IntoElement + use<> {
        let body = self.selecting.body.clone();
        canvas(move |bounds, _, _| body.set(Some(bounds)), |_, _, _, _| {})
            .absolute()
            .size_full()
    }

    /// The pill at the selection's end: Copy source link, then Add to note.
    pub(super) fn quote_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let offer = self.selecting.offer.as_ref()?;
        let body = self.selecting.body.get()?;
        let end = offer.selection.end;
        let palette = cx.palette().clone();
        // Right-aligned at the selection's end, and under it, kept inside
        // the reader.
        let right = (body.right() - end.right()).max(px(MARGIN));
        let top = (end.bottom() - body.top() + px(GAP))
            .min(body.size.height - px(HEIGHT + MARGIN))
            .max(px(MARGIN));
        let busy = offer.busy;
        let button =
            |action: QuoteAction, icon: Icon, label: &'static str, cx: &mut Context<Self>| {
                let idle = busy.is_none();
                let ink = if idle {
                    palette.text
                } else {
                    palette.text_secondary
                };
                let mark = if busy == Some(action) {
                    lattice_ui::loading::loader(
                        ("paper-selection-busy", action as usize),
                        px(13.),
                        palette.text_secondary,
                        cx,
                    )
                } else {
                    icon.element(px(13.), ink).into_any_element()
                };
                div()
                    .id(("paper-selection-action", action as usize))
                    .relative()
                    .flex()
                    .flex_none()
                    .min_w_0()
                    .items_center()
                    .gap(px(4.))
                    .h(px(HEIGHT - 4.))
                    .px(px(10.))
                    .rounded_full()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(ink)
                    .whitespace_nowrap()
                    .when(idle, |button| {
                        button
                            .cursor_pointer()
                            .hover(|style| style.bg(palette.hover))
                            .on_click(cx.listener(move |this, _, _, cx| this.run_quote(action, cx)))
                    })
                    .child({
                        let buttons = self.selecting.buttons.clone();
                        canvas(
                            move |bounds, _, _| {
                                let mut drawn = buttons.get();
                                drawn[action as usize] = Some(bounds);
                                buttons.set(drawn);
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full()
                    })
                    .child(mark)
                    .child(div().min_w_0().truncate().child(label))
            };
        let copy = button(QuoteAction::Copy, Icon::LINK_2, t!("Copy source link"), cx);
        let note = button(QuoteAction::Note, Icon::NOTEBOOK_PEN, t!("Add to note"), cx);
        let pill = div()
            .id("paper-selection-actions")
            .flex()
            .gap(px(2.))
            .p(px(2.))
            .max_w(body.size.width - px(16.))
            .rounded_full()
            .bg(palette.raised)
            .shadow(Elevation::Popover.shadows(&palette))
            .occlude()
            // Choosing an action keeps the selection; a press anywhere
            // else ends the offer.
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_up(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                if this
                    .selecting
                    .offer
                    .as_ref()
                    .is_some_and(|offer| offer.busy.is_none())
                {
                    this.selecting.offer = None;
                    cx.notify();
                }
            }))
            .child(copy)
            .child(note);
        Some(
            div()
                .absolute()
                .right(right)
                .top(top)
                .child(pop_in("paper-selection-actions-in", PopFrom::Above, pill))
                .into_any_element(),
        )
    }
}

/// Put `link` on the clipboard and say so; a passage the PDF does not hold
/// has no link to copy.
fn copy_link(link: Result<Option<String>, String>, cx: &mut App) {
    match link {
        Ok(Some(link)) => {
            cx.write_to_clipboard(ClipboardItem::new_string(link));
            notices::copied(t!("Source link copied"), cx);
        }
        Ok(None) => notices::show(
            Notice::new(
                ToastLevel::Warning,
                t!("Could not find this passage in the PDF"),
            )
            .source(t!("Papers")),
            cx,
        ),
        Err(reason) => notices::show(
            Notice::new(ToastLevel::Error, t!("Could not copy the source link"))
                .source(t!("Papers"))
                .detail(reason),
            cx,
        ),
    }
}
