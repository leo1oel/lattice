//! The reference card, drawn as the Tauri app draws it
//! (`fillReferenceEntry`, `referenceKeysCard` and `referenceTooltips` in
//! `src/editor/latex/latex-hover-cards.ts`; the `.reference-hover-card`,
//! `.hover-card-sections` and `.hover-card-unresolved` rules in
//! `src/styles/editor-workspace.css`).
//!
//! A label's section: a figure's image, what the label names and the label,
//! its title (three lines at most), the last build's number, its equation set
//! by KaTeX or else its source snippet (`preview_cards.rs`), the file it is
//! in, then Go to on a hairline, the citation card's actions bar, whose
//! tooltip names the ⌘-click (Ctrl-click off macOS) that goes there directly.
//!
//! A command naming several labels (`\cref{a,b}`, `\Cref`) gets one card, a
//! section per label in the order written, each on a hairline below the
//! last; a label nothing defines says so in the warning tone, with no Go to.
//! The Tauri app shows those sections on Visual mode's chip, which covers
//! the whole command, while its source editor's card shows the label under
//! the pointer alone. The GPUI app draws no chips in its source editor, so
//! its card for a label of a multi-label command shows the command's
//! sections there. As the Tauri source card does, it opens only when the
//! label under the pointer is defined: an unknown one has its lint card.

use std::cell::OnceCell;

use gpui::{
    App, FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce,
    Styled as _, WeakEntity, Window, div, prelude::FluentBuilder as _, px, relative,
};
use language::BufferSnapshot;
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::Button};

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

/// One label's part of the card: what it names and its previews, or none
/// when nothing in the project defines it.
#[derive(Clone)]
pub struct ReferenceSection {
    pub label: String,
    pub entry: Option<(Reference, ReferencePreviews)>,
}

/// A reference command's card: one section per label, in the order written.
#[derive(IntoElement)]
pub struct ReferenceCard {
    pub sections: Vec<ReferenceSection>,
    pub context: HoverCardContext,
}

/// A label as written, and what defines it.
pub type CardLabel = (String, Option<Reference>);

/// The labels a card resting on `position` shows, each with what defines
/// it, and the label's span the card belongs to; none unless the label
/// under `position` is defined (`referenceTooltips`).
pub fn card_labels(
    text: &str,
    position: usize,
    lookup: impl Fn(&str) -> Option<Reference>,
) -> Option<(std::ops::Range<usize>, Vec<CardLabel>)> {
    let (hovered, keys) = syntax::reference_command_target(text, position)?;
    lookup(&hovered.key)?;
    let labels = keys
        .into_iter()
        .map(|key| {
            let reference = lookup(&key.key);
            (key.key, reference)
        })
        .collect();
    Some((hovered.range, labels))
}

impl ReferenceCard {
    /// A defined label's section (`fillReferenceEntry`).
    fn entry(
        &self,
        reference: Reference,
        previews: ReferencePreviews,
        window: &mut Window,
        cx: &mut App,
    ) -> gpui::Div {
        let palette = cx.palette().clone();
        let figure = previews
            .figure
            .as_deref()
            .and_then(|path| preview_cards::figure_media(path, &self.context, cx));
        let equation = previews
            .equation
            .as_ref()
            .map(|(body, macros)| preview_cards::equation(body, macros, &self.context, window, cx));
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
            let context = self.context.clone();
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

    /// A label nothing defines: the label as written and why there is
    /// nothing to show (`unresolvedEntry`).
    fn unresolved(label: String, cx: &App) -> gpui::Div {
        let palette = cx.palette();
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .self_start()
                    .max_w_full()
                    .mb(px(4.))
                    .px(px(6.))
                    .py(px(1.))
                    .rounded(px(4.))
                    .bg(palette.hover)
                    .text_color(palette.text)
                    .font_family(cx.lattice().fonts.editor.clone())
                    .text_size(lattice_ui::tokens::TEXT_MICRO)
                    .line_height(lattice_ui::tokens::LEADING_MICRO)
                    .truncate()
                    .child(label),
            )
            .child(
                div()
                    .mt(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.warning)
                    .child(Icon::TRIANGLE_ALERT.element(px(12.), palette.warning))
                    .child(t!("No \\label with this name in the project.")),
            )
    }
}

impl RenderOnce for ReferenceCard {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let palette = cx.palette().clone();
        let several = self.sections.len() > 1;
        let sections: Vec<gpui::AnyElement> = self
            .sections
            .clone()
            .into_iter()
            .enumerate()
            .map(|(at, section)| {
                let body = match section.entry {
                    Some((reference, previews)) => self.entry(reference, previews, window, cx),
                    None => Self::unresolved(section.label, cx),
                };
                // Each section names its own elements: two figures' loaders,
                // two equations' scrollers.
                body.id(("reference-card-section", at))
                    .when(several && at > 0, |body| {
                        body.mt(px(8.))
                            .pt(px(10.))
                            .border_t_1()
                            .border_color(palette.line)
                    })
                    .into_any_element()
            })
            .collect();
        card_surface(cx)
            .w(px(360.).min(self.context.max_width))
            .pt(px(10.))
            .px(px(12.))
            .pb(px(11.))
            .text_role(TextRole::Body, cx)
            .children(sections)
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
        let (range, labels) = card_labels(&window, offset - start, |label| {
            index.reference(label).cloned()
        })?;
        let weak = self.index.clone();
        // Each label's equation, worked out once per card from the edited text.
        let bodies: Vec<OnceCell<Option<String>>> =
            labels.iter().map(|_| OnceCell::new()).collect();
        Some(HoverTarget {
            range: range.start + start..range.end + start,
            id: "reference",
            card: std::rc::Rc::new(move |context, _, cx| {
                let sections = labels
                    .iter()
                    .zip(&bodies)
                    .map(|((label, reference), body)| ReferenceSection {
                        label: label.clone(),
                        entry: reference.as_ref().map(|reference| {
                            let previews =
                                ReferencePreviews::read(reference, body, &weak, &context.text, cx);
                            (reference.clone(), previews)
                        }),
                    })
                    .collect();
                ReferenceCard {
                    sections,
                    context: context.clone(),
                }
                .into_any_element()
            }),
        })
    }
}

#[cfg(test)]
mod tests;
