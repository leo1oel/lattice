//! The reference card, drawn as the Tauri app's source editor draws it
//! (`fillReferenceEntry` and `referenceTooltips` in
//! `src/editor/latex/latex-hover-cards.ts`; the `.reference-hover-card` rules
//! in `src/styles/editor-workspace.css`): the card for the label under the
//! pointer, and only that label, even in a `\cref{a,b}` naming several. The
//! one-section-per-label card is Visual mode's, on its chip
//! (`referenceKeysCard`), which the Visual LaTeX island draws with the Tauri
//! app's own code.
//!
//! The card: a figure's image, what the label names and the label, its
//! title (three lines at most), the last build's number, its equation set by
//! KaTeX or else its source snippet (`preview_cards.rs`), the file it is in,
//! then Go to on a hairline, the citation card's actions bar, whose tooltip
//! names the ⌘-click (Ctrl-click off macOS) that goes there directly. A
//! label nothing defines opens no card: its lint card speaks for it.

use std::cell::OnceCell;

use gpui::{
    App, FontWeight, IntoElement, ParentElement as _, RenderOnce, Styled as _, WeakEntity, Window,
    div, prelude::FluentBuilder as _, px, relative,
};
use language::BufferSnapshot;
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _, components::Button};

use super::{
    cards::{around, capitalize, card_surface, reference_kind_label},
    preview_cards::{self, ReferencePreviews},
    syntax,
};
use crate::{
    ProjectIndex,
    hover::{HoverCardContext, HoverProvider, HoverTarget},
    index::Reference,
};

/// A label's card.
#[derive(IntoElement)]
pub struct ReferenceCard {
    pub reference: Reference,
    pub previews: ReferencePreviews,
    pub context: HoverCardContext,
}

/// The label a card resting on `position` shows, with what defines it, and
/// its span the card belongs to; none unless it is defined
/// (`referenceTooltips`).
pub fn card_label(
    text: &str,
    position: usize,
    lookup: impl Fn(&str) -> Option<Reference>,
) -> Option<(std::ops::Range<usize>, Reference)> {
    let target = syntax::reference_target(text, position)?;
    Some((target.range, lookup(&target.key)?))
}

impl ReferenceCard {
    /// What the label names, its previews and Go to (`fillReferenceEntry`).
    fn entry(self, window: &mut Window, cx: &mut App) -> gpui::Div {
        let Self {
            reference,
            previews,
            context,
        } = self;
        let palette = cx.palette().clone();
        let figure = previews
            .figure
            .as_deref()
            .and_then(|path| preview_cards::figure_media(path, &context, cx));
        let equation = previews
            .equation
            .as_ref()
            .map(|(body, macros)| preview_cards::equation(body, macros, &context, window, cx));
        let fact = previews
            .fact
            .map(|fact| preview_cards::compiled_line(fact, cx));
        let editor_font = cx.lattice().fonts.editor.clone();
        let heading = if reference.title.is_empty() {
            reference.label.clone()
        } else {
            reference.title.clone()
        };
        let goto = {
            let context = context.clone();
            let (path, line) = (reference.path.clone(), reference.line);
            move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
                context.close(cx);
                context.open_location(path.clone(), line, cx)
            }
        };
        let modifier = if cfg!(target_os = "macos") {
            "⌘"
        } else {
            "Ctrl"
        };
        div()
            .flex()
            .flex_col()
            .children(figure)
            .child(
                div()
                    .mb(px(5.))
                    .truncate()
                    .text_color(palette.accent)
                    .font_family(editor_font)
                    .text_size(lattice_ui::tokens::TEXT_MICRO)
                    .child(format!(
                        "{} {}",
                        capitalize(reference_kind_label(&reference.kind)),
                        reference.label
                    )),
            )
            .child(
                div()
                    .text_size(lattice_ui::tokens::TEXT_CAPTION)
                    .font_weight(FontWeight(650.))
                    .line_height(relative(1.35))
                    .line_clamp(3)
                    .child(heading),
            )
            .children(fact)
            .map(|section| match equation {
                Some(equation) => section.child(equation),
                None if !reference.snippet.is_empty() => {
                    section.child(preview_cards::source_block(reference.snippet.clone(), cx))
                }
                None => section,
            })
            .child(
                div()
                    .mt(px(6.))
                    .truncate()
                    .text_color(palette.text_secondary)
                    .text_size(lattice_ui::tokens::TEXT_MICRO)
                    .child(reference.path.clone()),
            )
            .child(
                // The citation card's bar, reaching 6px past the text
                // (`.reference-hover-card .citation-card-actions`).
                div()
                    .mt(px(10.))
                    .mx(px(-6.))
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(palette.line)
                    .flex()
                    .flex_wrap()
                    .gap(px(4.))
                    .child(
                        Button::new("reference-card-goto", t!("Go to"))
                            .tinted()
                            .compact()
                            .tooltip(t!(
                                "{modifier}-click the reference to go there directly",
                                modifier = modifier
                            ))
                            .on_click(goto),
                    ),
            )
    }
}

impl RenderOnce for ReferenceCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let width = px(360.).min(self.context.max_width);
        let body = self.entry(window, cx);
        card_surface(cx)
            .w(width)
            .pt(px(10.))
            .px(px(12.))
            .pb(px(11.))
            .text_role(TextRole::Body, cx)
            .child(body)
    }
}

/// The reference card for the label under the pointer.
pub struct ReferenceCards {
    pub index: WeakEntity<ProjectIndex>,
}

impl HoverProvider for ReferenceCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget> {
        let (window, start) = around(text, offset);
        let index = self.index.upgrade()?;
        let index = index.read(cx);
        let (range, reference) = card_label(&window, offset - start, |label| {
            index.reference(label).cloned()
        })?;
        let weak = self.index.clone();
        // The label's equation, worked out once per card from the edited text.
        let body = OnceCell::new();
        Some(HoverTarget {
            range: range.start + start..range.end + start,
            id: "reference",
            card: std::rc::Rc::new(move |context, _, cx| {
                ReferenceCard {
                    previews: ReferencePreviews::read(&reference, &body, &weak, &context.text, cx),
                    reference: reference.clone(),
                    context: context.clone(),
                }
                .into_any_element()
            }),
        })
    }
}

#[cfg(test)]
mod tests;
