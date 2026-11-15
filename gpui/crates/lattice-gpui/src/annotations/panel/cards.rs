//! The panel's cards: each note's pin, quote, words and where it sits, its
//! replies, the actions shown while the pointer is over it, and the box an
//! edit or a reply is written in. A card answers what was just done to it
//! (a tint and a word beside its place) and leaves on the moderate exit.

use gpui::{
    AnyElement, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::TextareaState;
use lattice_core::project::EditorComment;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, ButtonVariant, IconButton, Textarea},
    tokens::{RADIUS_CONTROL, SPACING_2, SPACING_3, SPACING_4, SPACING_5},
    typography::tabular_nums,
};

use super::{AnnotationsPanel, AnnotationsPanelEvent, LEAVE, Outcome, Writing, file_name};
use crate::annotations::{
    card::{self, PIN},
    colors,
    model::{self, Status},
};

impl AnnotationsPanel {
    pub(super) fn card(
        &mut self,
        comment: &EditorComment,
        line: Option<u32>,
        author_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let status = Status::of(comment);
        let id = comment.id.clone();
        let name = file_name(&comment.path);
        let location = match (line, &comment.pdf) {
            (Some(line), _) => format!("{name}:{line}"),
            (None, Some(pdf)) => t!("PDF p.{0}", pdf.page),
            (None, None) => name,
        };
        let gone = self.leaving.contains_key(&id);
        let outcome = self.outcomes.get(&id).map(|(outcome, _)| *outcome);
        let focused = self.active_note.as_deref() == Some(id.as_str());
        let note = model::note_text(comment);
        let quote = comment.quote.trim();
        let where_ = lattice_i18n::join_phrases(&[location, model::relative_time(&comment.created_at, true)]);
        let revising = self.revising(&id, cx);
        let extras = self.round_extras(comment, window, cx);
        let meta = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(SPACING_4)
            .gap_y(px(2.))
            .min_w_0()
            .text_role(TextRole::Caption, cx)
            .font_features(tabular_nums())
            .text_color(palette.text_secondary)
            .when(revising, |this| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(crate::build::chip_mark::infinity_loader(
                            ("annotation-revising", hash(&id)),
                            px(11.),
                            &palette,
                        ))
                        .child(t!("Revising…")),
                )
            })
            .when(status != Status::Open && !revising, |this| {
                let ink = match status {
                    Status::Rejected => palette.text_secondary,
                    Status::Failed => palette.danger,
                    _ => colors::ink(status, &palette),
                };
                this.child(
                    div()
                        .px(SPACING_3)
                        .rounded(px(4.))
                        .bg(ink.opacity(0.12))
                        .text_color(ink)
                        .font_weight(FontWeight::MEDIUM)
                        .child(status.label()),
                )
            })
            .child(div().min_w_0().child(where_))
            .when_some(outcome.filter(|outcome| *outcome != Outcome::Resolved), |this, outcome| {
                let ink = if outcome == Outcome::Reopened {
                    palette.annotation
                } else {
                    palette.success
                };
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_color(ink)
                        .font_weight(FontWeight::MEDIUM)
                        .child(Icon::CHECK.element(px(11.), ink))
                        .child(outcome.label()),
                )
            });
        let open_comment = comment.clone();
        let body = div()
            .id(("annotation-card-body", hash(&id)))
            .flex()
            .gap_x(SPACING_5)
            .p(SPACING_2)
            .rounded(px(4.))
            .min_w_0()
            .cursor_pointer()
            .child(div().pt(px(2.)).child(card::pin(comment.number, status, PIN, cx)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(SPACING_2)
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .min_w_0()
                            .line_clamp(2)
                            .italic()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .text_color(palette.text_secondary)
                            .child(if quote.is_empty() {
                                t!("(empty span)").to_string()
                            } else {
                                card::quote_text(quote)
                            }),
                    )
                    .when(!note.is_empty(), |this| {
                        this.child(
                            div()
                                .min_w_0()
                                .text_role(TextRole::Body, cx)
                                .text_color(palette.text)
                                .whitespace_normal()
                                .child(note.clone()),
                        )
                    })
                    .child(meta),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.active_note = Some(open_comment.id.clone());
                // A proposal opens for review under its passage.
                if !this.review_proposal(&open_comment, cx) {
                    cx.emit(AnnotationsPanelEvent::Open(open_comment.clone()));
                }
                cx.notify();
            }));
        let replies = (!comment.replies.is_empty()).then(|| {
            div()
                .ml(px(30.))
                .flex()
                .flex_col()
                .gap(SPACING_3)
                .children(comment.replies.iter().map(|reply| {
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .child(
                            div()
                                .flex()
                                .gap(SPACING_3)
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(model::author_display(&reply.author_name))
                                .child(model::relative_time(&reply.created_at, false)),
                        )
                        .child(
                            div()
                                .text_role(TextRole::Body, cx)
                                .text_color(palette.text)
                                .whitespace_normal()
                                .child(reply.body.clone()),
                        )
                }))
        });
        let writing = match &self.writing {
            Some(Writing::Edit { id: editing, field, .. }) if *editing == id => {
                Some(self.edit_box(field.clone(), true, cx))
            }
            Some(Writing::Reply { id: replying, field, .. }) if *replying == id => {
                Some(self.edit_box(field.clone(), false, cx))
            }
            _ => None,
        };
        let is_author = comment.author_id == author_id;
        let resolve_comment = comment.clone();
        let edit_comment = comment.clone();
        let reply_id = id.clone();
        let delete_id = id.clone();
        let group = SharedString::from(format!("annotation-card-{id}"));
        let actions = writing.is_none().then(|| {
            div()
                .absolute()
                .top(SPACING_2)
                .right(SPACING_2)
                .flex()
                .gap(px(2.))
                .p(px(2.))
                .rounded(RADIUS_CONTROL)
                .bg(palette.raised)
                .shadow(Elevation::Raised.shadows(&palette))
                .when(!gone, |this| {
                    this.invisible().group_hover(group.clone(), |style| style.visible())
                })
                .child(
                    IconButton::new(
                        ("annotation-card-resolve", hash(&id)),
                        if comment.resolved { Icon::ROTATE_CCW } else { Icon::CHECK },
                    )
                    .tooltip(if comment.resolved {
                        t!("Reopen")
                    } else {
                        t!("Resolve")
                    })
                    .disabled(gone)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.toggle_resolved(&resolve_comment, cx)
                    })),
                )
                .child(
                    IconButton::new(("annotation-card-reply", hash(&id)), Icon::REPLY)
                        .tooltip(t!("Reply"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.start_reply(reply_id.clone(), window, cx)
                        })),
                )
                .when(is_author, |this| {
                    this.child(
                        IconButton::new(("annotation-card-edit", hash(&id)), Icon::PENCIL)
                            .tooltip(t!("Edit"))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.start_edit(&edit_comment, window, cx)
                            })),
                    )
                    .child(
                        IconButton::new(("annotation-card-delete", hash(&id)), Icon::TRASH)
                            .tooltip(t!("Delete"))
                            .disabled(gone)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.delete(delete_id.clone(), cx)
                            })),
                    )
                })
        });
        let leaving = self.leaving.get(&id).map(|start| {
            (start.elapsed().as_secs_f32() / LEAVE.as_secs_f32()).clamp(0., 1.)
        });
        if leaving.is_some() {
            window.request_animation_frame();
        }
        let ground = match outcome {
            Some(Outcome::Reopened) => Some(palette.annotation.opacity(0.10)),
            Some(_) => Some(palette.success.opacity(0.09)),
            None if focused => Some(palette.raised),
            None => None,
        };
        div()
            .id(("annotation-card", hash(&id)))
            .group(group)
            .relative()
            .flex()
            .flex_col()
            .gap(SPACING_2)
            .p(SPACING_2)
            .rounded(RADIUS_CONTROL)
            .when(matches!(status, Status::Resolved | Status::Accepted), |this| this.opacity(0.84))
            .when_some(ground, |this, ground| this.bg(ground))
            .when(focused && outcome.is_none(), |this| {
                this.border_1().border_color(palette.line)
            })
            .when(ground.is_none(), |this| this.hover(|style| style.bg(palette.hover)))
            .when_some(leaving, |this, progress| {
                this.opacity(1. - progress).top(px(-2. * progress))
            })
            .child(body)
            .children(extras)
            .children(replies)
            .children(writing)
            .children(actions)
            .into_any_element()
    }

    /// An edit of the note, or a reply, with Save (Reply) and Cancel.
    fn edit_box(&self, field: Entity<TextareaState>, edit: bool, cx: &mut Context<Self>) -> AnyElement {
        let filled = !field.read(cx).value().trim().is_empty();
        div()
            .ml(px(30.))
            .flex()
            .flex_col()
            .gap(SPACING_3)
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    this.writing = None;
                    cx.notify();
                }
            }))
            .child(Textarea::new(&field).grows())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(SPACING_2)
                    .child(
                        Button::new(
                            if edit { "annotation-edit-save" } else { "annotation-reply-send" },
                            if edit { t!("Save") } else { t!("Reply") },
                        )
                        .variant(ButtonVariant::Tinted)
                        .size(ButtonSize::Compact)
                        .disabled(!edit && !filled)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if edit {
                                this.finish_edit(cx)
                            } else {
                                this.send_reply(cx)
                            }
                        })),
                    )
                    .child(
                        Button::new("annotation-edit-cancel", t!("Cancel"))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Compact)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.writing = None;
                                cx.notify();
                            })),
                    ),
            )
            .into_any_element()
    }
}

pub(super) fn hash(id: &str) -> usize {
    let mut hash: usize = 0xcbf2_9ce4;
    for byte in id.bytes() {
        hash = (hash ^ byte as usize).wrapping_mul(0x0100_0193);
    }
    hash
}

