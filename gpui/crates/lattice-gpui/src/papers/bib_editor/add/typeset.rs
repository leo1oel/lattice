//! Add reference's preview: the entry as a reference list will print it.

use gpui::{
    AnyElement, Context, IntoElement, ParentElement as _, SharedString, Styled as _, div,
    prelude::FluentBuilder as _, px, relative,
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
        // A book's publisher, else the first venue typed, whatever the
        // type (the Tauri app's `recordVenue`: journal, booktitle, then
        // publisher), so a `@misc` with a venue still previews one.
        let venue = bib_text_to_plain(if draft.entry_type == "book" {
            &draft.publisher
        } else {
            [&draft.journal, &draft.booktitle, &draft.publisher]
                .into_iter()
                .find(|venue| !venue.is_empty())
                .map_or("", |venue| venue.as_str())
        });
        let year = draft.year.trim().to_string();
        let doi = draft.doi();
        let printed = [venue.clone(), year.clone()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        let key = (!title.is_empty()).then(|| {
            div()
                .flex_none()
                .max_w(relative(0.45))
                .ml(px(12.))
                .mb(px(4.))
                .px(px(6.))
                .rounded(px(4.))
                .bg(palette.text.opacity(0.05))
                .truncate()
                .font_family(cx.lattice().fonts.editor.clone())
                .text_role(TextRole::Micro, cx)
                .line_height(px(18.))
                .text_color(palette.text_secondary)
                .child(draft.key())
        });
        // The key sits at the card's corner, the authors' line beside it
        // (`.bib-typeset-key`'s float).
        div()
            .flex()
            .flex_col()
            .flex_none()
            .py(px(12.))
            .px(px(16.))
            .rounded(px(10.))
            .bg(palette.raised)
            .border_1()
            .border_color(palette.line)
            .child(
                div()
                    .flex()
                    .items_start()
                    .min_w_0()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
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
                    .children(key),
            )
            .child(
                div()
                    .my(px(2.))
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
            .child(if printed.is_empty() && doi.is_empty() {
                div()
                    .font_family(cx.lattice().fonts.display.clone())
                    .text_role(TextRole::Caption, cx)
                    .text_color(unfilled)
                    .child(if draft.entry_type == "book" {
                        t!("Publisher")
                    } else {
                        t!("Venue")
                    })
            } else {
                // The venue and year as printed, then the DOI in the
                // interface's own type, set apart by spacing.
                div()
                    .flex()
                    .flex_wrap()
                    .font_family(cx.lattice().fonts.display.clone())
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .when(!venue.is_empty() && !year.is_empty(), |line| {
                        line.child(div().italic().child(venue.clone())).child(", ")
                    })
                    .when(!venue.is_empty() && year.is_empty(), |line| {
                        line.child(div().italic().child(venue.clone()))
                    })
                    .when(!year.is_empty(), |line| line.child(year))
                    .when(!doi.is_empty(), |line| {
                        line.when(!printed.is_empty(), |line| {
                            line.child(div().px(px(6.)).child("\u{a0}"))
                        })
                        .child(
                            div()
                                .font_family(cx.lattice().fonts.ui.clone())
                                .child(format!("doi:{doi}")),
                        )
                    })
            })
            .into_any_element()
    }
}
