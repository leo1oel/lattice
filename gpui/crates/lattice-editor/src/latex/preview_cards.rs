//! The previews a card shows, drawn as the Tauri app draws them
//! (`src/editor/latex/latex-hover-cards.ts`, the `.reference-hover-media`,
//! `.reference-hover-math` and `.reference-hover-number` rules in
//! `src/styles/editor-workspace.css`):
//!
//! - a figure's image above a figure label's card, and alone in the card an
//!   `\includegraphics` path opens ([`GraphicsCards`]): on the editor's
//!   ground, fitted within 190px, a hairline over its edge; the loader while
//!   it is read; a format with no preview, or one that failed, says so;
//! - an equation label's math, set by KaTeX ([`equation`]): the equation
//!   around its `\label` in the edited text, which may not be saved yet,
//!   else the index's snippet of a saved equation; its source until the
//!   picture is in, and when KaTeX cannot set it;
//! - what the last build numbered the label ([`compiled_line`]): "(3), page 4
//!   in the last build".
//!
//! The pictures come from the app's [`previews`] host.

use std::{
    cell::OnceCell,
    path::{Path, PathBuf},
    rc::Rc,
};

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, Pixels,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, Window, div, img,
    prelude::FluentBuilder as _, px, relative,
};
use language::BufferSnapshot;
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, Appearance, TextRole, TextRoleStyle as _};

use super::{
    cards::card_surface,
    graphics,
    previews::{self, Figure, MacroSources, MathRequest, Preview},
    syntax,
};
use crate::{
    ProjectIndex,
    hover::{HoverCardContext, HoverProvider, HoverTarget},
    index::Reference,
};

/// The card's width: 360px, or the editor's room (`.reference-hover-card`).
fn card_width(context: &HoverCardContext) -> Pixels {
    px(360.).min(context.max_width)
}

/// The card's content width, inside its 12px sides.
fn content_width(context: &HoverCardContext) -> Pixels {
    card_width(context) - px(24.)
}

/// A figure's preview (`figurePreview`): `None` without a host, as the
/// Tauri app's card has none without its figure loader.
pub fn figure_media(path: &Path, context: &HoverCardContext, cx: &mut App) -> Option<AnyElement> {
    let preview = previews::figure(path, &context.editor, cx)?;
    let palette = cx.palette().clone();
    // The media reaches 3px past the text on each side (`margin: -2px -3px 9px`).
    let width = content_width(context) + px(6.);
    let media = div()
        .w(width)
        .max_h(px(190.))
        .mt(px(-2.))
        .mx(px(-3.))
        .mb(px(9.))
        .overflow_hidden()
        .rounded(px(6.))
        .bg(palette.editor)
        .text_color(palette.text_secondary)
        .text_size(lattice_ui::tokens::TEXT_MICRO)
        .flex()
        .justify_center()
        .items_center();
    let unavailable = |words: &'static str| div().child(words).into_any_element();
    Some(match preview {
        Preview::Loading => media
            .min_h(px(72.))
            .flex_col()
            .gap(px(4.))
            .child(previews::loader(
                "reference-card-figure-loader",
                px(18.),
                cx,
            ))
            .into_any_element(),
        Preview::Ready(Figure::Shown(source)) => {
            let edge = match palette.appearance {
                Appearance::Dark => gpui::hsla(0., 0., 1., 0.1),
                _ => gpui::hsla(0., 0., 0., 0.1),
            };
            media
                .child(
                    div()
                        .relative()
                        .flex_none()
                        .child(
                            img(source)
                                .max_w(width)
                                .max_h(px(190.))
                                .object_fit(ObjectFit::Contain)
                                .with_fallback(move || {
                                    unavailable(t!("Figure preview could not be loaded."))
                                }),
                        )
                        // `outline: 1px …; outline-offset: -1px`: over the image's edge.
                        .child(div().absolute().inset_0().border_1().border_color(edge)),
                )
                .into_any_element()
        }
        Preview::Ready(Figure::Unavailable) => media
            .child(unavailable(t!(
                "Preview unavailable for this figure format."
            )))
            .into_any_element(),
        Preview::Ready(Figure::Failed) => media
            .child(unavailable(t!("Figure preview could not be loaded.")))
            .into_any_element(),
    })
}

/// A label's source snippet, or an equation's source while KaTeX has not
/// set it (`.reference-hover-card pre`).
pub fn source_block(text: String, cx: &App) -> AnyElement {
    let palette = cx.palette();
    div()
        .mt(px(7.))
        .max_h(px(132.))
        .overflow_hidden()
        .text_color(palette.text_secondary)
        .font_family(cx.lattice().fonts.editor.clone())
        .text_size(lattice_ui::tokens::TEXT_MICRO)
        .line_height(relative(1.45))
        .child(text)
        .into_any_element()
}

/// An equation as KaTeX sets it in the card (`equationPreview`): its source
/// until the picture is in, or when KaTeX cannot set it.
pub fn equation(
    body: &str,
    macros: &MacroSources,
    context: &HoverCardContext,
    window: &Window,
    cx: &mut App,
) -> AnyElement {
    let request = MathRequest {
        tex: body.to_string(),
        display: true,
        size: lattice_ui::tokens::TEXT_BODY.to_pixels(window.rem_size()),
        color: cx.palette().text,
        macros: macros.clone(),
    };
    let picture = match previews::math(&request, &context.editor, cx) {
        Some(Preview::Ready(Some(picture))) => picture,
        _ => return source_block(body.to_string(), cx),
    };
    // `.katex-display` centres the formula in the card; one wider than the
    // card starts at its left edge and scrolls.
    let fits = picture.width <= content_width(context);
    div()
        .id("reference-card-math")
        .mt(px(7.))
        .max_h(px(160.))
        .overflow_scroll()
        .flex()
        .when(fits, |math| math.justify_center())
        .child(
            img(picture.image)
                .flex_none()
                .w(picture.width)
                .h(picture.height),
        )
        .into_any_element()
}

/// "(3), page 4 in the last build" (`.reference-hover-number`).
pub fn compiled_line(fact: String, cx: &App) -> AnyElement {
    div()
        .mt(px(4.))
        .text_color(cx.palette().text_secondary)
        .text_size(lattice_ui::tokens::TEXT_MICRO)
        .child(fact)
        .into_any_element()
}

/// The math around the label's own `\label` in the edited text, which may
/// not be saved yet; else the index's snippet of a saved equation
/// (`equationBody`). Only display math is an equation's.
pub fn equation_body(text: &str, reference: &Reference) -> Option<String> {
    let Some(at) = text.find(&format!("\\label{{{}}}", reference.label)) else {
        return (reference.kind == "equation" && !reference.snippet.is_empty())
            .then(|| reference.snippet.clone());
    };
    syntax::math_region(text, at)
        .filter(|region| region.display)
        .map(|region| region.source)
}

/// What a reference card shows beyond the index's entry, read as it draws.
#[derive(Clone, Default)]
pub struct ReferencePreviews {
    /// The figure's graphic, absolute.
    pub figure: Option<PathBuf>,
    /// What the last build numbered the label.
    pub fact: Option<String>,
    /// The equation's math, and the macros to set it with.
    pub equation: Option<(String, MacroSources)>,
}

impl ReferencePreviews {
    /// `reference`'s previews: `body` is its equation's math, worked out
    /// once per card from the edited text.
    pub fn read(
        reference: &Reference,
        body: &OnceCell<Option<String>>,
        index: &gpui::WeakEntity<ProjectIndex>,
        text: &BufferSnapshot,
        cx: &App,
    ) -> Self {
        let Some(index) = index.upgrade() else {
            return Self::default();
        };
        let index = index.read(cx);
        let body = body.get_or_init(|| equation_body(&text.text(), reference));
        Self {
            figure: reference
                .image_path
                .as_ref()
                .map(|path| index.root().join(path)),
            fact: index
                .compiled_label(&reference.label)
                .and_then(|label| super::compiled_labels::compiled_fact(&reference.kind, label)),
            equation: body
                .clone()
                .map(|body| (body, index.macro_sources().clone())),
        }
    }
}

/// A figure's card for the `\includegraphics` path under the pointer: the
/// figure and its project path (`graphicsTooltips`). A path that names no
/// project file gets no card: the missing-figure diagnostic says so.
pub struct GraphicsCards {
    pub index: gpui::WeakEntity<ProjectIndex>,
}

impl HoverProvider for GraphicsCards {
    fn target(&self, text: &BufferSnapshot, offset: usize, cx: &App) -> Option<HoverTarget> {
        // No previews, no figure card (`graphicsTooltips` takes the loader).
        if !previews::installed(cx) {
            return None;
        }
        let start = text.clip_offset(offset.saturating_sub(800), language::Bias::Right);
        let end = text.clip_offset((offset + 800).min(text.len()), language::Bias::Left);
        let window: String = text.text_for_range(start..end).collect();
        let target = graphics::graphics_target(&window, offset - start)?;
        if target.path.starts_with("http:") || target.path.starts_with("https:") {
            return None;
        }
        let index = self.index.upgrade()?;
        let index = index.read(cx);
        let resolved = graphics::resolve_graphics(
            &target.path,
            index.paths(),
            index.graphics_roots(),
            index.root_document(),
        )?;
        let absolute: Rc<Path> = index.root().join(&resolved).into();
        Some(HoverTarget {
            range: target.range.start + start..target.range.end + start,
            id: "graphics",
            card: Rc::new(move |context, _, cx| {
                let palette = cx.palette().clone();
                card_surface(cx)
                    .w(card_width(context))
                    .pt(px(10.))
                    .px(px(12.))
                    .pb(px(11.))
                    .text_role(TextRole::Body, cx)
                    .children(figure_media(&absolute, context, cx))
                    .child(
                        div()
                            .mt(px(6.))
                            .text_color(palette.text_secondary)
                            .text_size(lattice_ui::tokens::TEXT_MICRO)
                            .truncate()
                            .child(resolved.clone()),
                    )
                    .into_any_element()
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(label: &str, kind: &str, snippet: &str) -> Reference {
        Reference {
            label: label.into(),
            kind: kind.into(),
            snippet: snippet.into(),
            ..Default::default()
        }
    }

    // As `equationBody` (latex-hover-cards.ts) reads it: the display math
    // around the label in the edited text, else the saved snippet of an
    // equation whose label is not in this file.
    #[test]
    fn an_equation_body_is_the_math_around_its_label() {
        let text =
            "\\begin{align}\n  a &= b \\label{eq:ab}\n\\end{align}\nSee $x \\label{eq:inline}$.";
        let ab = reference("eq:ab", "equation", "saved");
        assert_eq!(
            equation_body(text, &ab).as_deref(),
            Some("a &= b \\label{eq:ab}")
        );
        // Inline math is no equation's.
        assert_eq!(
            equation_body(text, &reference("eq:inline", "equation", "s")),
            None
        );
        // Not in this file: the saved snippet of an equation, nothing else.
        assert_eq!(
            equation_body(text, &reference("eq:elsewhere", "equation", "E = mc^2")).as_deref(),
            Some("E = mc^2")
        );
        assert_eq!(
            equation_body(text, &reference("fig:x", "figure", "caption")),
            None
        );
    }
}
