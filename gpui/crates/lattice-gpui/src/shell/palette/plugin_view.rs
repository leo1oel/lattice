//! The palette's plugin result as rows (`super::plugin` holds the steps):
//! an item's title, muted subtitle and detail with its badges at the end;
//! a diagnostic's severity glyph, message, line and rule under its file's
//! header; a message's Markdown in a scrolling block; the quiet line of an
//! empty result; and an error with what can fix it. The row in front, or
//! under the pointer, shows its other actions as small buttons.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::plugins::{CommandResult, Severity};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, GlyphKind, Icon, TextRole, TextRoleStyle as _,
    components::{Badge, Button},
    fluid_hover::FluidHover,
    icons::{ICON, file_glyph},
    scrollbar::FluidScrollbar,
    shape,
    tokens::FONT_WEIGHT_MEDIUM,
};

use super::{
    CommandPaletteView,
    plugin::{Outcome, Step},
};
use crate::plugins::{
    markdown,
    results::Row,
    text::{self, ErrorText},
};

impl CommandPaletteView {
    pub(super) fn error_view(&self, error: ErrorText, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let settings = error.settings.then(|| {
            Button::new("plugin-open-settings", t!("Open Settings"))
                .compact()
                .on_click(cx.listener(|this, _, window, cx| this.open_plugin_settings(window, cx)))
        });
        div()
            .id("plugin-error")
            .flex()
            .gap(px(8.))
            .px(px(20.))
            .pt(px(8.))
            .pb(px(16.))
            .child(
                div()
                    .pt(px(2.))
                    .child(Icon::CIRCLE_ALERT.element(ICON, palette.danger)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_role(TextRole::Body, cx)
                            .text_color(palette.text)
                            .child(SharedString::from(error.text)),
                    )
                    .children(settings.map(|button| div().pt(px(2.)).child(button))),
            )
            .into_any_element()
    }

    pub(super) fn quiet(&self, words: &'static str, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .px(px(20.))
            .pt(px(8.))
            .pb(px(20.))
            .text_role(TextRole::Body, cx)
            .text_color(palette.text_secondary)
            .child(words)
            .into_any_element()
    }

    pub(super) fn result_view(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(Step::Done {
            outcome:
                Outcome::Result {
                    result,
                    rows,
                    selected,
                    blocks,
                },
            ..
        }) = &self.plugin
        else {
            return div().into_any_element();
        };
        let max_h = px(super::LIST_HEIGHT).min(window.viewport_size().height * 0.6);
        match result {
            CommandResult::Message { .. } => {
                return div()
                    .relative()
                    .child(
                        div()
                            .id("plugin-message")
                            .max_h(max_h)
                            .overflow_y_scroll()
                            .track_scroll(&self.result_scroll)
                            .px(px(20.))
                            .pt(px(6.))
                            .pb(px(16.))
                            .child(markdown::render("plugin-message", blocks, cx)),
                    )
                    .child(FluidScrollbar::vertical(
                        "plugin-message-scrollbar",
                        &self.result_scroll,
                    ))
                    .into_any_element();
            }
            CommandResult::Items { items, .. } if items.is_empty() => {
                return self.quiet(t!("Nothing found"), cx);
            }
            CommandResult::Diagnostics { items, .. } if items.is_empty() => {
                return self.quiet(t!("No problems found"), cx);
            }
            _ => {}
        }
        let (rows, selected) = (rows.clone(), *selected);
        let hover = FluidHover::new("plugin-result-hover", window, cx)
            .fill(palette.accent_soft)
            .radius(shape::PALETTE_LIST.inner());
        let lit = hover.lit(cx);
        if lit != self.adopted_result
            && let Some(lit) = lit.filter(|lit| rows.get(*lit).is_some_and(Row::acts))
            && let Some(Step::Done {
                outcome: Outcome::Result { selected, .. },
                ..
            }) = &mut self.plugin
        {
            *selected = lit;
        }
        let selected = self.selected_row().unwrap_or(selected);
        let hover = hover.follow(Some(selected), cx);
        self.adopted_result = hover.lit(cx);
        let mut drawn: Vec<AnyElement> = Vec::new();
        for (at, row) in rows.iter().enumerate() {
            let shown = at == selected || hover.is_lit(at, cx);
            let element = match row {
                Row::File(file) => {
                    drawn.push(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .px(px(10.))
                            .pt(px(if at == 0 { 4. } else { 10. }))
                            .pb(px(4.))
                            .child(file_glyph(GlyphKind::for_name(file), ICON, &palette))
                            .child(
                                div()
                                    .truncate()
                                    .text_role(TextRole::Caption, cx)
                                    .font_weight(FONT_WEIGHT_MEDIUM)
                                    .text_color(palette.text_secondary)
                                    .child(SharedString::from(file.clone())),
                            )
                            .into_any_element(),
                    );
                    continue;
                }
                Row::Item(_) | Row::Diagnostic(_) => self.result_row(at, row, shown, cx),
            };
            let row_div = div()
                .id(("plugin-result-row", at))
                .rounded(shape::PALETTE_LIST.inner())
                .when(at == selected && !hover.is_lit(at, cx), |row| {
                    row.bg(palette.accent_soft)
                })
                .cursor_pointer()
                .on_click(
                    cx.listener(move |this, _, window, cx| this.plugin_act(at, None, window, cx)),
                )
                .child(element);
            drawn.push(hover.item(at, row_div));
        }
        div()
            .relative()
            .child(hover.highlight())
            .child(
                div()
                    .id("plugin-result-list")
                    .max_h(max_h)
                    .overflow_y_scroll()
                    .track_scroll(&self.result_scroll)
                    .p(shape::PALETTE_LIST.inset)
                    .pt(px(0.))
                    .children(drawn),
            )
            .child(FluidScrollbar::vertical(
                "plugin-result-scrollbar",
                &self.result_scroll,
            ))
            .into_any_element()
    }

    /// An item's or a diagnostic's row; `shown` puts its other actions on it.
    pub(super) fn result_row(
        &self,
        at: usize,
        row: &Row,
        shown: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(Step::Done {
            outcome: Outcome::Result { result, .. },
            ..
        }) = &self.plugin
        else {
            return div().into_any_element();
        };
        let button = |index: usize, label: String, cx: &mut Context<Self>| {
            Button::new(
                SharedString::from(format!("plugin-action-{at}-{index}")),
                label,
            )
            .compact()
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.plugin_act(at, Some(index), window, cx)
            }))
            .into_any_element()
        };
        let line = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .min_h(px(28.))
            .px(px(10.))
            .py(px(6.));
        match (row, result) {
            (Row::Item(index), CommandResult::Items { items, .. }) => {
                let item = &items[*index];
                let buttons: Vec<AnyElement> = if shown {
                    item.actions
                        .iter()
                        .enumerate()
                        .skip(1)
                        .map(|(index, action)| button(index, text::action_label(action), cx))
                        .collect()
                } else {
                    Vec::new()
                };
                line.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .gap(px(8.))
                                .min_w_0()
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_role(TextRole::Body, cx)
                                        .text_color(palette.text)
                                        .child(SharedString::from(item.title.clone())),
                                )
                                .children(item.subtitle.clone().map(|subtitle| {
                                    div()
                                        .flex_shrink_1()
                                        .min_w_0()
                                        .truncate()
                                        .text_role(TextRole::Caption, cx)
                                        .text_color(palette.text_secondary)
                                        .child(SharedString::from(subtitle))
                                })),
                        )
                        .children(item.detail.clone().map(|detail| {
                            div()
                                .truncate()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(SharedString::from(detail))
                        })),
                )
                .children(
                    item.badges
                        .iter()
                        .map(|badge| Badge::new(SharedString::from(badge.clone())).compact()),
                )
                .children(buttons)
                .into_any_element()
            }
            (Row::Diagnostic(index), CommandResult::Diagnostics { items, .. }) => {
                let diagnostic = &items[*index];
                let (glyph, ink) = match diagnostic.severity {
                    Severity::Error => (Icon::CIRCLE_X, palette.danger),
                    Severity::Warning => (Icon::TRIANGLE_ALERT, palette.warning),
                    Severity::Info => (Icon::INFO, palette.info),
                };
                let place: Vec<String> = diagnostic
                    .line
                    .map(text::line)
                    .into_iter()
                    .chain(diagnostic.code.clone())
                    .collect();
                let buttons: Vec<AnyElement> = if shown {
                    diagnostic
                        .fixes
                        .iter()
                        .enumerate()
                        .map(|(index, fix)| button(index, text::action_label(fix), cx))
                        .collect()
                } else {
                    Vec::new()
                };
                line.child(glyph.element(ICON, ink))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .items_baseline()
                            .gap(px(8.))
                            .child(
                                div()
                                    .min_w_0()
                                    .truncate()
                                    .text_role(TextRole::Body, cx)
                                    .text_color(palette.text)
                                    .child(SharedString::from(diagnostic.message.clone())),
                            )
                            .when(!place.is_empty(), |this| {
                                this.child(
                                    div()
                                        .flex_none()
                                        .text_role(TextRole::Caption, cx)
                                        .text_color(palette.text_secondary)
                                        .child(SharedString::from(place.join(" · "))),
                                )
                            }),
                    )
                    .children(buttons)
                    .into_any_element()
            }
            _ => div().into_any_element(),
        }
    }
}
