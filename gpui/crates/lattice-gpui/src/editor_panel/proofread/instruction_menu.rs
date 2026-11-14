//! The selection toolbar's Rewrite menu, as the Tauri app has it
//! (`src/editor/latex/selection-instruction-menu.tsx`, `.instruction-menu`
//! in `editor-workspace.css`): the writer types what the agent should do
//! with the selection ("translate into academic English", "cut to 100
//! words") and gets the proofread card's reviewable suggestion. Below the
//! field, the last few instructions for reuse, or starting points before
//! there are any.
//!
//! The recent instructions are the writer's, not a project's, as the
//! highlighters are: kept in `selection-instructions.json` in the app's
//! state folder.

use std::path::PathBuf;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Global, InteractiveElement as _,
    IntoElement, ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _,
    Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::input::{InputEvent, InputState};
use lattice_i18n::{t, tc};
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, components::Field};

use super::super::EditorPanel;

const RECENT_MAX: usize = 5;
/// An instruction is a sentence or two; past this it is a pasted excerpt.
const INSTRUCTION_MAX_LENGTH: usize = 400;
/// The menu's width (`.instruction-menu`).
pub(in crate::editor_panel) const WIDTH: f32 = 280.;

/// Collapse an instruction's spaces and keep it to its limit.
fn tidy(instruction: &str) -> String {
    instruction
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(INSTRUCTION_MAX_LENGTH)
        .collect()
}

struct Recent(Vec<String>, Option<PathBuf>);

impl Global for Recent {}

fn recent(cx: &mut App) -> &Vec<String> {
    if !cx.has_global::<Recent>() {
        let file = crate::shell::workspaces::state_dir(crate::settings::scripted(cx))
            .map(|dir| dir.join("selection-instructions.json"));
        let items = file
            .as_ref()
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default()
            .iter()
            .map(|item| tidy(item))
            .filter(|item| !item.is_empty())
            .take(RECENT_MAX)
            .collect();
        cx.set_global(Recent(items, file));
    }
    &cx.global::<Recent>().0
}

/// Put `instruction` first among the recent ones, once.
fn remember(instruction: &str, cx: &mut App) {
    let mut items = recent(cx).clone();
    items.retain(|item| item != instruction);
    items.insert(0, instruction.to_string());
    items.truncate(RECENT_MAX);
    let file = cx.global::<Recent>().1.clone();
    if let Some(file) = &file
        && let Ok(text) = serde_json::to_string(&items)
    {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(file, text).ok();
    }
    cx.set_global(Recent(items, file));
}

/// The open menu: its field.
pub(in crate::editor_panel) struct InstructionMenu {
    field: Entity<InputState>,
    _submit: Subscription,
}

impl EditorPanel {
    /// Open the Rewrite menu's field, focused.
    pub(in crate::editor_panel) fn open_instruction_menu(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let field = cx.new(|cx| {
            InputState::new(window, cx).placeholder(t!("What should the agent change?"))
        });
        field.update(cx, |field, cx| field.focus(window, cx));
        let submit = cx.subscribe_in(&field, window, |this, field, event, window, cx| {
            if let InputEvent::PressEnter { .. } = event {
                let text = field.read(cx).value().to_string();
                this.submit_instruction(&text, window, cx);
            }
        });
        self.proofread.instruction = Some(InstructionMenu {
            field,
            _submit: submit,
        });
    }

    fn submit_instruction(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let instruction = tidy(text);
        if instruction.is_empty() {
            return;
        }
        remember(&instruction, cx);
        self.proofread.instruction = None;
        self.start_proofread(lattice_editor::proofread::Ask::Instruction(instruction), window, cx);
    }

    /// The menu's content.
    pub(in crate::editor_panel) fn instruction_menu(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(menu) = &self.proofread.instruction else {
            return div().into_any_element();
        };
        let field = menu.field.clone();
        let filled = !field.read(cx).value().trim().is_empty();
        let items = recent(cx).clone();
        let reuse = !items.is_empty();
        let choices: Vec<String> = if reuse {
            items
        } else {
            vec![
                t!("Translate into academic English").to_string(),
                t!("Translate into Chinese").to_string(),
                t!("Shorten to about 100 words").to_string(),
                t!("Use the passive voice").to_string(),
            ]
        };
        let submit_field = field.clone();
        let form = div()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(div().flex_1().min_w_0().child(Field::new(&field).compact()))
            .child(
                div()
                    .id("instruction-submit")
                    .h(px(28.))
                    .px(px(10.))
                    .flex()
                    .flex_none()
                    .items_center()
                    .rounded(px(6.))
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(if filled { palette.text } else { palette.disabled_ink })
                    .bg(if filled { palette.tinted } else { palette.disabled_surface })
                    .when(filled, |this| {
                        this.cursor_pointer()
                            .hover(|style| style.bg(palette.tinted_hover))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let text = submit_field.read(cx).value().to_string();
                                this.submit_instruction(&text, window, cx);
                            }))
                    })
                    .child(tc!("selection instruction", "Rewrite")),
            );
        let mut list = div().flex().flex_col().child(
            div()
                .px(px(8.))
                .py(px(4.))
                .text_role(TextRole::Micro, cx)
                .text_color(palette.text_secondary.opacity(0.8))
                .child(if reuse { t!("Recent") } else { t!("Try") }),
        );
        for (index, choice) in choices.into_iter().enumerate() {
            let label = SharedString::from(choice.clone());
            list = list.child(
                div()
                    .id(("instruction-choice", index))
                    .h(px(28.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text)
                    .hover(|style| style.bg(palette.hover))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(label),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.submit_instruction(&choice, window, cx)
                    })),
            );
        }
        div()
            .w(px(WIDTH))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(form)
            .child(list)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::tidy;

    #[test]
    fn an_instruction_is_one_line_within_its_limit() {
        assert_eq!(tidy("  cut  to\n100 words "), "cut to 100 words");
        assert_eq!(tidy(&"字".repeat(500)).chars().count(), 400);
    }
}
