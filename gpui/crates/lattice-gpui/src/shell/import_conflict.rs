//! The one question an import asks, as the Tauri app's
//! `import-conflict-dialog.tsx` asks it: what to do with the names the
//! target folder already has, answered once for the whole batch. Keep both
//! is chosen first, as the answer that loses nothing; Replace overwrites
//! files of the same name and merges folders; Skip leaves them out. Escape
//! or Cancel imports nothing.
//!
//! A 420px small dialog at the upper third: the warning mark, the title
//! naming the folder, the first three names in the editor's face (the rest
//! counted), and the three answers as a radio group whose plate slides to
//! the chosen one; ↑ ↓ move the choice and Enter imports.

use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Global, InteractiveElement as _,
    IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::project::NameConflict;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, LayerPlacement, ModalLayer, rise_in},
    interaction::{hover_wash, mix},
    motion::Motion,
    sliding::SlidingPlate,
    tokens::FONT_WEIGHT_SEMIBOLD,
};

/// Names listed before the rest are counted.
const LISTED_NAMES: usize = 3;
const CHOICES: [NameConflict; 3] = [
    NameConflict::KeepBoth,
    NameConflict::Replace,
    NameConflict::Skip,
];

type Answer = Box<dyn FnOnce(Option<NameConflict>, &mut Window, &mut App)>;

struct Question {
    names: Vec<String>,
    target: String,
    choice: usize,
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
            choice: 0,
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

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        if let Some(question) = self.open.as_mut() {
            let count = CHOICES.len() as isize;
            question.choice = (question.choice as isize + by).rem_euclid(count) as usize;
            cx.notify();
        }
    }

    /// The title, naming the folder.
    fn title(names: usize, target: &str) -> SharedString {
        match (names, target.is_empty()) {
            (1, true) => t!("An item with this name is already in the project root").to_string(),
            (1, false) => t!(
                "An item with this name is already in {targetDirectory}",
                targetDirectory = target
            )
            .to_string(),
            (count, true) => t!(
                "{count} items with these names are already in the project root",
                count = count
            )
            .to_string(),
            (count, false) => t!(
                "{count} items with these names are already in {targetDirectory}",
                count = count,
                targetDirectory = target
            )
            .to_string(),
        }
        .into()
    }

    /// Whether a question is up, and its choice, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn asking(&self) -> Option<(SharedString, NameConflict)> {
        self.open.as_ref().map(|question| {
            (
                Self::title(question.names.len(), &question.target),
                CHOICES[question.choice],
            )
        })
    }

    /// Choose `choice` and press Import, as the writer would, for a
    /// scenario.
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
        let count = question.names.len();
        let title = Self::title(count, &question.target);
        let serial = self.serial;
        let choice = question.choice;
        let hidden = count.saturating_sub(LISTED_NAMES);
        let names = div()
            .flex()
            .flex_col()
            .mb(px(16.))
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
        let labels: [(SharedString, Option<SharedString>); 3] = [
            (t!("Keep both").into(), None),
            (
                t!("Replace").into(),
                Some(t!("Overwrite files of the same name; merge folders").into()),
            ),
            (t!("Skip").into(), None),
        ];
        let plate = SlidingPlate::new(("import-conflict-plate", serial), Some(choice), window, cx);
        let plate_drawn = plate.is_drawn(cx);
        let rows = labels
            .into_iter()
            .enumerate()
            .map(|(ix, (label, description))| {
                let selected = ix == choice;
                let on = lattice_ui::interaction::fade(
                    ("import-conflict-on", serial * 4 + ix),
                    selected,
                    Motion::Fast,
                    window,
                    cx,
                );
                // The ring gives way to the dot, which springs in from 30%.
                let radio = div()
                    .relative()
                    .flex_none()
                    .size(px(16.))
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .rounded_full()
                            .border(px(1.5))
                            .border_color(mix(
                                palette.line_strong,
                                palette.line_strong.opacity(0.),
                                on,
                            )),
                    )
                    .child(
                        div()
                            .absolute()
                            .inset_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .opacity(on)
                            .child(
                                div()
                                    .size(px(8. * (0.3 + 0.7 * on)))
                                    .rounded_full()
                                    .bg(palette.text),
                            ),
                    );
                let row = div()
                    .id(("import-conflict-choice", serial * 4 + ix))
                    .relative()
                    .h(px(50.))
                    .flex()
                    .gap(px(8.))
                    .px(px(10.))
                    .pt(px(8.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(selected && !plate_drawn, |this| this.bg(palette.pressed))
                    .child(div().h(px(18.)).flex().items_center().child(radio))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .min_w_0()
                            .child(
                                div()
                                    .text_role(TextRole::Body, cx)
                                    .font_weight(if selected {
                                        FONT_WEIGHT_SEMIBOLD
                                    } else {
                                        lattice_ui::tokens::FONT_WEIGHT_REGULAR
                                    })
                                    .text_color(if selected {
                                        palette.text
                                    } else {
                                        palette.text_secondary
                                    })
                                    .child(label),
                            )
                            .children(description.map(|description| {
                                div()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .text_role(TextRole::Micro, cx)
                                    .text_color(palette.text_secondary)
                                    .child(description)
                            })),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(question) = this.open.as_mut() {
                            question.choice = ix;
                            cx.notify();
                        }
                    }));
                let row = hover_wash(
                    row,
                    ("import-conflict-hover", serial * 4 + ix),
                    gpui::transparent_black(),
                    palette.hover,
                    window,
                    cx,
                );
                plate.item(ix, row)
            });
        let rows: Vec<_> = rows.collect();
        let group = plate.strip(
            div()
                .relative()
                .mx(px(-10.))
                .children(plate.plate(|plate| plate.rounded(px(8.)).bg(palette.pressed), cx))
                .children(rows),
        );
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
            .child(names)
            .child(group)
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .pt(px(24.))
                    .child(
                        Button::new(("import-conflict-cancel", serial), t!("Cancel"))
                            .ghost()
                            .on_click(
                                cx.listener(|this, _, window, cx| this.answer(None, window, cx)),
                            ),
                    )
                    .child(
                        Button::new(("import-conflict-import", serial), t!("Import"))
                            .primary()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let choice =
                                    this.open.as_ref().map(|question| CHOICES[question.choice]);
                                this.answer(choice, window, cx)
                            })),
                    ),
            );
        let keys = div()
            .id(("import-conflict-keys", serial))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                match event.keystroke.key.as_str() {
                    "up" | "left" => this.step(-1, cx),
                    "down" | "right" => this.step(1, cx),
                    "enter" => {
                        let choice = this.open.as_ref().map(|question| CHOICES[question.choice]);
                        this.answer(choice, window, cx)
                    }
                    _ => return,
                }
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
    fn the_title_names_the_folder_and_counts_several() {
        assert_eq!(
            &*ImportConflict::title(1, "figures"),
            "An item with this name is already in figures"
        );
        assert_eq!(
            &*ImportConflict::title(3, ""),
            "3 items with these names are already in the project root"
        );
    }

    #[test]
    fn keep_both_is_offered_first() {
        assert_eq!(CHOICES[0], NameConflict::KeepBoth);
    }
}
