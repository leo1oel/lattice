//! Add reference's preview: the entry as a reference list will print it.

use gpui::{
    AnyElement, Context, IntoElement, ParentElement as _, SharedString, Styled as _, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::bib_document::bib_text_to_plain;
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

use super::AddReference;

impl AddReference {
    /// The entry as a reference list will print it, its key beside it.
    pub(super) fn typeset(&self, cx: &Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let draft = self.draft(cx);
        let unfilled = palette.text_secondary.opacity(0.6);
        let title = bib_text_to_plain(draft.title.trim());
        let authors = lattice_i18n::join_conjunction(&lattice_core::bib_document::author_names(
            draft.author.trim(),
        ));
        let venue = bib_text_to_plain(match draft.entry_type.as_str() {
            "article" => &draft.journal,
            "inproceedings" => &draft.booktitle,
            "book" => &draft.publisher,
            _ => "",
        });
        let year = draft.year.trim().to_string();
        let doi = draft.doi();
        let mut tail = vec![venue.clone(), year.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if !doi.is_empty() {
            tail = if tail.is_empty() {
                format!("doi:{doi}")
            } else {
                format!("{tail} doi:{doi}")
            };
        }
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .p(px(12.))
            .rounded(px(8.))
            .bg(palette.text.opacity(0.03))
            .when(!title.is_empty(), |card| {
                card.child(
                    div()
                        .font_family(cx.lattice().fonts.editor.clone())
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .child(draft.key()),
                )
            })
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .text_color(if authors.is_empty() {
                        unfilled
                    } else {
                        palette.text_secondary
                    })
                    .child(if authors.is_empty() {
                        SharedString::from(t!("Author"))
                    } else {
                        authors.into()
                    }),
            )
            .child(
                div()
                    .text_role(TextRole::Typeset, cx)
                    .text_color(if title.is_empty() {
                        unfilled
                    } else {
                        palette.text
                    })
                    .child(if title.is_empty() {
                        SharedString::from(t!("Title"))
                    } else {
                        title.into()
                    }),
            )
            .child(
                div()
                    .text_role(TextRole::Caption, cx)
                    .italic()
                    .text_color(if tail.is_empty() {
                        unfilled
                    } else {
                        palette.text_secondary
                    })
                    .child(if tail.is_empty() {
                        SharedString::from(if draft.entry_type == "book" {
                            t!("Publisher")
                        } else {
                            t!("Venue")
                        })
                    } else {
                        tail.into()
                    }),
            )
            .into_any_element()
    }
}
