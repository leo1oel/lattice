//! The Chat tab (`ChatPanel` in `src/components/ui/chat-panel.tsx`, as the
//! Overleaf drawer hosts it): the project's conversation, newest at the
//! bottom, as a team chat reads it, each run of messages from one person
//! opened by their face, name and clock time, with a rule naming the day
//! where the day changes; and a composer under it that sends on Enter
//! (Shift+Enter breaks the line) and keeps its text when Overleaf refuses it.
//!
//! The list follows new messages only while the reader is at the bottom
//! already: someone reading back up is not pulled away by an arrival, which
//! "Jump to new messages" offers instead.

use lattice_core::overleaf::OverleafMessage;
use lattice_i18n::{join_list, locale, space_mixed_script, t};
use lattice_ui::components::{Button, ButtonSize, ButtonVariant, IconButton, Textarea};

use super::*;
use crate::{history::time, overleaf::people::person_color};

/// Two messages from one person this close together share one header.
const RUN: i64 = 5 * 60_000;
/// Within this of the bottom the list counts as at the bottom.
const FOLLOW_SLACK: f32 = 32.;

/// The composer's lines: one to start, up to the Tauri app's 160px.
const COMPOSER_ROWS: (usize, usize) = (1, 8);

/// The chat's own view state, kept across tab switches.
#[derive(Default)]
pub(super) struct ChatView {
    input: Option<(Entity<TextareaState>, Subscription)>,
    scroll: ScrollHandle,
    /// How many messages the list last showed, and the newest's id.
    shown: (usize, Option<String>),
    /// The list has been put at its bottom once.
    positioned: bool,
    /// Messages arrived below where the reader is.
    below: bool,
    /// The composer's placeholder as last set.
    placeholder: SharedString,
    /// Overleaf has the message sent: the field empties on the next frame,
    /// which has the window it needs.
    sent: bool,
}

impl OverleafCollabPanel {
    pub(super) fn render_chat(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let input = self.chat_input(window, cx);
        if std::mem::take(&mut self.chat.sent) {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
        let bridge = self.bridge.read(cx);
        let messages = bridge.chat_messages().to_vec();
        let loading = bridge.chat_loading();
        let error = bridge.chat_error().cloned();
        let sending = bridge.chat_sending();
        let placeholder = chat_placeholder(bridge);
        // Set only on a change: setting it redraws the field.
        if self.chat.placeholder != placeholder {
            self.chat.placeholder = placeholder.clone();
            input.update(cx, |state, cx| {
                state.set_placeholder(placeholder, window, cx)
            });
        }
        self.follow(&messages);

        let list: AnyElement = if messages.is_empty() {
            if loading {
                div()
                    .py(px(12.))
                    .child(crate::history::widgets::loading_line(
                        "overleaf-chat-loading",
                        t!("Loading the conversation…"),
                        cx,
                    ))
                    .into_any_element()
            } else if error.is_some() {
                // The error above says why there is nothing here.
                div().into_any_element()
            } else {
                empty_state(Drawing::LetterRack, t!("No messages yet").into(), cx)
            }
        } else {
            self.chat_rows(&messages, cx)
        };
        let empty = input.read(cx).value().trim().is_empty();
        let send = cx.weak_entity();
        let jump = cx.weak_entity();
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .px(px(14.))
            .pb(px(14.))
            .children(error.map(|error| {
                div()
                    .flex_none()
                    .pb(px(8.))
                    .child(crate::history::widgets::inline_message(error, true, cx))
            }))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("overleaf-chat-list")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.chat.scroll)
                            .on_scroll(cx.listener(|this, _, _, cx| {
                                if this.chat_near_bottom() {
                                    this.chat.below = false;
                                }
                                cx.notify();
                            }))
                            .child(
                                div()
                                    .min_h_full()
                                    .flex()
                                    .flex_col()
                                    .px(px(2.))
                                    .pb(px(10.))
                                    .child(list),
                            ),
                    )
                    .child(FluidScrollbar::vertical(
                        "overleaf-chat-scrollbar",
                        &self.chat.scroll,
                    )),
            )
            .when(self.chat.below, |this| {
                this.child(
                    div().flex_none().flex().justify_center().pt(px(4.)).child(
                        Button::new("overleaf-chat-latest", t!("Jump to new messages"))
                            .variant(ButtonVariant::Secondary)
                            .size(ButtonSize::Compact)
                            .on_click(move |_, _, cx| {
                                jump.update(cx, |this, cx| {
                                    this.chat.scroll.scroll_to_bottom();
                                    this.chat.below = false;
                                    cx.notify();
                                })
                                .ok();
                            }),
                    ),
                )
            })
            .child(
                div()
                    .flex_none()
                    .flex()
                    .items_end()
                    .gap(px(8.))
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(palette.line)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .child(Textarea::new(&input).grows()),
                    )
                    .child(
                        IconButton::new("overleaf-chat-send", Icon::SEND_HORIZONTAL)
                            .tooltip(t!("Send message"))
                            .disabled(empty || sending)
                            .on_click(move |_, _, cx| {
                                send.update(cx, |this, cx| this.send_chat(cx)).ok();
                            }),
                    ),
            )
            .into_any_element()
    }

    /// The composer's field, made the first time the chat is shown.
    fn chat_input(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextareaState> {
        if let Some((input, _)) = self.chat.input.as_ref() {
            return input.clone();
        }
        let (min, max) = COMPOSER_ROWS;
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(min, max)
                .submit_on_enter(true)
        });
        input.update(cx, |state, cx| state.focus(window, cx));
        let enter = cx.subscribe(&input, |this, _, event: &InputEvent, cx| match event {
            InputEvent::PressEnter { shift: false, .. } => this.send_chat(cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        self.chat.input = Some((input.clone(), enter));
        input
    }

    /// Send the composer's text; it clears once Overleaf has it, and stays,
    /// to send again, when Overleaf refuses it.
    fn send_chat(&mut self, cx: &mut Context<Self>) {
        let Some((input, _)) = self.chat.input.as_ref() else {
            return;
        };
        let text = input.read(cx).value().to_string();
        if text.trim().is_empty() || self.bridge.read(cx).chat_sending() {
            return;
        }
        let panel = cx.weak_entity();
        let done = move |cx: &mut App| {
            panel
                .update(cx, |panel, cx| {
                    panel.chat.sent = true;
                    cx.notify();
                })
                .ok();
        };
        // Sending is the writer catching up: the list goes to its bottom.
        self.chat.scroll.scroll_to_bottom();
        self.chat.below = false;
        self.bridge
            .update(cx, |bridge, cx| bridge.send_chat(text, done, cx));
        cx.notify();
    }

    /// What the composer holds, for a scenario.
    pub fn chat_draft(&self, cx: &App) -> Option<String> {
        let (input, _) = self.chat.input.as_ref()?;
        Some(input.read(cx).value().to_string())
    }

    fn chat_near_bottom(&self) -> bool {
        let offset = self.chat.scroll.offset().y;
        let max = self.chat.scroll.max_offset().y;
        max + offset < px(FOLLOW_SLACK)
    }

    /// Put the list at its bottom the first time, and again when a message
    /// arrives while the reader is there; otherwise say one is below.
    fn follow(&mut self, messages: &[OverleafMessage]) {
        let shown = (
            messages.len(),
            messages.last().map(|message| message.id.clone()),
        );
        if shown == self.chat.shown && self.chat.positioned {
            return;
        }
        let fewer = shown.0 < self.chat.shown.0;
        if !self.chat.positioned || fewer || self.chat_near_bottom() {
            self.chat.scroll.scroll_to_bottom();
            self.chat.below = false;
        } else if shown.1 != self.chat.shown.1 {
            self.chat.below = true;
        }
        self.chat.positioned = !messages.is_empty();
        self.chat.shown = shown;
    }

    fn chat_rows(&self, messages: &[OverleafMessage], cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let bridge = self.bridge.read(cx);
        let locale = locale();
        let mut list = div().flex().flex_col();
        for (index, message) in messages.iter().enumerate() {
            let previous = index.checked_sub(1).map(|index| &messages[index]);
            let new_day = previous.is_none_or(|previous| {
                time::day_key(previous.timestamp) != time::day_key(message.timestamp)
            });
            let grouped = previous.is_some_and(|previous| {
                previous.mine == message.mine
                    && previous.author_name == message.author_name
                    && message.timestamp - previous.timestamp < RUN
            });
            let opens_run = !grouped || new_day;
            if new_day {
                list = list.child(day_rule(
                    index,
                    time::day_name(message.timestamp, locale),
                    index == 0,
                    cx,
                ));
            }
            let face = opens_run.then(|| {
                let color = person_color(
                    bridge,
                    &message.author_name,
                    message.author_email.as_deref(),
                    message.mine,
                );
                avatar(&message.author_name, color, px(20.))
            });
            let header = opens_run.then(|| {
                let name = if message.mine {
                    t!("You").to_string()
                } else {
                    message.author_name.clone()
                };
                div()
                    .min_w_0()
                    .h(px(20.))
                    .flex()
                    .items_baseline()
                    .gap(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .text_role(TextRole::BodyCompact, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text)
                            .child(name),
                    )
                    .child(
                        div()
                            .flex_none()
                            .font_features(tabular_nums())
                            .child(time::clock_time(message.timestamp, locale)),
                    )
            });
            list = list.child(
                div()
                    .id(SharedString::from(format!("overleaf-chat-{}", message.id)))
                    .flex()
                    .gap(px(8.))
                    .pt(px(if opens_run { 10. } else { 2. }))
                    .child(div().flex_none().w(px(20.)).pt(px(2.)).children(face))
                    .child(
                        div().flex_1().min_w_0().children(header).child(
                            div()
                                .text_role(TextRole::Body, cx)
                                .text_color(palette.text)
                                .whitespace_normal()
                                .child(message.content.clone()),
                        ),
                    ),
            );
        }
        list.into_any_element()
    }
}

/// The rule naming the day (`.chat-day`).
fn day_rule(index: usize, day: String, first: bool, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let line = || div().flex_1().h(px(1.)).bg(palette.line);
    div()
        .id(("overleaf-chat-day", index))
        .mt(px(if first { 0. } else { 12. }))
        .mb(px(4.))
        .flex()
        .items_center()
        .gap(px(8.))
        .text_role(TextRole::Caption, cx)
        .text_color(palette.text_secondary)
        .whitespace_nowrap()
        .child(line())
        .child(day)
        .child(line())
        .into_any_element()
}

/// "Message Alex, Mina and Sofia…" for up to three people here, by first
/// name as you would address them; else "Message your collaborators…".
fn chat_placeholder(bridge: &OverleafBridge) -> SharedString {
    let names: Vec<String> = bridge
        .peers()
        .iter()
        .map(|peer| {
            peer.name
                .split_whitespace()
                .next()
                .map(str::to_string)
                .unwrap_or_else(|| t!("Anonymous").to_string())
        })
        .collect();
    match names.as_slice() {
        [] => t!("Message your collaborators…").into(),
        [one] => space_mixed_script(&t!("Message {here}…", here = one)).into(),
        [rest @ .., last] if names.len() <= 3 => {
            let here = t!("{rest} and {last}", rest = join_list(rest), last = last);
            space_mixed_script(&t!("Message {here}…", here = here)).into()
        }
        _ => t!("Message your collaborators…").into(),
    }
}
