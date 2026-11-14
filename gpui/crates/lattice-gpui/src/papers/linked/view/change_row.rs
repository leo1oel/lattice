//! One change in the Linked library sheet: its box, title, key and kind,
//! and for an update or a clash each field as the project has it beside the
//! library's (`linked-library-sheet.tsx`). A dropped paper the manuscript
//! still cites stays, its box locked.

use gpui::{
    AnyElement, Context, IntoElement, ParentElement as _, SharedString, Styled as _, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{CheckState, Checkbox},
    interaction::mix,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::LinkedLibrary;
use crate::papers::linked::{ChangeKind, ENTRY_TYPE_FIELD, LibraryChange};

pub(super) fn kind_label(kind: ChangeKind) -> &'static str {
    match kind {
        ChangeKind::New => t!("New"),
        ChangeKind::Updated => t!("Updated"),
        ChangeKind::Conflict => t!("Changed here"),
        ChangeKind::Removed => t!("Removed from library"),
    }
}

impl LinkedLibrary {
    pub(super) fn change_row(
        &self,
        change: &LibraryChange,
        editor_font: SharedString,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let locked = change.kind == ChangeKind::Removed && change.cited;
        let on = self.selected.contains(&change.id) && !locked;
        let id = change.id.clone();
        let kind_ink = match change.kind {
            ChangeKind::New => mix(palette.success, palette.text, 0.2),
            ChangeKind::Updated => palette.accent,
            ChangeKind::Conflict => mix(palette.warning, palette.text, 0.3),
            ChangeKind::Removed => mix(palette.danger, palette.text, 0.25),
        };
        let none = t!("none");
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .px(px(12.))
            .py(px(10.))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .child(
                        Checkbox::new(
                            SharedString::from(format!("linked:{id}")),
                            if on { CheckState::On } else { CheckState::Off },
                        )
                        .disabled(locked || self.busy)
                        .on_toggle(cx.listener(
                            move |this, on: &bool, _, cx| {
                                if *on {
                                    this.selected.insert(id.clone());
                                } else {
                                    this.selected.remove(&id);
                                }
                                cx.notify();
                            },
                        )),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .truncate()
                                    .text_role(TextRole::BodyCompact, cx)
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(palette.text)
                                    .child(change.title.clone()),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(px(8.))
                                    .text_role(TextRole::Caption, cx)
                                    .text_color(palette.text_secondary)
                                    .child(
                                        div()
                                            .font_family(editor_font.clone())
                                            .child(change.key.clone()),
                                    )
                                    .when(locked, |line| {
                                        line.child(t!("Cited in the paper, so it stays"))
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_role(TextRole::Caption, cx)
                            .text_color(kind_ink)
                            .child(kind_label(change.kind)),
                    ),
            )
            .when(!change.fields.is_empty(), |row| {
                row.child(div().flex().flex_col().gap(px(4.)).pl(px(26.)).children(
                    change.fields.iter().map(|field| {
                        let name = if field.name == ENTRY_TYPE_FIELD {
                            t!("entry type").to_string()
                        } else {
                            field.name.clone()
                        };
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(8.))
                            .text_role(TextRole::Caption, cx)
                            .child(
                                div()
                                    .flex_none()
                                    .w(px(96.))
                                    .truncate()
                                    .font_family(editor_font.clone())
                                    .text_color(palette.text_secondary)
                                    .child(name),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_color(if field.conflict {
                                        palette.text
                                    } else {
                                        palette.text_secondary
                                    })
                                    .when(field.conflict, |value| {
                                        value.child(div().italic().mr(px(4.)).child(t!("Yours")))
                                    })
                                    .child(field.local.clone().unwrap_or_else(|| none.to_string())),
                            )
                            .child(Icon::ARROW_RIGHT.element(px(11.), palette.text_secondary))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_color(palette.text)
                                    .child(
                                        field.library.clone().unwrap_or_else(|| none.to_string()),
                                    ),
                            )
                    }),
                ))
            })
            .into_any_element()
    }
}
