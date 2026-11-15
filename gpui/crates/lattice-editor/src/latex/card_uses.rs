//! The citation card's "Cited N× here" (`citation-card-uses.ts` and the
//! `.citation-card-uses*` rules in `editor-workspace.css`): one row per
//! occurrence of the key, its section over why it cites the paper (the role
//! chip and the reason's note), the line on the right and the page its note
//! names beside it, each row a jump to that occurrence. The occurrence the
//! card is for carries a quiet bar; a long list scrolls inside the card
//! (176px at most) under Lattice's overlay scrollbar.

use std::{ops::Range, rc::Rc};

use gpui::{
    AnyElement, App, ElementId, Hsla, InteractiveElement as _, IntoElement, ParentElement as _,
    ScrollHandle, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Palette, TextRole, TextRoleStyle as _, scrollbar::FluidScrollbar,
};

use super::citation_library::{CitationLibrary, CitationUse};
use crate::hover::HoverCardContext;

/// A tip naming what a control does (`title`).
pub(super) fn tip(
    text: impl Into<gpui::SharedString>,
) -> impl Fn(&mut Window, &mut App) -> gpui::AnyView + 'static {
    let text = text.into();
    move |_, cx| lattice_ui::components::LatticeTooltip::view(text.clone(), None, cx)
}

/// The tallest the list grows before it scrolls.
const LIST_MAX_HEIGHT: f32 = 176.;

/// The file's name, without its folders (`baseName`).
fn base_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A role chip's wash and ink: supporting in the success tint,
/// counterexample in the warning tint, any other in the hover wash.
pub fn role_colors(role: &str, palette: &Palette) -> (Hsla, Hsla) {
    match role {
        "supporting" => (palette.success_soft, palette.success),
        "counterexample" => (palette.warning_soft, palette.warning),
        _ => (palette.hover, palette.text),
    }
}

/// What the row's top line says on its right: "Line 12" in this file,
/// "intro.tex:12" in another.
pub fn place_label(at: &CitationUse, current: &str) -> String {
    if at.path == current {
        t!("Line {line}", line = at.line)
    } else {
        format!("{}:{}", base_name(&at.path), at.line)
    }
}

/// The section, or the file's name when the use sits in no section.
pub fn where_label(at: &CitationUse) -> String {
    at.section
        .clone()
        .unwrap_or_else(|| base_name(&at.path).to_string())
}

/// The section; `None` when the key has no uses to show.
#[allow(clippy::too_many_arguments)]
pub(super) fn uses_section(
    key: &str,
    uses: Vec<CitationUse>,
    hovered: Range<usize>,
    library: &Rc<dyn CitationLibrary>,
    can_open: bool,
    context: &HoverCardContext,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    if uses.is_empty() {
        return None;
    }
    let palette = cx.palette().clone();
    let current = library.path();
    let scroll = window
        .use_keyed_state(
            ElementId::Name(format!("citation-card-uses-{key}").into()),
            cx,
            |_, _| ScrollHandle::new(),
        )
        .read(cx)
        .clone();
    let times = uses.len();
    let rows = uses.into_iter().enumerate().map(|(at, item)| {
        let here = item.path == current && item.range.as_ref() == Some(&hovered);
        let place = place_label(&item, &current);
        let jump = {
            let (library, context, item) = (library.clone(), context.clone(), item.clone());
            move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
                context.close(cx);
                library.jump(&item, window, cx);
            }
        };
        let page = item.page.map(|page| {
            let chip = div()
                .id(("citation-card-use-page", at))
                .flex_none()
                .mt(px(4.))
                .px(px(6.))
                .rounded(px(4.))
                .border_1()
                .border_color(palette.line)
                .text_color(palette.text_secondary)
                .text_role(TextRole::Micro, cx)
                .child(t!("p. {page}", page = page));
            if can_open {
                let (library, context, key) = (library.clone(), context.clone(), key.to_string());
                chip.cursor_pointer()
                    .hover(|style| style.bg(palette.hover).text_color(palette.text))
                    .tooltip(tip(t!("Open paper at page {page}", page = page)))
                    .on_click(move |_, window, cx| {
                        context.close(cx);
                        library.open_paper(&key, Some(page), window, cx);
                    })
                    .into_any_element()
            } else {
                chip.into_any_element()
            }
        });
        let title = match &item.section {
            Some(section) => format!("{section} · {place}"),
            None => place.clone(),
        };
        let why = item.reason.clone().map(|(role, label, note)| {
            let (wash, ink) = role_colors(&role, &palette);
            div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .min_w_0()
                .child(
                    div()
                        .flex_none()
                        .px(px(6.))
                        .rounded(px(4.))
                        .bg(wash)
                        .text_color(ink)
                        .text_role(TextRole::Micro, cx)
                        .whitespace_nowrap()
                        .child(label),
                )
                .when(!note.is_empty(), |why| {
                    why.child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_color(palette.text_secondary)
                            .text_role(TextRole::Caption, cx)
                            .child(note),
                    )
                })
        });
        div()
            .flex()
            .items_start()
            .gap(px(4.))
            .min_w_0()
            .child(
                div()
                    .id(("citation-card-use", at))
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .px(px(6.))
                    .py(px(4.))
                    .rounded(px(4.))
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .cursor_pointer()
                    .hover(|style| style.bg(palette.hover))
                    .tooltip(tip(title))
                    .on_click(jump)
                    .when(here, |row| {
                        row.child(
                            div()
                                .absolute()
                                .top(px(4.))
                                .bottom(px(4.))
                                .left_0()
                                .w(px(2.))
                                .rounded(px(1.))
                                .bg(palette.accent),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .items_baseline()
                            .gap(px(6.))
                            .min_w_0()
                            .text_role(TextRole::Caption, cx)
                            .child(div().min_w_0().truncate().child(where_label(&item)))
                            .child(
                                div()
                                    .flex_none()
                                    .ml_auto()
                                    .text_color(palette.text_secondary)
                                    .text_role(TextRole::Micro, cx)
                                    .child(place),
                            ),
                    )
                    .children(why),
            )
            .children(page)
    });
    Some(
        div()
            .mt(px(10.))
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(
                div()
                    .text_color(palette.text_secondary)
                    .text_role(TextRole::Micro, cx)
                    .child(t!("Cited {times}× here", times = times)),
            )
            .child(
                div()
                    .relative()
                    .mx(px(-6.))
                    .child(
                        div()
                            .id(ElementId::Name(
                                format!("citation-card-uses-list-{key}").into(),
                            ))
                            .max_h(px(LIST_MAX_HEIGHT))
                            .overflow_y_scroll()
                            .track_scroll(&scroll)
                            .flex()
                            .flex_col()
                            .children(rows),
                    )
                    .child(FluidScrollbar::vertical(
                        ElementId::Name(format!("citation-card-uses-bar-{key}").into()),
                        &scroll,
                    )),
            )
            .into_any_element(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(path: &str, line: u32, section: Option<&str>) -> CitationUse {
        CitationUse {
            path: path.into(),
            line,
            range: None,
            section: section.map(Into::into),
            page: None,
            reason: None,
        }
    }

    /// `citation-card-uses.ts`: this file's rows say "Line N", another
    /// file's "name.tex:N", and a use outside any section names its file.
    #[test]
    fn rows_say_where_they_are_as_the_tauri_card_does() {
        let here = at("chapters/intro.tex", 12, Some("Introduction"));
        let there = at("chapters/method.tex", 40, None);
        assert_eq!(place_label(&here, "chapters/intro.tex"), "Line 12");
        assert_eq!(place_label(&there, "chapters/intro.tex"), "method.tex:40");
        assert_eq!(where_label(&here), "Introduction");
        assert_eq!(where_label(&there), "method.tex");
    }
}
