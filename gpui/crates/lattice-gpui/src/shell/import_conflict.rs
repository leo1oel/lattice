//! The one question an import asks, as the Tauri app's
//! `import-conflict-dialog.tsx` asks it: what to do with the names the
//! target folder already has, answered once for the whole batch. Each answer
//! is its own button, as Finder asks it: Keep both is the default (Enter), as
//! the answer that loses nothing; Replace overwrites files of the same name
//! and merges folders, drawn in the danger ink; Skip leaves them out. Escape
//! or Cancel imports nothing.
//!
//! A 420px small dialog at the upper third: the warning mark, the title
//! naming the one taken name and the folder (or counting several), the
//! sentence saying what Replace and Keep both do, several names listed in the
//! editor's face (the first three, the rest counted), then Cancel, Skip,
//! Replace and Keep both.

use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Global, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::project::NameConflict;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, LayerPlacement, ModalLayer, rise_in},
};

/// Names listed before the rest are counted.
const LISTED_NAMES: usize = 3;
/// What Enter answers: the answer that loses nothing.
const DEFAULT_ANSWER: NameConflict = NameConflict::KeepBoth;

type Answer = Box<dyn FnOnce(Option<NameConflict>, &mut Window, &mut App)>;

struct Question {
    names: Vec<String>,
    target: String,
    answer: Answer,
}

pub struct ImportConflict {
    open: Option<Question>,
    focus: FocusHandle,
    /// Bumped per question, so each one's dialog enters afresh.
    serial: usize,
}

struct ImportConflictGlobal(Entity<ImportConflict>);

impl Global for ImportConflictGlobal {}

/// The dialog every window's shell draws; made on first use.
pub fn install(cx: &mut App) -> Entity<ImportConflict> {
    if let Some(global) = cx.try_global::<ImportConflictGlobal>() {
        return global.0.clone();
    }
    let host = cx.new(|cx| ImportConflict {
        open: None,
        focus: cx.focus_handle(),
        serial: 0,
    });
    cx.set_global(ImportConflictGlobal(host.clone()));
    host
}

/// Ask what to do with `names` already in `target` ("" is the project
/// root); `answer` hears the choice, or `None` for Cancel.
pub fn ask(
    names: Vec<String>,
    target: String,
    answer: impl FnOnce(Option<NameConflict>, &mut Window, &mut App) + 'static,
    cx: &mut App,
) {
    let host = install(cx);
    host.update(cx, |host, cx| {
        host.serial += 1;
        host.open = Some(Question {
            names,
            target,
            answer: Box::new(answer),
        });
        cx.notify();
    });
}

impl ImportConflict {
    fn answer(
        &mut self,
        choice: Option<NameConflict>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(question) = self.open.take() {
            cx.notify();
            (question.answer)(choice, window, cx);
        }
    }

    /// The title: the one taken name and its folder, or how many there are.
    fn title(names: &[String], target: &str) -> SharedString {
        match (names, target.is_empty()) {
            ([name], true) => {
                t!("“{name}” is already in the project root", name = name).to_string()
            }
            ([name], false) => t!(
                "“{name}” is already in {targetDirectory}",
                name = name,
                targetDirectory = target
            )
            .to_string(),
            (names, true) => t!(
                "{count} items with these names are already in the project root",
                count = names.len()
            )
            .to_string(),
            (names, false) => t!(
                "{count} items with these names are already in {targetDirectory}",
                count = names.len(),
                targetDirectory = target
            )
            .to_string(),
        }
        .into()
    }

    /// Whether a question is up, and what Enter answers, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn asking(&self) -> Option<(SharedString, NameConflict)> {
        self.open.as_ref().map(|question| {
            (
                Self::title(&question.names, &question.target),
                DEFAULT_ANSWER,
            )
        })
    }

    /// Press `choice`'s button, as the writer would, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn choose(&mut self, choice: NameConflict, window: &mut Window, cx: &mut Context<Self>) {
        self.answer(Some(choice), window, cx);
    }
}

impl Render for ImportConflict {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(question) = &self.open else {
            return div().into_any_element();
        };
        let palette = cx.palette().clone();
        let editor = cx.lattice().fonts.editor.clone();
        let title = Self::title(&question.names, &question.target);
        let serial = self.serial;
        let several = question.names.len() > 1;
        let hidden = question.names.len().saturating_sub(LISTED_NAMES);
        let names = div()
            .flex()
            .flex_col()
            .pt(px(8.))
            .children(question.names.iter().take(LISTED_NAMES).map(|name| {
                div()
                    .overflow_hidden()
                    .text_ellipsis()
                    .whitespace_nowrap()
                    .font_family(editor.clone())
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text)
                    .child(name.clone())
            }))
            .when(hidden > 0, |this| {
                this.child(
                    div()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary.opacity(0.75))
                        .child(t!("and {hidden} more", hidden = hidden)),
                )
            });
        // Each answer plays the dialog's exit before it runs.
        let answer_button =
            |button: Button, choice: Option<NameConflict>, cx: &mut Context<Self>| {
                button.on_click(ModalLayer::closing(
                    ("import-conflict", serial),
                    cx,
                    move |this, window, cx| this.answer(choice, window, cx),
                ))
            };
        let actions = div()
            .flex()
            .justify_end()
            .gap(px(8.))
            .pt(px(24.))
            .child(answer_button(
                Button::new(("import-conflict-cancel", serial), t!("Cancel")).ghost(),
                None,
                cx,
            ))
            .child(answer_button(
                Button::new(("import-conflict-skip", serial), t!("Skip")),
                Some(NameConflict::Skip),
                cx,
            ))
            .child(answer_button(
                Button::new(("import-conflict-replace", serial), t!("Replace")).ghost_danger(),
                Some(NameConflict::Replace),
                cx,
            ))
            .child(answer_button(
                Button::new(("import-conflict-keep-both", serial), t!("Keep both")).primary(),
                Some(NameConflict::KeepBoth),
                cx,
            ));
        let card = div()
            .w(px(420.).min(window.viewport_size().width - px(40.)))
            .flex()
            .flex_col()
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(px(14.))
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .child(
                div()
                    .size(px(36.))
                    .mb(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(10.))
                    .bg(palette.warning_soft)
                    .child(Icon::FOLDER_INPUT.element(px(18.), palette.warning)),
            )
            .child(
                div()
                    .text_role(TextRole::Title, cx)
                    .text_color(palette.text)
                    .mb(px(4.))
                    .child(title),
            )
            .child(
                div()
                    .text_role(TextRole::Body, cx)
                    .text_color(palette.text_secondary)
                    .child(t!(
                        "Replace overwrites files of the same name and merges folders. Keep both imports a numbered copy."
                    )),
            )
            .when(several, |this| this.child(names))
            .child(actions);
        let keys = div()
            .id(("import-conflict-keys", serial))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key != "enter" {
                    return;
                }
                // Enter answers as Keep both does, after the exit.
                let view = cx.entity().downgrade();
                ModalLayer::leave(
                    ("import-conflict", this.serial),
                    window,
                    cx,
                    move |window, cx| {
                        view.update(cx, |this, cx| this.answer(Some(DEFAULT_ANSWER), window, cx))
                            .ok();
                    },
                );
                cx.stop_propagation();
            }))
            .child(rise_in(("import-conflict-rise", serial), card));
        let view = cx.entity().downgrade();
        ModalLayer::new(
            ("import-conflict", serial),
            LayerPlacement::UpperThird,
            keys,
            move |window, cx| {
                view.update(cx, |this, cx| this.answer(None, window, cx))
                    .ok();
            },
        )
        .initial_focus(self.focus.clone())
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_names_one_item_and_its_folder_and_counts_several() {
        assert_eq!(
            &*ImportConflict::title(&["main.tex".into()], "figures"),
            "“main.tex” is already in figures"
        );
        assert_eq!(
            &*ImportConflict::title(&["main.tex".into()], ""),
            "“main.tex” is already in the project root"
        );
        assert_eq!(
            &*ImportConflict::title(&["a".into(), "b".into(), "c".into()], ""),
            "3 items with these names are already in the project root"
        );
    }
}
