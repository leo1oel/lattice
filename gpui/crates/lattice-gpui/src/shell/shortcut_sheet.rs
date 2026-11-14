//! The shortcut sheet (⌘?): every command with keys, by section, as the
//! Tauri app's sheet lists them (`src/app/command-palette.tsx`).

use gpui::{
    App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _, IntoElement,
    KeyDownEvent, MouseButton, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, TextRole, TextRoleStyle as _,
    components::{Keycap, rise_in},
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    Shell,
    commands::{self, Section},
    palette::PaletteEvent,
};

/// The shortcut sheet: every command with keys, by section.
pub(crate) struct ShortcutSheet {
    focus: FocusHandle,
    groups: Vec<(&'static str, Vec<(SharedString, SharedString)>)>,
}

impl EventEmitter<PaletteEvent> for ShortcutSheet {}

impl ShortcutSheet {
    pub(super) fn new(shell: &Shell, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut context = shell.command_context(cx);
        // Every command, as the sheet lists keys whatever applies now.
        context.in_project = true;
        let mut groups: Vec<(&'static str, Vec<(SharedString, SharedString)>)> = Vec::new();
        for command in commands::commands(&context) {
            let Some(keys) = commands::keys_label(command.action.as_ref(), window) else {
                continue;
            };
            let label = command.label;
            match groups
                .iter_mut()
                .find(|(name, _)| *name == command.section.label())
            {
                Some((_, rows)) => {
                    if !rows.iter().any(|(existing, _)| *existing == label) {
                        rows.push((label, keys));
                    } else if let Some(row) =
                        rows.iter_mut().find(|(existing, _)| *existing == label)
                    {
                        row.1 = key_range(&row.1, &keys).into();
                    }
                }
                None => groups.push((command.section.label(), vec![(label, keys)])),
            }
        }
        groups.sort_by_key(|(name, _)| {
            [
                Section::Navigate,
                Section::Edit,
                Section::Build,
                Section::View,
                Section::Layout,
                Section::Overleaf,
                Section::Project,
                Section::Appearance,
            ]
            .iter()
            .position(|section| section.label() == *name)
        });
        Self {
            focus: cx.focus_handle(),
            groups,
        }
    }
}

impl Focusable for ShortcutSheet {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ShortcutSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let width = px(560.).min(window.viewport_size().width - px(40.));
        let groups = self.groups.iter().map(|(name, rows)| {
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .pt(px(12.))
                        .pb(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(*name),
                )
                .children(rows.iter().map(|(label, keys)| {
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .min_h(px(28.))
                        .child(
                            div()
                                .text_role(TextRole::Body, cx)
                                .text_color(palette.text)
                                .child(label.clone()),
                        )
                        .child(Keycap::new(keys.clone()))
                }))
        });
        div()
            .id("shortcut-sheet-scrim")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .justify_center()
            .items_center()
            .bg(palette.scrim)
            .occlude()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|_, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    cx.emit(PaletteEvent::Dismiss);
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.emit(PaletteEvent::Dismiss)),
            )
            .child(rise_in(
                "shortcut-sheet-in",
                div()
                    .id("shortcut-sheet")
                    .w(width)
                    .max_h(window.viewport_size().height * 0.8)
                    .overflow_y_scroll()
                    .rounded(px(14.))
                    .bg(palette.raised)
                    .shadow(Elevation::Dialog.shadows(&palette))
                    .px(px(24.))
                    .pt(px(20.))
                    .pb(px(24.))
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .text_role(TextRole::Title, cx)
                            .text_color(palette.text)
                            .child(t!("Keyboard shortcuts")),
                    )
                    .children(groups),
            ))
    }
}

/// The keys of a row standing for several commands: from the first one's
/// keys to `last`'s.
fn key_range(keys: &str, last: &str) -> String {
    let first = keys.split('–').next().unwrap_or(keys);
    format!("{first}–{last}")
}

#[cfg(test)]
mod tests {
    use super::key_range;

    #[test]
    fn workspace_switch_keys_read_as_one_range_to_the_last() {
        let mut keys = "⌘1".to_string();
        for next in ["⌘2", "⌘3", "⌘9"] {
            keys = key_range(&keys, next);
        }
        assert_eq!(keys, "⌘1–⌘9");
    }
}
