//! The file [`CompareView`] has open: its changed passages as prose, with
//! the counts before the text, each passage headed by its section and line
//! and ‹ 1 of n › stepping between them; or its source diff.

use gpui::{
    AnyElement, Context, IntoElement, ParentElement as _, SharedString, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_i18n::{format_count, join_phrases, t, tc};
use lattice_ui::{
    ActiveLattice as _, Icon, Motion, TextRole, TextRoleStyle as _,
    interaction::fade,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, RADIUS_PILL},
    typography::tabular_nums,
};

use crate::history::{
    diff_view::{FileChange, LoadedDiff, history_diff},
    inline_edits::passage_text,
    widgets::Control,
};

use super::{CompareView, ComparedFile};

impl CompareView {
    pub(super) fn render_file(
        &self,
        path: &str,
        file: &ComparedFile,
        now: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let passages = file.passages.as_ref().filter(|_| self.prose);
        let Some(passages) = passages else {
            return match &file.loaded {
                Some(loaded) => history_diff(
                    format!("compare-diff-{path}"),
                    loaded,
                    false,
                    None,
                    None,
                    window,
                    cx,
                ),
                None => {
                    let loaded = LoadedDiff::new(
                        FileChange {
                            path: path.into(),
                            before: None,
                            after: None,
                        },
                        cx,
                    );
                    history_diff(
                        format!("compare-diff-{path}"),
                        &loaded,
                        true,
                        None,
                        None,
                        window,
                        cx,
                    )
                }
            };
        };
        let total = passages.len();
        let current = self.stepped.min(total.saturating_sub(1));
        let paragraphs = format_count(total as i64);
        let counts = file.counts.map(|(added, removed)| {
            div()
                .flex()
                .items_baseline()
                .gap(px(6.))
                .whitespace_nowrap()
                .child(
                    div()
                        .text_color(palette.success)
                        .font_weight(FONT_WEIGHT_SEMIBOLD)
                        .child(format!("+{}", format_count(added as i64))),
                )
                .child(
                    div()
                        .text_color(palette.danger)
                        .font_weight(FONT_WEIGHT_SEMIBOLD)
                        .child(format!("−{}", format_count(removed as i64))),
                )
                .child(tc!("changed words count", "words"))
        });
        let step_pill = (total > 1).then(|| {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(4.))
                .h(px(28.))
                .ml_auto()
                .px(px(2.))
                .rounded(RADIUS_PILL)
                .border_1()
                .border_color(palette.line)
                .text_color(palette.text)
                .whitespace_nowrap()
                .child(
                    Control::step(
                        "compare-step-up",
                        Icon::CHEVRON_UP,
                        t!("Previous change"),
                        true,
                    )
                    .disabled(current == 0)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.stepped = current.saturating_sub(1);
                        cx.notify();
                    })),
                )
                .child(lattice_i18n::fill_named(
                    &lattice_i18n::fill(
                        t!("{0} of {paragraphs}"),
                        &[&format_count(current as i64 + 1)],
                    ),
                    &[("paragraphs", &paragraphs)],
                ))
                .child(
                    Control::step(
                        "compare-step-down",
                        Icon::CHEVRON_DOWN,
                        t!("Next change"),
                        true,
                    )
                    .disabled(current + 1 >= total)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.stepped = (current + 1).min(total - 1);
                        cx.notify();
                    })),
                )
        });
        let summary = div()
            .relative()
            .children(lattice_ui::parity::probe("compare/counts"))
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap_x(px(12.))
            .gap_y(px(8.))
            .min_w_0()
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .font_features(tabular_nums())
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_wrap()
                    .items_baseline()
                    .gap_x(px(12.))
                    .child(div().min_w_0().child(path.to_string()))
                    .child(if total == 1 {
                        t!("1 changed paragraph").to_string()
                    } else {
                        t!("{paragraphs} changed paragraphs", paragraphs = &paragraphs)
                    })
                    .children(counts),
            )
            .children(step_pill);
        let items = passages
            .iter()
            .enumerate()
            .map(|(index, passage)| {
                let section = file.sections.get(index).cloned().flatten();
                let line = t!("Line {0}", passage.line);
                let label = join_phrases(
                    &section
                        .into_iter()
                        .chain(std::iter::once(line))
                        .collect::<Vec<_>>(),
                );
                let is_current = total > 1 && index == current;
                let heading: AnyElement = if now {
                    let (path, line) = (path.to_string(), passage.line);
                    Control::link(
                        SharedString::from(format!("compare-passage-link-{index}")),
                        label,
                    )
                    .tooltip(lattice_i18n::fill_named(
                        &lattice_i18n::fill(t!("Open {path} at line {0}"), &[&line]),
                        &[("path", &path)],
                    ))
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.open_line(path.clone(), line, cx)),
                    )
                    .into_any_element()
                } else {
                    div().child(label).into_any_element()
                };
                let border = fade(
                    SharedString::from(format!("compare-passage-current-{index}")),
                    is_current,
                    Motion::Fast,
                    window,
                    cx,
                );
                div()
                    .relative()
                    .when(index == 0, |this| {
                        this.children(lattice_ui::parity::probe("compare/passage"))
                    })
                    .min_w_0()
                    .pl(px(16.))
                    .border_l(px(3.))
                    .border_color(lattice_ui::interaction::mix(
                        palette.line,
                        palette.text,
                        border,
                    ))
                    .child(
                        div()
                            .mb(px(4.))
                            .text_role(TextRole::Micro, cx)
                            .font_weight(FONT_WEIGHT_MEDIUM)
                            .text_color(palette.text_secondary)
                            .child(heading),
                    )
                    .child(passage_text(passage, cx))
                    .into_any_element()
            })
            .collect::<Vec<_>>();
        let empty = (total == 0).then(|| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(t!("No textual changes"))
        });
        div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .min_w_0()
            .child(summary)
            .children(empty)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(20.))
                    .min_w_0()
                    .children(items),
            )
            .into_any_element()
    }
}
