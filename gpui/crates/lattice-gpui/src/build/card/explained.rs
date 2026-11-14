//! An error the build explains, as the card opens it
//! (`.compile-explained`): its row, the failing line with the token
//! underlined, the plain words, and its one-click fix.

use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _, div,
    prelude::*, px,
};
use lattice_core::models::Diagnostic;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::Button,
    elevation::ring,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{Glide, ItemLook, item, severity_icon, strip_tags};
use crate::{
    build::{
        diagnostics::Severity,
        explain::{ExcerptLine, Explained},
    },
    build_panel::BuildPanel,
};

/// How far into a failing line its token may start before the line is cut
/// in front of it.
const EXCERPT_LEAD: usize = 24;

#[allow(clippy::too_many_arguments)]
pub(super) fn explained_row(
    _: &BuildPanel,
    ix: usize,
    diagnostic: &Diagnostic,
    explained: &Explained,
    copy: AnyElement,
    build: &Entity<BuildPanel>,
    glide: Glide<'_>,
    cx: &App,
) -> AnyElement {
    let palette = cx.palette().clone();
    let replace = explained
        .suggestion
        .clone()
        .filter(|_| explained.token.is_some())
        .map(|suggestion| {
            let build = build.clone();
            Button::new(
                ("compile-explained-replace", ix),
                strip_tags(&t!(
                    "Replace with <0>{suggestion}</0>",
                    suggestion = suggestion
                )),
            )
            .compact()
            // ⏎: the fix saves and builds (`CornerDownLeft`).
            .trailing_icon(Icon::CORNER_DOWN_LEFT)
            .on_click(move |_, _, cx| build.update(cx, |build, cx| build.replace(ix, cx)))
        });
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .pb(px(6.))
        .child(item(
            ix,
            diagnostic,
            ItemLook {
                message: explained.headline.clone(),
                weight: FONT_WEIGHT_MEDIUM,
                mark: severity_icon(Severity::Error, cx),
                // TeX's own words stay a hover away (and in the row's Copy).
                tooltip: Some(t!("TeX: {0}", diagnostic.message)),
            },
            build,
            glide,
            cx,
        ))
        .when(!explained.excerpt.is_empty(), |row| {
            row.child(excerpt(&explained.excerpt, cx))
        })
        .child(
            div()
                .px(px(8.))
                .text_role(TextRole::Caption, cx)
                .line_height(px(18.))
                .text_color(palette.text)
                .child(explained.explanation.clone()),
        )
        .child(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(6.))
                .pl(px(8.))
                .children(replace)
                .child(div().flex_1())
                .child(copy),
        )
        .into_any_element()
}

/// The failing line and one either side, numbered, the failing one tinted
/// and its token underlined. The token stays in view however narrow the
/// card: a long line is cut a little before it.
fn excerpt(lines: &[ExcerptLine], cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let font = cx.lattice().fonts.editor.clone();
    let rows = lines.iter().map(|line| {
        let text: AnyElement = match line.token {
            Some((start, end)) => {
                let cut = if start > EXCERPT_LEAD {
                    floor_char(&line.text, start - EXCERPT_LEAD + 4)
                } else {
                    0
                };
                let lead = format!(
                    "{}{}",
                    if cut > 0 { "…" } else { "" },
                    &line.text[cut..start]
                );
                div()
                    .flex()
                    .min_w_0()
                    .overflow_hidden()
                    .child(div().flex_none().child(SharedString::from(lead)))
                    .child(
                        div()
                            .flex_none()
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .text_color(palette.danger)
                            .underline()
                            .text_decoration_wavy()
                            .text_decoration_1()
                            .text_decoration_color(palette.danger)
                            .child(SharedString::from(line.text[start..end].to_string())),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .child(SharedString::from(line.text[end..].to_string())),
                    )
                    .into_any_element()
            }
            None => div()
                .min_w_0()
                .truncate()
                .child(SharedString::from(line.text.clone()))
                .into_any_element(),
        };
        div()
            .flex()
            .pr(px(8.))
            .whitespace_nowrap()
            .when(line.failing, |row| {
                row.bg(palette.danger.opacity(0.07))
                    .border_l_2()
                    .border_color(palette.danger)
                    .text_color(palette.text)
            })
            .child(
                div()
                    .flex_none()
                    .w(px(30.))
                    .pr(px(8.))
                    .text_right()
                    .text_color(palette.text_secondary)
                    .child(line.number.to_string()),
            )
            .child(div().flex_1().min_w_0().child(text))
    });
    div()
        .mx(px(8.))
        .py(px(6.))
        .rounded(px(6.))
        .overflow_hidden()
        .bg(palette.editor)
        .shadow(vec![gpui::BoxShadow {
            inset: true,
            ..ring(palette.line)
        }])
        .font_family(font)
        .text_size(px(11.))
        .line_height(px(20.))
        .text_color(palette.text_secondary)
        .children(rows)
        .into_any_element()
}

/// The char boundary at or before `at`.
fn floor_char(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}
