//! Margin review (`src/overleaf/overleaf-margin-review.tsx`,
//! `margin-review-layout.ts`): a linked file's unresolved comment threads
//! and its live suggestions beside their lines in the source.
//!
//! Its layout follows the editor's width, decided from the last frame's:
//!
//! - wide, when the editor has room for the text's 88-column measure, a 24px
//!   gap, a 268px card and the rail's 36px: the text is capped at the
//!   measure and each item is a card beside its line, stacked so none
//!   overlaps the one above (each at its line, less 6px, or 8px under the
//!   card before);
//! - markers, otherwise (or when asked for): a 14px pip per item in the
//!   lane at the text's right, a comment's a pill with its message count, a
//!   suggestion's a square with + or −, opening its card in a popover on a
//!   click or after the pointer rests 120 ms, closing 200 ms after it leaves;
//! - in an editor narrower than 480px, a pip opens the rail instead: every
//!   item, in a column over the editor's right side.
//!
//! The window's mode (View › Margin review in the Tauri app, the palette's
//! "Margin review: …" here) is Auto, Markers only or Off. A card's actions
//! go out as the suggestion card's do (`ReviewAction`); replying opens the
//! thread's composer in the collaboration panel.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
    time::Duration,
};

use gpui::{
    AnyElement, App, Bounds, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    Pixels, Point, SharedString, StatefulInteractiveElement as _, Styled as _, Task, Window,
    canvas, div, point, prelude::FluentBuilder as _, px,
};
use lattice_editor::remote_cursors::hue_color;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _, components::IconButton,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    EditorPanel, EditorPanelEvent,
    overleaf_review::{ChangeMark, CommentMark, ReviewAction},
};

/// The card's width, the gap before it and the lane after it.
const CARD: Pixels = px(268.);
const GAP: Pixels = px(24.);
const LANE: Pixels = px(36.);
/// The text's measure, in columns, and the space after it.
const MEASURE_COLUMNS: usize = 88;
const MEASURE_PAD: Pixels = px(8.);
/// Narrower than this, a pip opens the rail.
const NARROW: Pixels = px(480.);
const PIP: Pixels = px(14.);
const HOVER_OPEN: Duration = Duration::from_millis(120);
const HOVER_CLOSE: Duration = Duration::from_millis(200);

/// The window's margin review mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MarginMode {
    #[default]
    Auto,
    Markers,
    Off,
}

/// How margin review is laid out now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarginLayout {
    Wide,
    Markers,
    /// Markers whose pips open the rail.
    Narrow,
}

#[derive(Clone, Debug)]
pub(super) enum ItemKind {
    Comment(CommentMark),
    Change(ChangeMark),
}

/// One item: its key, the byte offset its line is found by, and what it is.
#[derive(Clone, Debug)]
pub(super) struct MarginItem {
    pub key: String,
    pub offset: usize,
    pub kind: ItemKind,
}

#[derive(Default)]
pub(super) struct MarginState {
    pub mode: MarginMode,
    pub items: Vec<MarginItem>,
    /// The item whose popover (or rail entry) is open, and whether a click
    /// pinned it (else the pointer opened it).
    open: Option<(String, bool)>,
    rail: bool,
    hover: Option<Task<()>>,
    /// Comments whose later replies are unfolded.
    unfolded: HashSet<String>,
    /// Each card's height, measured as it was last drawn.
    heights: Rc<RefCell<HashMap<String, Pixels>>>,
    /// The source view's origin in the window, as last drawn.
    origin: Rc<Cell<Option<Point<Pixels>>>>,
    /// The layout last drawn, for scripted checks.
    pub layout: Option<MarginLayout>,
    /// Each item's card or pip bounds as last drawn, for scripted checks.
    pub painted: Rc<RefCell<Vec<(String, Bounds<Pixels>)>>>,
}

impl EditorPanel {
    pub fn set_margin_mode(&mut self, mode: MarginMode, cx: &mut Context<Self>) {
        if self.margin.mode != mode {
            self.margin.mode = mode;
            self.margin.open = None;
            self.margin.rail = false;
            cx.notify();
        }
    }

    /// How margin review is laid out now, if it shows.
    pub fn margin_layout(&self) -> Option<MarginLayout> {
        self.margin.layout
    }

    /// The item whose card is open over its pip (or in the rail).
    pub fn margin_open(&self) -> Option<&str> {
        self.margin.open.as_ref().map(|(key, _)| key.as_str())
    }

    /// Each item's card or pip as last drawn.
    pub fn margin_painted(&self) -> Vec<(String, Bounds<Pixels>)> {
        self.margin.painted.borrow().clone()
    }

    /// The layout for an editor `width` wide whose gutter is `gutter`.
    fn margin_layout_for(
        &self,
        width: Pixels,
        gutter: Pixels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (MarginLayout, Pixels) {
        let style = self
            .editor
            .update(cx, |editor, cx| editor.style(cx).text.clone());
        let measure = lattice_editor::inline_texts::text_width(
            &"0".repeat(MEASURE_COLUMNS),
            &style,
            window,
            cx,
        ) + MEASURE_PAD;
        let wide =
            self.margin.mode == MarginMode::Auto && width >= gutter + measure + GAP + CARD + LANE;
        let layout = if wide {
            MarginLayout::Wide
        } else if width - gutter < NARROW {
            MarginLayout::Narrow
        } else {
            MarginLayout::Markers
        };
        (layout, measure)
    }

    /// The clearance the text keeps at its right for margin review, and the
    /// layer itself; none when there is nothing to show.
    pub(super) fn margin_layer(
        &mut self,
        width: Option<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<(Pixels, AnyElement)> {
        self.margin.layout = None;
        if self.margin.mode == MarginMode::Off || self.margin.items.is_empty() {
            return None;
        }
        let width = width?;
        let editor = self.lattice.read(cx).painted().bounds;
        let origin = self.margin.origin.get();
        let gutter = match (editor, origin) {
            (Some(editor), Some(origin)) => editor.left() - origin.x,
            _ => px(0.),
        };
        let (layout, measure) = self.margin_layout_for(width, gutter, window, cx);
        self.margin.layout = Some(layout);
        let clearance = match layout {
            MarginLayout::Wide => (width - gutter - measure).max(GAP + CARD + LANE),
            _ => LANE,
        };
        // Where the text ends, in the view: from the clearance asked for,
        // so the first frame of a change places as the next will.
        let content_right = width - clearance;
        let content_left = gutter;
        let painted = self.margin.painted.clone();
        painted.borrow_mut().clear();
        let mut layer = div().absolute().top_0().left_0().size_full();
        // Each item's line: its top and height in the view.
        let lines: Vec<(MarginItem, Pixels, Pixels)> = self
            .margin
            .items
            .clone()
            .into_iter()
            .filter_map(|item| {
                let rect = self.lattice.update(cx, |lattice, cx| {
                    lattice.offset_bounds(item.offset, window, cx)
                })?;
                let origin = origin?;
                Some((item, rect.top() - origin.y, rect.size.height))
            })
            .collect();
        match layout {
            MarginLayout::Wide => {
                let mut floor = px(f32::MIN);
                for (item, top, _) in lines {
                    let height = self
                        .margin
                        .heights
                        .borrow()
                        .get(&item.key)
                        .copied()
                        .unwrap_or(px(72.));
                    let top = (top - px(6.)).max(floor);
                    floor = top + height + px(8.);
                    let x = content_right + GAP;
                    let card = self.margin_card(&item, true, cx);
                    layer = layer.child(self.measured(&item.key, point(x, top), card));
                }
            }
            MarginLayout::Markers | MarginLayout::Narrow => {
                let mut floor = px(f32::MIN);
                let x = (content_right + px(6.)).min(width - px(46.));
                let mut popover = None;
                for (item, top, line) in lines {
                    let top = (top + (line - PIP) / 2.).max(floor);
                    floor = top + PIP + px(2.);
                    let open = self
                        .margin
                        .open
                        .as_ref()
                        .is_some_and(|(key, _)| *key == item.key);
                    layer = layer.child(self.pip(&item, point(x, top), open, layout, cx));
                    if open && layout == MarginLayout::Markers {
                        let at = point(
                            (x - CARD - px(10.)).max(content_left),
                            (top - px(8.)).max(px(0.)),
                        );
                        popover = Some((item, at));
                    }
                }
                if let Some((item, at)) = popover {
                    let card = self.margin_card(&item, false, cx);
                    let this = cx.weak_entity();
                    layer = layer.child(
                        div()
                            .id("margin-review-popover")
                            .absolute()
                            .left(at.x)
                            .top(at.y)
                            .on_hover(move |hovered, _, cx| {
                                this.update(cx, |this, cx| this.margin_hovered(None, *hovered, cx))
                                    .ok();
                            })
                            .child(card),
                    );
                }
                if self.margin.rail && layout == MarginLayout::Narrow {
                    layer = layer.child(self.rail(width, cx));
                }
            }
        }
        let origin = self.margin.origin.clone();
        let layer = layer.child(
            canvas(
                move |bounds, _, _| origin.set(Some(bounds.origin)),
                |_, _, _, _| {},
            )
            .absolute()
            .size_full(),
        );
        Some((clearance, layer.into_any_element()))
    }

    /// A card placed at `at` whose height is measured as it is drawn.
    fn measured(&self, key: &str, at: Point<Pixels>, card: AnyElement) -> AnyElement {
        let heights = self.margin.heights.clone();
        let painted = self.margin.painted.clone();
        let key = key.to_string();
        let panel_key = key.clone();
        div()
            .absolute()
            .left(at.x)
            .top(at.y)
            .child(card)
            .child(
                canvas(
                    move |bounds, window, _| {
                        painted.borrow_mut().push((panel_key.clone(), bounds));
                        let previous = heights.borrow_mut().insert(key.clone(), bounds.size.height);
                        if previous != Some(bounds.size.height) {
                            window.refresh();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }

    fn pip(
        &self,
        item: &MarginItem,
        at: Point<Pixels>,
        open: bool,
        layout: MarginLayout,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let (color, label, pill, name) = match &item.kind {
            ItemKind::Comment(comment) => {
                let count = comment.messages.len();
                let opener = comment
                    .messages
                    .first()
                    .map(|m| m.author.clone())
                    .unwrap_or_default();
                let name = if count > 1 {
                    t!(
                        "Comment from {name}, {count} messages",
                        name = &opener,
                        count = count
                    )
                    .to_string()
                } else {
                    t!("Comment from {name}", name = &opener).to_string()
                };
                (comment.color, count.max(1).to_string(), true, name)
            }
            ItemKind::Change(change) => {
                let name = if change.change.deletion {
                    t!("{name} suggests deleting text", name = &change.author).to_string()
                } else {
                    t!("{name} suggests inserting text", name = &change.author).to_string()
                };
                let sign = if change.change.deletion { "−" } else { "+" };
                (
                    hue_color(change.change.hue as f32),
                    sign.to_string(),
                    false,
                    name,
                )
            }
        };
        let key = item.key.clone();
        let hover_key = item.key.clone();
        let this = cx.weak_entity();
        let hover = cx.weak_entity();
        let painted = self.margin.painted.clone();
        let painted_key = item.key.clone();
        div()
            .id(SharedString::from(format!("margin-pip-{}", item.key)))
            .absolute()
            .left(at.x - px(4.))
            .top(at.y - px(4.))
            .p(px(4.))
            .cursor_pointer()
            .tooltip(move |_, cx| {
                lattice_ui::components::LatticeTooltip::view(
                    SharedString::from(name.clone()),
                    None,
                    cx,
                )
            })
            .on_click(move |_, _, cx| {
                let key = key.clone();
                this.update(cx, |this, cx| this.margin_toggle(key, layout, cx))
                    .ok();
            })
            .on_hover(move |hovered, _, cx| {
                if layout == MarginLayout::Markers {
                    let key = hover_key.clone();
                    hover
                        .update(cx, |this, cx| this.margin_hovered(Some(key), *hovered, cx))
                        .ok();
                }
            })
            .child(
                div()
                    .h(PIP)
                    .min_w(PIP)
                    .px(px(if pill { 3. } else { 0. }))
                    .rounded(if pill { px(7.) } else { px(3.) })
                    .bg(color)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(9.))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(gpui::white())
                    .when(open, |this| this.border_2().border_color(palette.text))
                    .child(label)
                    .child(
                        canvas(
                            move |bounds, _, _| {
                                painted.borrow_mut().push((painted_key.clone(), bounds))
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    ),
            )
            .into_any_element()
    }

    fn margin_toggle(&mut self, key: String, layout: MarginLayout, cx: &mut Context<Self>) {
        self.margin.hover = None;
        let open = self
            .margin
            .open
            .as_ref()
            .is_some_and(|(open, pinned)| *open == key && *pinned);
        self.margin.open = (!open).then_some((key, true));
        self.margin.rail = layout == MarginLayout::Narrow && !open;
        cx.notify();
    }

    /// The pointer came onto (or left) a pip (`Some`) or the popover.
    fn margin_hovered(&mut self, key: Option<String>, hovered: bool, cx: &mut Context<Self>) {
        if self.margin.open.as_ref().is_some_and(|(_, pinned)| *pinned) {
            return;
        }
        let delay = match (&key, hovered) {
            (Some(_), true) if self.margin.open.is_some() => Duration::ZERO,
            (Some(_), true) => HOVER_OPEN,
            (None, true) => {
                // Over the popover: it stays.
                self.margin.hover = None;
                return;
            }
            _ => HOVER_CLOSE,
        };
        self.margin.hover = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                this.margin.open = match (key, hovered) {
                    (Some(key), true) => Some((key, false)),
                    _ => None,
                };
                cx.notify();
            })
            .ok();
        }));
    }

    /// The rail: every item, over the editor's right side.
    fn rail(&self, width: Pixels, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let comments = self
            .margin
            .items
            .iter()
            .filter(|item| matches!(item.kind, ItemKind::Comment(_)))
            .count();
        let changes = self.margin.items.len() - comments;
        let mut summary = Vec::new();
        if comments > 0 {
            summary.push(if comments == 1 {
                t!("1 comment").to_string()
            } else {
                t!("{count} comments", count = comments).to_string()
            });
        }
        if changes > 0 {
            summary.push(if changes == 1 {
                t!("1 suggestion").to_string()
            } else {
                t!("{count} suggestions", count = changes).to_string()
            });
        }
        let rail_width = (width * 0.78).clamp(px(240.).min(width), px(300.));
        let this = cx.weak_entity();
        let mut list = div().flex().flex_col().gap(px(8.));
        for item in &self.margin.items {
            list = list.child(self.margin_card(item, false, cx));
        }
        div()
            .id("margin-review-rail")
            .absolute()
            .top_0()
            .right_0()
            .h_full()
            .w(rail_width)
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(10.))
            .bg(palette.panel)
            .border_l_1()
            .border_color(palette.line)
            .shadow(Elevation::Popover.shadows(&palette))
            .overflow_y_scroll()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(div().text_role(TextRole::Subtitle, cx).child(t!("In view")))
                    .child(
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(summary.join(" · ")),
                    )
                    .child(
                        div().ml_auto().child(
                            IconButton::new("margin-review-rail-close", Icon::X)
                                .tooltip(t!("Close"))
                                .on_click(move |_, _, cx| {
                                    this.update(cx, |this, cx| {
                                        this.margin.rail = false;
                                        this.margin.open = None;
                                        cx.notify();
                                    })
                                    .ok();
                                }),
                        ),
                    ),
            )
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(t!(
                        "Comments and suggestions on the lines you can see. Scroll to see others."
                    )),
            )
            .child(list)
            .into_any_element()
    }

    /// An item's card (`data-variant="margin"`).
    fn margin_card(&self, item: &MarginItem, raised: bool, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let card = div()
            .w(CARD)
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(10.))
            .rounded(px(10.))
            .border_1()
            .border_color(palette.line)
            .bg(palette.raised)
            .shadow(
                if raised {
                    Elevation::Raised
                } else {
                    Elevation::Popover
                }
                .shadows(&palette),
            );
        let emit = |action: ReviewAction| {
            let this = cx.weak_entity();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                let action = action.clone();
                this.update(cx, |_, cx| {
                    cx.emit(EditorPanelEvent::OverleafReview(action))
                })
                .ok();
            }
        };
        match &item.kind {
            ItemKind::Comment(comment) => {
                let unfolded = self.margin.unfolded.contains(&comment.thread_id);
                let thread = comment.thread_id.clone();
                // Resolve and Delete in the card's corner, over the first
                // message's line.
                let mut card = card.relative().child(
                    div()
                        .absolute()
                        .top(px(6.))
                        .right(px(6.))
                        .flex()
                        .gap(px(2.))
                        .child(
                            IconButton::new(
                                SharedString::from(format!("margin-delete-{thread}")),
                                Icon::TRASH,
                            )
                            .tooltip(t!("Delete discussion"))
                            .on_click(emit(ReviewAction::DeleteThread(thread.clone()))),
                        )
                        .child(
                            IconButton::new(
                                SharedString::from(format!("margin-resolve-{thread}")),
                                Icon::CHECK,
                            )
                            .tooltip(t!("Resolve"))
                            .on_click(emit(ReviewAction::Resolve(thread.clone()))),
                        ),
                );
                let shown = if unfolded { comment.messages.len() } else { 1 };
                for message in comment.messages.iter().take(shown) {
                    card = card.child(message_row(message, cx));
                }
                let hidden = comment.messages.len().saturating_sub(1);
                if hidden > 0 && !unfolded {
                    let this = cx.weak_entity();
                    let thread = thread.clone();
                    card = card.child(
                        div()
                            .id(SharedString::from(format!("margin-more-{thread}")))
                            .ml(px(28.))
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .cursor_pointer()
                            .hover(|this| this.text_color(palette.text))
                            .on_click(move |_, _, cx| {
                                let thread = thread.clone();
                                this.update(cx, |this, cx| {
                                    this.margin.unfolded.insert(thread);
                                    cx.notify();
                                })
                                .ok();
                            })
                            .child(if hidden == 1 {
                                t!("1 more reply").to_string()
                            } else {
                                t!("{count} more replies", count = hidden).to_string()
                            }),
                    );
                }
                card.child(
                    div()
                        .id(SharedString::from(format!("margin-reply-{thread}")))
                        .ml(px(28.))
                        .h(px(28.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(palette.line)
                        .bg(palette.input)
                        .cursor_text()
                        .text_role(TextRole::BodyCompact, cx)
                        .text_color(palette.text_secondary)
                        .on_click(emit(ReviewAction::Reply(thread.clone())))
                        .child(t!("Reply…")),
                )
                .into_any_element()
            }
            ItemKind::Change(change) => {
                let hue = hue_color(change.change.hue as f32);
                let kind = if change.change.deletion {
                    t!("deleted")
                } else {
                    t!("added")
                };
                let at = change
                    .change
                    .timestamp
                    .as_deref()
                    .map(crate::overleaf::picker::relative_time)
                    .unwrap_or_default();
                let id = change.change.id.clone();
                let disabled = !change.can_act || id.starts_with("provisional:");
                let text = change.change.text.clone();
                let body = div()
                    .pl(px(24.))
                    .font_family(cx.lattice().fonts.display.clone())
                    .text_size(px(15.))
                    .line_height(px(22.))
                    .bg(hue.opacity(if change.change.deletion { 0.10 } else { 0.14 }))
                    .when(change.change.deletion, |this| this.line_through())
                    .when(!change.change.deletion, |this| this.underline())
                    .child(if text.trim().is_empty() {
                        t!("(no text)").to_string()
                    } else {
                        text
                    });
                card.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(super::super::overleaf::collab::avatar(
                            &change.author,
                            hue,
                            px(18.),
                        ))
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_color(palette.text)
                                .font_weight(FONT_WEIGHT_MEDIUM)
                                .child(change.author.clone()),
                        )
                        .child(div().flex_none().child(kind))
                        .child(div().flex_none().child(at))
                        .child(
                            div()
                                .ml_auto()
                                .flex()
                                .gap(px(2.))
                                .child(
                                    IconButton::new(
                                        SharedString::from(format!("margin-accept-{id}")),
                                        Icon::CHECK,
                                    )
                                    .tooltip(t!("Accept"))
                                    .disabled(disabled)
                                    .on_click(emit(ReviewAction::Accept(id.clone()))),
                                )
                                .child(
                                    IconButton::new(
                                        SharedString::from(format!("margin-reject-{id}")),
                                        Icon::X,
                                    )
                                    .tooltip(t!("Reject"))
                                    .disabled(disabled)
                                    .on_click(emit(ReviewAction::Reject(id.clone()))),
                                ),
                        ),
                )
                .child(body)
                .into_any_element()
            }
        }
    }
}

fn message_row(message: &super::overleaf_review::MarginMessage, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .pr(px(52.))
        .flex()
        .gap(px(8.))
        .items_start()
        .child(super::super::overleaf::collab::avatar(
            &message.author,
            message.color,
            px(20.),
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(
                            div()
                                .min_w_0()
                                .overflow_hidden()
                                .whitespace_nowrap()
                                .text_ellipsis()
                                .text_color(palette.text)
                                .font_weight(FONT_WEIGHT_MEDIUM)
                                .child(message.author.clone()),
                        )
                        .child(div().flex_none().child(message.at.clone())),
                )
                .child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text)
                        .whitespace_normal()
                        .child(message.content.clone()),
                ),
        )
        .into_any_element()
}
