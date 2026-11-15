//! The PDF's comments beside its pages, as the Tauri app's
//! `pdf-comment-column.tsx` and `use-pdf-comment-column.ts` show them,
//! Word's review margin: each card level with its numbered mark
//! (`comment_margin.rs`), following the pages as they scroll and zoom. A
//! card reads as the comment's preview; choosing it (or its mark on the
//! page) opens it in place as the card the source editor shows, with
//! Resolve and Reply. The comments are the project's own, so what is
//! written on either side shows on the other.
//!
//! Docked beside the pages by default while the PDF area is wide enough
//! (the pages give it their width, which a fitted zoom follows), folded
//! away when narrow and opened over the pages' right side when asked for;
//! either way as the writer last chose while this PDF is open. Its width is
//! the writer's, dragged at its left edge (a double-click puts it back) and
//! kept for every PDF.
//!
//! With the column closed, resting the pointer on a passage previews its
//! comment over it after a short rest (`PdfCommentPreview`).

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Duration,
};

use gpui::{
    AnyElement, Bounds, CursorStyle, InteractiveElement as _, IntoElement as _, ParentElement as _,
    Pixels, Point, ScrollHandle, SharedString, StatefulInteractiveElement as _, Styled as _, Task,
    canvas, div, prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, IconButton},
    tokens::{SPACING_4, SPACING_5, SPACING_6},
};

use super::{hover_card::CardBounds, *};
use crate::{
    annotations::card::{self, CardWidth},
    pdf::comment_margin::{MARGIN_CARD_GAP, MarginCard, layout_margin_cards},
};

/// The column's width: as dragged, within these (`PDF_COMMENT_COLUMN_WIDTH`).
const DEFAULT_WIDTH: f32 = 280.;
const MIN_WIDTH: f32 = 240.;
const MAX_WIDTH: f32 = 560.;
/// The narrowest PDF area that keeps the column docked beside the pages:
/// the column's default and room for a page still worth reading, which a
/// docked column always leaves the pages.
const DOCK_MIN_WIDTH: f32 = 640.;
const PAGES_MIN_WIDTH: f32 = 360.;
/// What a folded column leaves of the pages it opens over (`--space-12`).
const FOLDED_PAGES_MARGIN: f32 = 48.;
/// The head's height (a drawer's header).
const HEAD_HEIGHT: f32 = 40.;
/// How long the pointer rests on a passage before its comment previews.
const PREVIEW_DELAY: Duration = Duration::from_millis(300);
/// A card's height before it has drawn.
const CARD_HEIGHT: f32 = 80.;

type Measured = Rc<Cell<Option<Bounds<Pixels>>>>;

pub(in crate::pdf) struct CommentColumn {
    /// Shown or hidden as the writer chose while this PDF is open; `None`
    /// follows the area's width.
    chosen: Option<bool>,
    width: f32,
    /// The left edge's drag: where it started and the width then.
    drag: Option<(Pixels, f32)>,
    area: Measured,
    body: Measured,
    column: Measured,
    /// Where each card was last drawn, by comment: its height places the
    /// cards.
    slots: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    list: ScrollHandle,
    /// The comment previewing over its passage, and the rest before it does.
    preview: Option<String>,
    resting: Option<Task<()>>,
    preview_bounds: CardBounds,
}

impl Default for CommentColumn {
    fn default() -> Self {
        let width = crate::pdf::preferences::get()
            .comment_column_width
            .unwrap_or(DEFAULT_WIDTH)
            .clamp(MIN_WIDTH, MAX_WIDTH);
        Self {
            chosen: None,
            width,
            drag: None,
            area: Measured::default(),
            body: Measured::default(),
            column: Measured::default(),
            slots: Rc::default(),
            list: ScrollHandle::new(),
            preview: None,
            resting: None,
            preview_bounds: CardBounds::default(),
        }
    }
}

/// How the column stands: docked beside the pages or opened over them, and
/// its drawn width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColumnLayout {
    pub docked: bool,
    pub width: f32,
}

/// The column's layout in an area `area_width` wide holding comments, as
/// the writer `chosen` it with `width` dragged; `None` while it is closed.
pub fn column_layout(area_width: f32, chosen: Option<bool>, width: f32) -> Option<ColumnLayout> {
    let narrow = area_width < DOCK_MIN_WIDTH;
    if !chosen.unwrap_or(!narrow) {
        return None;
    }
    let docked = !narrow;
    let widest = MAX_WIDTH.min(
        area_width
            - if docked {
                PAGES_MIN_WIDTH
            } else {
                FOLDED_PAGES_MARGIN
            },
    );
    Some(ColumnLayout {
        docked,
        width: width.clamp(MIN_WIDTH, widest.max(MIN_WIDTH)),
    })
}

/// Where `bounds` was drawn, recorded each frame.
fn measure(cell: Measured) -> impl gpui::IntoElement {
    canvas(move |bounds, _, _| cell.set(Some(bounds)), |_, _, _, _| {})
        .absolute()
        .inset_0()
}

impl PdfView {
    /// How the column stands now; `None` while it is closed or there is no
    /// comment drawn on the pages.
    fn column_layout(&self) -> Option<ColumnLayout> {
        let area = self.column.area.get()?;
        if self.placed_notes().is_empty() {
            return None;
        }
        column_layout(
            f32::from(area.size.width),
            self.column.chosen,
            self.column.width,
        )
    }

    pub(in crate::pdf) fn column_open(&self) -> bool {
        self.column_layout().is_some()
    }

    /// The room a docked column takes from the pages.
    pub(in crate::pdf) fn column_inset(&self) -> f32 {
        self.column_layout()
            .filter(|layout| layout.docked)
            .map_or(0., |layout| layout.width)
    }

    /// Whether `position` is on the open column.
    pub(in crate::pdf) fn on_column(&self, position: Point<Pixels>) -> bool {
        self.column_open()
            && self
                .column
                .column
                .get()
                .is_some_and(|column| column.contains(&position))
    }

    /// Show or hide the column, as the writer chose.
    fn choose_column(&mut self, open: bool, cx: &mut Context<Self>) {
        self.column.chosen = Some(open);
        if !open {
            self.open_note_card(None, cx);
        }
        cx.notify();
    }

    /// The pointer rests on `id`'s passage (`None`: on none): its comment
    /// previews over it after a short rest, while the column is closed.
    pub(in crate::pdf) fn rest_on_note(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.column.resting = None;
        if self.column.preview.take().is_some() {
            cx.notify();
        }
        let Some(id) = id else {
            return;
        };
        let timer = cx.background_executor().timer(PREVIEW_DELAY);
        self.column.resting = Some(cx.spawn(async move |this, cx| {
            timer.await;
            this.update(cx, |this, cx| {
                if this.note_hovered() == Some(id.as_str()) && this.note_card() != Some(id.as_str())
                {
                    this.column.preview = Some(id);
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// The comment previewing over its passage: lines only, never in the
    /// pointer's way.
    pub(in crate::pdf) fn note_preview_element(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let id = self.column.preview.clone()?;
        if self.column_open() || self.note_card() == Some(id.as_str()) {
            return None;
        }
        let (note, _) = self
            .placed_notes()
            .into_iter()
            .find(|(note, _)| note.id == id)?;
        let about = self.note_passage_on_window(&id)?;
        let palette = cx.palette().clone();
        let content = div()
            .rounded(lattice_ui::tokens::RADIUS_SURFACE)
            .shadow(Elevation::Popover.shadows(&palette))
            .child(card::comment_preview(
                &[note],
                CardWidth::Within(px(300.)),
                cx,
            ));
        let painted = self.column.preview_bounds.clone();
        Some(self.hover_card(
            SharedString::from(format!("pdf-note-preview-{id}")),
            about,
            px(300.),
            painted,
            content,
            window,
            cx,
        ))
    }

    /// The left edge's drag, as the pointer moves.
    pub(in crate::pdf) fn drag_column(&mut self, x: Pixels, cx: &mut Context<Self>) {
        let Some((start, from)) = self.column.drag else {
            return;
        };
        let wanted = from - f32::from(x - start);
        let area = self
            .column
            .area
            .get()
            .map_or(0., |area| f32::from(area.size.width));
        if let Some(layout) = column_layout(area, self.column.chosen, wanted) {
            self.column.width = layout.width;
            cx.notify();
        }
    }

    /// Letting go of the left edge keeps the width for every PDF.
    pub(in crate::pdf) fn end_column_drag(&mut self) -> bool {
        if self.column.drag.take().is_none() {
            return false;
        }
        let width = self.column.width;
        crate::pdf::preferences::update(|preferences| {
            preferences.comment_column_width = Some(width.round())
        });
        true
    }

    pub(in crate::pdf) fn column_dragging(&self) -> bool {
        self.column.drag.is_some()
    }

    /// The column, or the button that brings a folded one back; and the
    /// area's measure, which decides between them.
    pub(in crate::pdf) fn comment_column(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let mut out = vec![measure(self.column.area.clone()).into_any_element()];
        let marks = self.placed_notes();
        if marks.is_empty() {
            return out;
        }
        let palette = cx.palette().clone();
        let count = marks.len();
        let Some(layout) = self.column_layout() else {
            if self.column.area.get().is_some() {
                out.push(
                    div()
                        .absolute()
                        .top(SPACING_4)
                        .right(SPACING_4)
                        .rounded(lattice_ui::tokens::RADIUS_CONTROL)
                        .shadow(Elevation::Raised.shadows(&palette))
                        .child(
                            Button::new("pdf-comment-toggle", count.to_string())
                                .size(ButtonSize::Compact)
                                .icon(Icon::MESSAGE_SQUARE_TEXT)
                                .tooltip(t!("Show comments"))
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.choose_column(true, cx)),
                                ),
                        )
                        .into_any_element(),
                );
            }
            return out;
        };
        let active = self.note_card().map(str::to_string);
        let hovered = self.note_hovered().map(str::to_string);
        let on = self.note_card_action(cx);
        let slots: Vec<(String, AnyElement)> = marks
            .iter()
            .map(|(note, _)| {
                let id = note.id.clone();
                let open = active.as_deref() == Some(id.as_str());
                let lit = hovered.as_deref() == Some(id.as_str());
                let content = if open {
                    card::comment_card_sized(
                        std::slice::from_ref(note),
                        on.clone(),
                        CardWidth::Filling,
                        cx,
                    )
                } else {
                    let choose = id.clone();
                    div()
                        .id(SharedString::from(format!("pdf-comment-preview-{id}")))
                        .rounded(lattice_ui::tokens::RADIUS_SURFACE)
                        .cursor_pointer()
                        .shadow(
                            if lit {
                                Elevation::Popover
                            } else {
                                Elevation::Raised
                            }
                            .shadows(&palette),
                        )
                        .child(card::comment_preview(
                            std::slice::from_ref(note),
                            CardWidth::Filling,
                            cx,
                        ))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.open_note_card(Some(choose.clone()), cx)
                        }))
                        .into_any_element()
                };
                let light = id.clone();
                let slots_drawn = self.column.slots.clone();
                let measured = id.clone();
                let view = cx.entity().downgrade();
                let slot = div()
                    .id(SharedString::from(format!("pdf-comment-slot-{id}")))
                    .relative()
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered {
                            this.light_note(Some(light.clone()), cx);
                        }
                    }))
                    .child(content)
                    .child(
                        canvas(
                            move |bounds, _, cx| {
                                let before =
                                    slots_drawn.borrow_mut().insert(measured.clone(), bounds);
                                let resized = before.is_none_or(|before| {
                                    (before.size.height - bounds.size.height).abs() > px(0.5)
                                });
                                if resized {
                                    let view = view.clone();
                                    cx.defer(move |cx| {
                                        view.update(cx, |_, cx| cx.notify()).ok();
                                    });
                                }
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .inset_0(),
                    )
                    .into_any_element();
                (id, slot)
            })
            .collect();
        let body = if layout.docked {
            self.docked_body(&marks, slots, active.as_deref(), window.rem_size())
        } else {
            div()
                .id("pdf-comment-column-list")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .track_scroll(&self.column.list)
                .flex()
                .flex_col()
                .gap(SPACING_4)
                .pt(px(4.))
                .px(SPACING_4)
                .pb(SPACING_6)
                .children(slots.into_iter().map(|(_, slot)| slot))
                .into_any_element()
        };
        let head = div()
            .flex_none()
            .h(px(HEAD_HEIGHT))
            .flex()
            .items_center()
            .gap(px(8.))
            .pl(SPACING_6)
            .pr(SPACING_4)
            .child(
                div()
                    .text_role(TextRole::Subtitle, cx)
                    .text_color(palette.text)
                    .child(t!("Comments")),
            )
            .child(
                div()
                    .flex_1()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .font_features(lattice_ui::typography::tabular_nums())
                    .child(count.to_string()),
            )
            .child(
                IconButton::new("pdf-comment-column-hide", Icon::CLOSE)
                    .frame(px(24.), px(24.))
                    .tooltip(t!("Hide comments"))
                    .on_click(cx.listener(|this, _, _, cx| this.choose_column(false, cx))),
            );
        let grip = div()
            .id("pdf-comment-column-resizer")
            .absolute()
            .top_0()
            .bottom_0()
            .left(px(-3.))
            .w(px(6.))
            .cursor(CursorStyle::ResizeLeftRight)
            .when(self.column.drag.is_some(), |grip| grip.bg(palette.line))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                    cx.stop_propagation();
                    if event.click_count == 2 {
                        this.column.drag = Some((event.position.x, DEFAULT_WIDTH));
                        this.drag_column(event.position.x, cx);
                        this.end_column_drag();
                        return;
                    }
                    this.column.drag = Some((event.position.x, this.column.width));
                    cx.notify();
                }),
            );
        let column = div()
            .id("pdf-comment-column")
            .absolute()
            .top_0()
            .bottom_0()
            .right_0()
            .w(px(layout.width))
            .flex()
            .flex_col()
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !*hovered {
                    this.light_note(None, cx);
                }
            }))
            .map(|column| {
                if layout.docked {
                    column.border_l_1().border_color(palette.line)
                } else {
                    column
                        .bg(palette.panel)
                        .shadow(Elevation::Floating.shadows(&palette))
                }
            })
            .child(measure(self.column.column.clone()))
            .child(head)
            .child(body)
            .child(grip);
        out.push(column.into_any_element());
        out
    }

    /// Docked, each card stands level with its mark on the pages beside it,
    /// in a body that clips them; scrolling the pages slides them all.
    fn docked_body(
        &self,
        marks: &[(
            lattice_core::project::EditorComment,
            crate::pdf::annotation_place::MarkPlace,
        )],
        slots: Vec<(String, AnyElement)>,
        active: Option<&str>,
        rem: Pixels,
    ) -> AnyElement {
        let lead_preview = f32::from(SPACING_4.to_pixels(rem)) + 10.;
        let lead_card = f32::from(SPACING_5.to_pixels(rem)) + 10.;
        let drawn = self.column.slots.borrow();
        let cards: Vec<MarginCard> = marks
            .iter()
            .filter_map(|(note, place)| {
                let rect = self.layout.page(place.page)?;
                let lead = if active == Some(note.id.as_str()) {
                    lead_card
                } else {
                    lead_preview
                };
                Some(MarginCard {
                    id: note.id.clone(),
                    anchor: rect.y + place.pin.y * rect.h - lead,
                    height: drawn
                        .get(&note.id)
                        .map_or(CARD_HEIGHT, |slot| f32::from(slot.size.height)),
                })
            })
            .collect();
        let tops = layout_margin_cards(&cards, active, MARGIN_CARD_GAP);
        let tops: HashMap<&str, f32> = cards
            .iter()
            .map(|card| card.id.as_str())
            .zip(tops)
            .collect();
        let (_, scroll_y) = self.scroll_offset();
        // From the pages' scroll coordinates to the body's.
        let shift = self.column.body.get().map_or(PAGE_INSET_FALLBACK, |body| {
            f32::from(self.viewport.top() - body.top())
        });
        div()
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(measure(self.column.body.clone()))
            .children(slots.into_iter().filter_map(|(id, slot)| {
                let top = *tops.get(id.as_str())?;
                Some(
                    div()
                        .absolute()
                        .left(SPACING_4)
                        .right(SPACING_4)
                        .top(px(top - scroll_y + shift))
                        .child(slot),
                )
            }))
            .into_any_element()
    }

    /// Whether the column is open and docked, and how wide, for a scenario.
    pub fn comment_column_layout(&self) -> Option<ColumnLayout> {
        self.column_layout()
    }

    /// The middle of the open column on the window, for a scenario.
    pub fn comment_column_center(&self) -> Option<Point<Pixels>> {
        self.column.column.get().map(|column| column.center())
    }

    /// Where `id`'s card in the column was last drawn, for a scenario.
    pub fn comment_slot(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.column_open()
            .then(|| self.column.slots.borrow().get(id).copied())
            .flatten()
    }

    /// The comment previewing over its passage, for a scenario.
    pub fn note_preview(&self) -> Option<&str> {
        self.column.preview.as_deref()
    }

    /// Show or hide the column as its buttons do, for a scenario.
    pub fn choose_comment_column(&mut self, open: bool, cx: &mut Context<Self>) {
        self.choose_column(open, cx);
    }
}

/// The body's offset from the pages before it has been measured.
const PAGE_INSET_FALLBACK: f32 = -(HEAD_HEIGHT - crate::pdf::layout::PAGE_INSET);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docks_beside_wide_pages_and_folds_away_on_narrow_ones() {
        // `use-pdf-comment-column.ts`: docked from 640px, as wide as dragged
        // while the pages keep 360px.
        assert_eq!(
            column_layout(1000., None, 280.),
            Some(ColumnLayout {
                docked: true,
                width: 280.
            })
        );
        assert_eq!(
            column_layout(700., None, 500.),
            Some(ColumnLayout {
                docked: true,
                width: 340.
            })
        );
        // Narrow: folded unless asked for, then over the pages, 48px short.
        assert_eq!(column_layout(500., None, 280.), None);
        assert_eq!(
            column_layout(500., Some(true), 560.),
            Some(ColumnLayout {
                docked: false,
                width: 452.
            })
        );
        // Hidden as the writer chose, however wide.
        assert_eq!(column_layout(1200., Some(false), 280.), None);
        // Never narrower than its least.
        assert_eq!(
            column_layout(620., Some(true), 100.),
            Some(ColumnLayout {
                docked: false,
                width: 240.
            })
        );
    }
}
