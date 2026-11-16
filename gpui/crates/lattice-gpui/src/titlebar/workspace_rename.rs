//! A workspace renamed in place of its tab (`NameField`,
//! `trellis-workspace-switch.tsx`): the field opens with the name selected
//! and holds at most 24 characters; Enter keeps a free name, and one already
//! used stays in editing, ringed as invalid with "Name already used" until
//! the next keystroke; Escape keeps the old name and leaving the field keeps
//! a free one. The keyboard goes back to the workspace's tab.

use gpui::{
    AnyElement, AnyView, AppContext as _, Context, EntityInputHandler as _,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use lattice_i18n::t;
use lattice_ui::{TextRole, TextRoleStyle as _, components::LatticeTooltip, elevation::ring};

use super::workspace_switch::{RENAME_MIN, RENAME_PAD, raised_plate, segment_chip_radius};
use crate::shell::{
    Shell,
    workspaces::{NAME_MAX, RenameError, Workspaces, shown_name},
};

impl Shell {
    pub(crate) fn rename_input(&self) -> Option<gpui::Entity<InputState>> {
        self.rename_input.clone()
    }

    /// Edit workspace `id`'s name in place of its tab: Enter keeps a free
    /// name (one already taken stays in editing), Escape keeps the old one,
    /// and leaving the field keeps a free name or else the old one.
    pub(crate) fn start_rename(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(name) = Workspaces::global(cx)
            .get(id)
            .map(|entry| shown_name(&entry.name))
        else {
            return;
        };
        let input = cx.new(|cx| {
            let mut state = InputState::new(window, cx);
            state.set_value(name, window, cx);
            state
        });
        let target = id.to_string();
        let subscription = cx.subscribe_in(
            &input,
            window,
            move |this, input, event, window, cx| match event {
                // At most 24 characters (`maxLength`), held once a
                // composition is committed; typing clears a taken name's
                // mark.
                InputEvent::Change => {
                    let composing = input.update(cx, |input, cx| {
                        input.marked_text_range(window, cx).is_some()
                    });
                    if !composing {
                        let (value, caret) = {
                            let input = input.read(cx);
                            (input.value().to_string(), input.cursor())
                        };
                        if let Some((value, caret)) = fit_name(&value, caret) {
                            // `set_value` clears the field's undo history
                            // (gpui-base resets its undo manager), where the
                            // Tauri app's `maxLength` field keeps it: the Kit
                            // input has no hook that clips an insertion before
                            // it is applied. A `max_length` on the patched
                            // input would remove this.
                            input.update(cx, |input, cx| {
                                input.set_value(value, window, cx);
                                input.set_selected_range(caret..caret, cx);
                            });
                        }
                    }
                    if std::mem::take(&mut this.layout.track.taken) {
                        cx.notify();
                    }
                }
                InputEvent::PressEnter { .. } => {
                    let name = input.read(cx).value().to_string();
                    let result = Workspaces::update(cx, |library| library.rename(&target, &name));
                    if result == Err(RenameError::Taken) {
                        this.layout.track.taken = true;
                        cx.notify();
                    } else {
                        this.finish_rename(window, cx);
                    }
                }
                InputEvent::Blur => {
                    let name = input.read(cx).value().to_string();
                    let _ = Workspaces::update(cx, |library| library.rename(&target, &name));
                    this.finish_rename(window, cx);
                }
                _ => {}
            },
        );
        input.update(cx, |input, cx| {
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        self.layout.renaming = Some(id.to_string());
        self.layout.track.taken = false;
        self.rename_input = Some(input);
        self.rename_subscription = Some(subscription);
        cx.notify();
    }

    /// Close the rename field. The keyboard comes back to the window only
    /// from the field itself: a click elsewhere keeps the focus it moved.
    pub(crate) fn finish_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let held = self.rename_input.take().is_some_and(|input| {
            gpui::Focusable::focus_handle(input.read(cx), cx).contains_focused(window, cx)
        });
        let renamed = self.layout.renaming.take();
        self.layout.track.taken = false;
        self.rename_subscription = None;
        // The keyboard goes back to the workspace's tab (the folded switch
        // has none, so to the window).
        if held || window.focused(cx).is_none() {
            match renamed {
                Some(id) if self.layout.track.has_tab(&id) => {
                    self.focus_workspace_tab(&id, window, cx)
                }
                _ => window.focus(&self.focus_handle, cx),
            }
        }
        cx.notify();
    }
}

/// The field a workspace's name is edited in, where its tab (or the folded
/// switch) stands; Escape keeps the old name.
pub(super) fn rename_field(
    id: impl Into<gpui::ElementId>,
    input: &gpui::Entity<InputState>,
    taken: bool,
    palette: &lattice_ui::Palette,
    cx: &mut Context<Shell>,
) -> AnyElement {
    let mut plate = raised_plate(palette);
    if taken {
        // `--control-invalid-border` at the focus ring's width.
        plate.push(gpui::BoxShadow {
            spread_radius: px(2.),
            ..ring(palette.danger)
        });
    }
    div()
        .id(id)
        .h(px(24.))
        .min_w(px(RENAME_MIN))
        .px(px(RENAME_PAD))
        .flex()
        .items_center()
        .rounded(segment_chip_radius())
        .bg(palette.panel)
        .shadow(plate)
        .when(taken, |field| {
            field.tooltip(|_, cx| -> AnyView {
                LatticeTooltip::view(t!("Name already used"), None, cx)
            })
        })
        .text_role(TextRole::Caption, cx)
        .capture_key_down(cx.listener(|shell, event: &KeyDownEvent, window, cx| {
            if event.keystroke.key == "escape" {
                shell.finish_rename(window, cx);
                cx.stop_propagation();
            }
        }))
        .child(Input::new(input).appearance(false).bordered(false))
        .into_any_element()
}

/// `value` held to [`NAME_MAX`] characters the way a `maxLength` field holds
/// it, `caret` (a byte offset) just after what went in: what went in is cut
/// to the room left, the text after it kept. The held value and its caret,
/// when `value` is too long. The field opens on a stored name, never longer
/// than the limit, so what came before the insertion always fits.
fn fit_name(value: &str, caret: usize) -> Option<(String, usize)> {
    let count = value.chars().count();
    if count <= NAME_MAX {
        return None;
    }
    let tail = &value[caret..];
    let keep = NAME_MAX.saturating_sub(tail.chars().count());
    let mut held: String = value.chars().take(keep).collect();
    let caret = held.len();
    held.push_str(tail);
    Some((held, caret))
}

#[cfg(test)]
mod tests {
    use super::fit_name;

    // The expectations follow the HTML `maxLength` rule: an insertion is cut
    // to the room left, and the text around it stays as it was.

    #[test]
    fn a_character_typed_at_the_limit_goes_nowhere() {
        let typed = "abcdeZfghijklmnopqrstuvwx";
        assert_eq!(
            fit_name(typed, 6),
            Some(("abcdefghijklmnopqrstuvwx".to_string(), 5))
        );
    }

    #[test]
    fn a_paste_over_a_selection_keeps_what_fits() {
        // The pasted name ends as the one it replaced ("Workspace 3") did.
        let pasted = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
        assert_eq!(
            fit_name(pasted, pasted.len()),
            Some(("ABCDEFGHIJKLMNOPQRSTUVWX".to_string(), 24))
        );
        // "name" in "Draft name here" replaced: 11 characters stay, so 13 go in.
        let value = format!("Draft {pasted} here");
        assert_eq!(
            fit_name(&value, value.len() - " here".len()),
            Some(("Draft ABCDEFGHIJKLM here".to_string(), 19))
        );
    }

    #[test]
    fn a_composition_committed_mid_name_keeps_what_fits_and_the_tail() {
        let committed = "abcdefghij你好klmnopqrstuvw";
        assert_eq!(
            fit_name(committed, "abcdefghij你好".len()),
            Some(("abcdefghij你klmnopqrstuvw".to_string(), 13))
        );
    }

    #[test]
    fn a_name_that_fits_is_left_alone() {
        assert_eq!(fit_name("Drafts", 6), None);
    }
}
