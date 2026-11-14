//! The Comments tab (`src/overleaf/overleaf-comments.tsx`): every thread in
//! the project, grouped "In this file", then by the other files, then "No
//! longer in the document"; resolved threads only under All.
//!
//! An open thread is a card: the quoted passage (in its opener's colour,
//! which shows the passage in the editor), Resolve and Delete, the
//! messages (each its author's face, name and age; one's own also Edit and
//! Delete), and a reply field that opens a composer where Enter sends and
//! Shift+Enter breaks the line. A resolved one folds to a line saying who
//! resolved it, with Reopen. A thread whose passage was deleted can only be
//! read: Overleaf keys resolving and deleting by the document it sits in.

use lattice_core::overleaf::{OverleafMessage, OverleafThread};
use lattice_i18n::t;
use lattice_ui::components::{Button, ButtonSize, ButtonVariant, IconButton, Textarea};

use super::*;
use crate::{
    confirm::{self, Confirm},
    history::widgets::initials,
    overleaf::people::person_color,
};

/// A thread with where it is anchored.
struct Placed {
    thread: OverleafThread,
    path: Option<String>,
    position: i64,
    quote: Option<String>,
}

impl OverleafCollabPanel {
    pub(super) fn render_comments(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let bridge = self.bridge.read(cx);
        let threads = bridge.threads();
        let loading = bridge.comments_loading();
        let has_resolved = threads.iter().any(|thread| thread.resolved);
        let total = threads.len();
        let placed: Vec<Placed> = threads
            .iter()
            .filter(|thread| self.show_resolved || !thread.resolved)
            .map(|thread| {
                let anchor = bridge.thread_anchor(&thread.id);
                Placed {
                    thread: thread.clone(),
                    path: anchor.as_ref().and_then(|(path, _, _)| path.clone()),
                    position: anchor.as_ref().map_or(0, |(_, position, _)| *position),
                    quote: anchor.map(|(_, _, quote)| quote),
                }
            })
            .collect();
        let mut list = div().flex().flex_col().gap(px(20.));
        if let Some(composer) = self.composer.as_ref()
            && let Draft::New { quote, .. } = &composer.draft
        {
            list = list.child(self.new_comment(quote.clone(), composer, window, cx));
        }
        if has_resolved {
            list = list.child(self.filter(total, cx));
        }
        if placed.is_empty() {
            if loading {
                let palette = cx.palette().clone();
                return list
                    .child(
                        div()
                            .py(px(20.))
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .child(t!("Loading comments…")),
                    )
                    .into_any_element();
            }
            let title = if self.show_resolved || total == 0 {
                t!("No comments yet")
            } else {
                t!("No open comments")
            };
            return list
                .child(empty_state(Drawing::MarginNotes, title.into(), cx))
                .into_any_element();
        }
        // In this file, then each other file by path, then the orphans.
        let active = self.active.clone();
        let mut groups: Vec<(Icon, SharedString, Vec<Placed>)> = Vec::new();
        let mut here = Vec::new();
        let mut others: std::collections::BTreeMap<Option<String>, Vec<Placed>> =
            Default::default();
        let mut orphans = Vec::new();
        for item in placed {
            if item.quote.is_none() {
                orphans.push(item);
            } else if item.path.is_some() && item.path == active {
                here.push(item);
            } else {
                others.entry(item.path.clone()).or_default().push(item);
            }
        }
        if !here.is_empty() {
            groups.push((Icon::FILE_TEXT, t!("In this file").into(), here));
        }
        let unknown = others.remove(&None);
        for (path, items) in others {
            groups.push((Icon::FILE_TEXT, path.unwrap_or_default().into(), items));
        }
        if let Some(items) = unknown {
            groups.push((
                Icon::FILE_TEXT,
                t!("Another file in this project").into(),
                items,
            ));
        }
        if !orphans.is_empty() {
            groups.push((
                Icon::FILE_TEXT,
                t!("No longer in the document").into(),
                orphans,
            ));
        }
        for (icon, label, items) in groups {
            let mut section = div().flex().flex_col().gap(px(6.)).child(group_heading(
                icon,
                label,
                items.len(),
                cx,
            ));
            for item in items {
                section = section.child(self.thread_card(item, window, cx));
            }
            list = list.child(section);
        }
        list.into_any_element()
    }

    /// Unresolved | All n (`CommentVisibilityFilter`).
    fn filter(&self, total: usize, cx: &mut Context<Self>) -> AnyElement {
        let this = cx.weak_entity();
        let choose = move |all: bool| {
            let this = this.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                this.update(cx, |this, cx| {
                    this.show_resolved = all;
                    cx.notify();
                })
                .ok();
            }
        };
        div()
            .flex()
            .justify_end()
            .child(
                ViewSwitch::new("overleaf-comment-filter")
                    .named(true)
                    .mode(
                        Icon::MESSAGE_SQUARE_TEXT,
                        t!("Unresolved"),
                        !self.show_resolved,
                        choose(false),
                    )
                    .mode(
                        Icon::CHECK,
                        format!("{} {total}", t!("All")),
                        self.show_resolved,
                        choose(true),
                    ),
            )
            .into_any_element()
    }

    fn thread_card(&self, item: Placed, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let bridge = self.bridge.read(cx);
        let id = item.thread.id.clone();
        let busy = bridge.review_busy() == Some(id.as_str());
        let opener = item.thread.messages.first();
        let color = opener.map_or(palette.line_strong, |m| {
            person_color(bridge, &m.author_name, m.author_email.as_deref(), m.mine)
        });
        let orphan = item.quote.is_none();
        let resolved = item.thread.resolved;
        let unfolded = self.unfolded.contains(&id);
        let tools = self.thread_tools(&id, resolved, orphan || busy);
        let mut card = div()
            .id(SharedString::from(format!("overleaf-thread-{id}")))
            .flex()
            .flex_col()
            .gap(px(10.))
            .rounded(px(10.))
            .border_1()
            .border_color(palette.line)
            .hover(|this| this.border_color(palette.line_strong));
        if resolved {
            let who = item
                .thread
                .resolved_by
                .clone()
                .map(|name| t!("Resolved by {name}", name = &name).to_string())
                .unwrap_or_else(|| t!("Resolved").to_string());
            let this = cx.weak_entity();
            let toggle = id.clone();
            let line = div()
                .id(SharedString::from(format!("overleaf-thread-fold-{id}")))
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(6.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .cursor_pointer()
                .on_click(move |_, _, cx| {
                    this.update(cx, |this, cx| {
                        if !this.unfolded.remove(&toggle) {
                            this.unfolded.insert(toggle.clone());
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .child(
                    if unfolded {
                        Icon::CHEVRON_DOWN
                    } else {
                        Icon::CHEVRON_RIGHT
                    }
                    .element(px(12.), palette.text_secondary),
                )
                .child(Icon::CHECK.element(px(12.), palette.success))
                .child(div().flex_none().child(who))
                .children(item.quote.clone().map(|quote| {
                    div()
                        .min_w_0()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .italic()
                        .child(quote)
                }));
            card = card.px(px(12.)).py(px(6.)).child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(line)
                    .child(tools),
            );
            if !unfolded {
                return card.into_any_element();
            }
        } else {
            let quote = item.quote.clone();
            let reveal = item.path.clone().map(|path| (path, item.position));
            let this = cx.weak_entity();
            let head_quote = match quote {
                Some(quote) => div()
                    .id(SharedString::from(format!("overleaf-thread-quote-{id}")))
                    .min_w_0()
                    .pl(px(8.))
                    .border_l_2()
                    .border_color(color)
                    .text_role(TextRole::Body, cx)
                    .italic()
                    .text_color(palette.text_secondary)
                    .line_clamp(3)
                    .when(reveal.is_some(), |this| {
                        this.cursor_pointer()
                            .hover(|this| this.text_color(palette.text))
                    })
                    .on_click(move |_, _, cx| {
                        if let Some((path, position)) = reveal.clone() {
                            this.update(cx, |_, cx| {
                                cx.emit(CollabEvent::Reveal { path, position })
                            })
                            .ok();
                        }
                    })
                    .child(if quote.is_empty() {
                        t!("(this comment's text was removed)").to_string()
                    } else {
                        quote
                    }),
                None => div()
                    .id(SharedString::from(format!("overleaf-thread-quote-{id}")))
                    .text_role(TextRole::Caption, cx)
                    .italic()
                    .text_color(palette.text_secondary)
                    .child(t!("Its span was deleted from the document.")),
            };
            card = card.pl(px(12.)).pr(px(10.)).py(px(10.)).child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.))
                    .child(div().flex_1().min_w_0().child(head_quote))
                    .child(tools),
            );
        }
        let messages = item.thread.messages.clone();
        if messages.is_empty() {
            card = card.child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(t!("This comment has no text yet")),
            );
        }
        let only = messages.len() == 1;
        for message in messages {
            card = card.child(self.message_row(&id, message, only, window, cx));
        }
        if !resolved {
            card = card.child(self.reply_slot(&id, window, cx));
        }
        card.into_any_element()
    }

    fn thread_tools(&self, id: &str, resolved: bool, disabled: bool) -> AnyElement {
        let bridge = self.bridge.clone();
        let (resolve_icon, resolve_label) = if resolved {
            (Icon::ROTATE_CCW, t!("Reopen"))
        } else {
            (Icon::CHECK, t!("Resolve"))
        };
        let resolving = id.to_string();
        let deleting = id.to_string();
        let delete_bridge = bridge.clone();
        let why = t!(
            "Its span was deleted from the document, so Overleaf can't say which file to act on"
        );
        div()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(2.))
            .child(
                IconButton::new(SharedString::from(format!("overleaf-thread-delete-{id}")), Icon::TRASH)
                    .tooltip(if disabled { why } else { t!("Delete discussion") })
                    .disabled(disabled)
                    .on_click(move |_, _, cx| {
                        let bridge = delete_bridge.clone();
                        let thread = deleting.clone();
                        confirm::ask(
                            Confirm::new(t!("Delete this discussion?"))
                                .body(t!("Every message in the thread will be removed from Overleaf. This cannot be undone."))
                                .confirm_label(t!("Delete"))
                                .destructive()
                                .on_confirm(move |_, cx| {
                                    bridge.update(cx, |bridge, cx| bridge.delete_thread(&thread, cx));
                                }),
                            cx,
                        );
                    }),
            )
            .child(
                IconButton::new(SharedString::from(format!("overleaf-thread-resolve-{id}")), resolve_icon)
                    .tooltip(if disabled { why } else { resolve_label })
                    .disabled(disabled)
                    .on_click(move |_, _, cx| {
                        bridge.update(cx, |bridge, cx| {
                            bridge.set_thread_resolved(&resolving, !resolved, cx)
                        });
                    }),
            )
            .into_any_element()
    }

    fn message_row(
        &self,
        thread: &str,
        message: OverleafMessage,
        only: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let bridge = self.bridge.read(cx);
        let color = person_color(
            bridge,
            &message.author_name,
            message.author_email.as_deref(),
            message.mine,
        );
        let name = if message.mine {
            t!("You").to_string()
        } else {
            message.author_name.clone()
        };
        let at = chrono::DateTime::from_timestamp_millis(message.timestamp)
            .map(|at| crate::overleaf::picker::relative_time(&at.to_rfc3339()))
            .unwrap_or_default();
        let editing = self.composer.as_ref().is_some_and(|composer| {
            composer.draft
                == Draft::Edit {
                    thread: thread.to_string(),
                    message: message.id.clone(),
                }
        });
        let own_tools = message.mine.then(|| {
            let this = cx.weak_entity();
            let (edit_thread, edit_message, edit_text) =
                (thread.to_string(), message.id.clone(), message.content.clone());
            let bridge = self.bridge.clone();
            let (delete_thread, delete_message) = (thread.to_string(), message.id.clone());
            div()
                .ml_auto()
                .flex()
                .gap(px(2.))
                .child(
                    IconButton::new(SharedString::from(format!("overleaf-message-edit-{}", message.id)), Icon::PENCIL_LINE)
                        .tooltip(t!("Edit message"))
                        .on_click(move |_, window, cx| {
                            let draft = Draft::Edit {
                                thread: edit_thread.clone(),
                                message: edit_message.clone(),
                            };
                            let text = edit_text.clone();
                            this.update(cx, |this, cx| this.open_composer(draft, text, window, cx))
                                .ok();
                        }),
                )
                .child(
                    IconButton::new(SharedString::from(format!("overleaf-message-delete-{}", message.id)), Icon::TRASH)
                        .tooltip(t!("Delete message"))
                        .on_click(move |_, _, cx| {
                            let bridge = bridge.clone();
                            let (thread, message) = (delete_thread.clone(), delete_message.clone());
                            let body = if only {
                                t!("It's the only one in the thread, so this deletes the whole thread. This cannot be undone.")
                            } else {
                                t!("This cannot be undone.")
                            };
                            confirm::ask(
                                Confirm::new(t!("Delete this message?"))
                                    .body(body)
                                    .confirm_label(t!("Delete"))
                                    .destructive()
                                    .on_confirm(move |_, cx| {
                                        bridge.update(cx, |bridge, cx| {
                                            bridge.delete_message(&thread, &message, cx)
                                        });
                                    }),
                                cx,
                            );
                        }),
                )
        });
        let body = if editing {
            let composer = self
                .composer
                .as_ref()
                .map(|composer| composer.state.clone());
            composer
                .map(|state| self.composer_box(state, t!("Save").into(), window, cx))
                .unwrap_or_else(|| div().into_any_element())
        } else {
            div()
                .mt(px(2.))
                .text_role(TextRole::Body, cx)
                .text_color(palette.text)
                .whitespace_normal()
                .child(message.content.clone())
                .into_any_element()
        };
        div()
            .flex()
            .gap(px(8.))
            .items_start()
            .child(avatar(&message.author_name, color, px(20.)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .min_h(px(20.))
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
                                    .child(name),
                            )
                            .child(div().flex_none().child(at))
                            .children(own_tools),
                    )
                    .child(body),
            )
            .into_any_element()
    }

    /// "Reply…", or the open composer for this thread.
    fn reply_slot(&self, thread: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let replying = self.composer.as_ref().is_some_and(|composer| {
            composer.draft
                == Draft::Reply {
                    thread: thread.to_string(),
                }
        });
        let slot = div().ml(px(28.));
        if replying {
            let state = self
                .composer
                .as_ref()
                .map(|composer| composer.state.clone());
            if let Some(state) = state {
                return slot
                    .child(self.composer_box(state, t!("Reply").into(), window, cx))
                    .into_any_element();
            }
        }
        let this = cx.weak_entity();
        let draft = Draft::Reply {
            thread: thread.to_string(),
        };
        slot.child(
            div()
                .id(SharedString::from(format!(
                    "overleaf-thread-reply-{thread}"
                )))
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .rounded(px(6.))
                .border_1()
                .border_color(palette.line)
                .bg(palette.input)
                .hover(|this| this.border_color(palette.line_strong))
                .cursor_text()
                .text_role(TextRole::BodyCompact, cx)
                .text_color(palette.text_secondary)
                .on_click(move |_, window, cx| {
                    let draft = draft.clone();
                    this.update(cx, |this, cx| {
                        this.open_composer(draft, String::new(), window, cx)
                    })
                    .ok();
                })
                .child(t!("Reply…")),
        )
        .into_any_element()
    }

    /// A new thread's composer, quoting its passage.
    fn new_comment(
        &self,
        quote: String,
        composer: &Composer,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(12.))
            .rounded(px(10.))
            .border_1()
            .border_color(palette.line_strong)
            .child(
                div()
                    .pl(px(8.))
                    .border_l_2()
                    .border_color(palette.accent)
                    .italic()
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .line_clamp(3)
                    .child(quote),
            )
            .child(self.composer_box(composer.state.clone(), t!("Comment").into(), window, cx))
            .into_any_element()
    }

    /// The textarea and its Cancel and send buttons; Enter sends (the
    /// textarea's `submit_on_enter`), Shift+Enter breaks the line, Escape
    /// cancels.
    fn composer_box(
        &self,
        state: Entity<TextareaState>,
        send: SharedString,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let empty = state.read(cx).value().trim().is_empty();
        let submit = cx.weak_entity();
        let cancel = cx.weak_entity();
        let keys = cx.weak_entity();
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .capture_key_down(move |event, _, cx| {
                if event.keystroke.key == "escape" {
                    keys.update(cx, |this, cx| this.close_composer(cx)).ok();
                    cx.stop_propagation();
                }
            })
            .child(Textarea::new(&state).height(px(56.)))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(6.))
                    .child(
                        Button::new("overleaf-composer-cancel", t!("Cancel"))
                            .variant(ButtonVariant::Ghost)
                            .size(ButtonSize::Compact)
                            .on_click(move |_, _, cx| {
                                cancel.update(cx, |this, cx| this.close_composer(cx)).ok();
                            }),
                    )
                    .child(
                        Button::new("overleaf-composer-send", send)
                            .variant(ButtonVariant::Tinted)
                            .size(ButtonSize::Compact)
                            .disabled(empty)
                            .on_click(move |_, _, cx| {
                                submit.update(cx, |this, cx| this.submit(cx)).ok();
                            }),
                    ),
            )
            .into_any_element()
    }
}

/// A person's face: their initials on their colour (`PersonAvatar`).
pub(super) fn avatar(name: &str, color: gpui::Hsla, size: gpui::Pixels) -> AnyElement {
    div()
        .flex_none()
        .size(size)
        .rounded_full()
        .bg(color)
        .flex()
        .items_center()
        .justify_center()
        .text_size(size * 0.45)
        .font_weight(gpui::FontWeight::SEMIBOLD)
        .text_color(gpui::white())
        .child(initials(name))
        .into_any_element()
}
