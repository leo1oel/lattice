//! The terminal tabs, once there are two (`TerminalTab` in
//! `terminal-panel.tsx`): the compact tab plates of a panel's own strip, one
//! step quieter, on the screen's ground. A tab is chosen by a click and
//! renamed in place by a double-click (Enter or leaving the field keeps the
//! name, Escape drops it); its × closes it, shown on the tab in front and
//! under the pointer but holding its width, so hovering never resizes a tab.

use gpui::{
    AnyElement, AppContext as _, ClickEvent, Context, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{IconButton, Surface},
    interaction::{mix, track_pointer, use_interaction},
    shape,
};

use super::{Session, TerminalPanel};

/// A tab's name is at most this long (`maxLength`).
const NAME_MAX: usize = 40;

/// A tab is at most this wide (`.terminal-tab`).
const TAB_MAX: f32 = 200.;

/// The rename field's width (`.terminal-tab-rename`).
const RENAME_WIDTH: f32 = 120.;

/// A tab's name being edited in place.
pub(super) struct Rename {
    pub(super) key: usize,
    pub(super) input: Entity<InputState>,
    pub(super) _subscription: Subscription,
}

impl TerminalPanel {
    fn rename(&mut self, key: usize, name: &str, cx: &mut Context<Self>) {
        let trimmed: String = name.trim().chars().take(NAME_MAX).collect();
        if let Some(session) = self.sessions.iter_mut().find(|session| session.key == key) {
            session.name = (!trimmed.is_empty()).then_some(trimmed);
        }
        cx.notify();
    }

    pub(crate) fn start_rename(&mut self, key: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.sessions.iter().find(|session| session.key == key) else {
            return;
        };
        let label = session.label();
        let input = cx.new(|cx| {
            let mut input = InputState::new(window, cx);
            input.set_value(label, window, cx);
            input
        });
        let subscription = cx.subscribe_in(
            &input,
            window,
            move |panel, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { .. } | InputEvent::Blur => {
                    panel.finish_rename(true, window, cx)
                }
                _ => {}
            },
        );
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.rename = Some(Rename {
            key,
            input,
            _subscription: subscription,
        });
        cx.notify();
    }

    fn finish_rename(&mut self, commit: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(rename) = self.rename.take() else {
            return;
        };
        if commit {
            let value = rename.input.read(cx).value().to_string();
            self.rename(rename.key, &value, cx);
        }
        if let Some(screen) = self.active_screen() {
            screen.focus_handle(cx).focus(window, cx);
        }
        cx.notify();
    }

    pub(super) fn render_tab(
        &self,
        session: &Session,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let key = session.key;
        let selected = Some(key) == self.active;
        let label = session.label();
        let id = gpui::ElementId::NamedInteger("terminal-tab".into(), key as u64);
        let (interaction, pointer) = use_interaction(id.clone(), window, cx);
        let ground = lattice_ui::editor_theme::terminal::TerminalColors::new(
            cx.lattice().code_theme,
            &palette,
        )
        .ground;
        let selected_fill = palette.ink_on(0.10, lattice_ui::token_types::Srgb::from_hsla(ground));
        let background = if selected {
            selected_fill
        } else {
            mix(gpui::transparent_black(), palette.hover, interaction.hover)
        };
        let ink = if selected {
            palette.text
        } else {
            palette.text_secondary
        };
        let renaming = self.rename.as_ref().filter(|rename| rename.key == key);
        let close_shown = selected || interaction.hover > 0. || renaming.is_some();
        let body: AnyElement = match renaming {
            Some(rename) => div()
                .flex_none()
                .w(px(RENAME_WIDTH))
                .h(px(24.))
                .px(px(4.))
                .flex()
                .items_center()
                .border_1()
                .border_color(palette.field_border_hover)
                .rounded(shape::CHROME.paint(shape::RADIUS_CHIP))
                .bg(palette.input)
                .capture_key_down(cx.listener(|panel, event: &KeyDownEvent, window, cx| {
                    if event.keystroke.key == "escape" {
                        panel.finish_rename(false, window, cx);
                        cx.stop_propagation();
                    }
                }))
                .child(
                    Input::new(&rename.input)
                        .appearance(false)
                        .px_0()
                        .py_0()
                        .h_full()
                        .text_size(TextRole::Caption.font_size(Default::default(), cx)),
                )
                .into_any_element(),
            None => div()
                .id(("terminal-tab-label", key))
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .whitespace_nowrap()
                .child(label.clone())
                .on_click(cx.listener(move |panel, event: &ClickEvent, window, cx| {
                    if event.click_count() >= 2 {
                        panel.start_rename(key, window, cx);
                    } else {
                        panel.select(key, window, cx);
                    }
                }))
                .tooltip(|_, cx| {
                    lattice_ui::components::LatticeTooltip::view(
                        t!("Double-click to rename"),
                        None,
                        cx,
                    )
                })
                .into_any_element(),
        };
        let tab = div()
            .id(id)
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .h(px(28.))
            .max_w(px(TAB_MAX))
            .pl(px(8.))
            .pr(px(2.))
            .rounded(shape::CHROME.paint(shape::RADIUS_TARGET))
            .bg(background)
            .text_role(TextRole::Caption, cx)
            .text_color(ink)
            .child(body)
            .child(
                div()
                    .flex_none()
                    .opacity(if close_shown { 1. } else { 0. })
                    .child(
                        IconButton::new(("terminal-tab-close", key), Icon::X)
                            .frame(px(24.), px(24.))
                            .radius(shape::CHROME.paint(shape::RADIUS_TARGET))
                            .surface(Surface::Sheet)
                            .on_click(cx.listener(move |panel, _: &ClickEvent, window, cx| {
                                panel.request_close(key, window, cx)
                            })),
                    ),
            );
        track_pointer(tab, pointer).into_any_element()
    }
}
