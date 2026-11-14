//! A margin review item's card (`OverleafThreadCard` and
//! `OverleafChangeCard` in their margin variant): a comment's first message
//! with Resolve and Delete in its corner, its later replies folded and its
//! reply box; a suggestion's author, kind and age with Accept and Reject over
//! its text in the author's hue.

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_editor::remote_cursors::hue_color;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _, components::IconButton,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{CARD, CardVariant, ItemKind, MarginItem};
use crate::editor_panel::{EditorPanel, EditorPanelEvent, overleaf_review::ReviewAction};

impl EditorPanel {
    /// An item's card (`data-variant="margin"`).
    pub(super) fn margin_card(
        &self,
        item: &MarginItem,
        variant: CardVariant,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let card = div()
            .id(SharedString::from(format!("margin-card-{}", item.key)))
            .w(CARD)
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(10.))
            .rounded(px(10.));
        // overleaf-margin-review.css: beside its line, the elevated surface
        // on the raised shadow (its ring for an edge), lifting to the
        // popover's under the pointer; in a popover, bare on the popover's
        // own surface; in the rail, the panel's ground inside a hairline
        // that firms under the pointer.
        let card = match variant {
            CardVariant::Wide => {
                let lifted = Elevation::Popover.shadows(&palette);
                card.bg(palette.raised)
                    .shadow(Elevation::Raised.shadows(&palette))
                    .hover(move |this| this.shadow(lifted.clone()))
            }
            CardVariant::Popover => card,
            CardVariant::Rail => {
                let strong = palette.line_strong;
                card.bg(palette.panel)
                    .border_1()
                    .border_color(palette.line)
                    .hover(move |this| this.border_color(strong))
            }
        };
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
                        .child(crate::overleaf::collab::avatar(
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

fn message_row(
    message: &crate::editor_panel::overleaf_review::MarginMessage,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    div()
        .pr(px(52.))
        .flex()
        .gap(px(8.))
        .items_start()
        .child(crate::overleaf::collab::avatar(
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
