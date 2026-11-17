//! The palette's plugin result drawn (`super::plugin` holds the steps), as
//! the Tauri app's `plugin-run.tsx` and `plugins.css`: an item's title,
//! then its subtitle and its detail each on a line of their own, with the
//! row's other actions and its badges at the end; a diagnostic's severity
//! glyph, then its message over "line N · code", under its file's plain
//! header; a message's Markdown in a scrolling block; the quiet line of an
//! empty result; an error with what can fix it; and a bibliography change
//! asked about in the card. The row in front, or under the pointer, shows
//! its other actions as small buttons.

use gpui::{
    AnyElement, Context, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::plugins::{CommandResult, Severity};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Badge, Button},
    fluid_hover::FluidHover,
    scrollbar::FluidScrollbar,
    shape,
    tokens::{FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD},
};

use super::{
    CommandPaletteView,
    plugin::{Outcome, Step},
};
use crate::{
    plugins::{markdown, results::Row, text},
    shell::plugin_actions::BibChange,
};

/// A result's height at most (`.plugin-results-scroll`: min(460px, 60vh)).
const RESULTS_MAX: f32 = 460.;

impl CommandPaletteView {
    /// An inline error, as `InlineMessage level="error"`: the 13px mark in
    /// the danger ink beside the caption in the primary ink.
    fn inline_error(text: String, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .flex()
            .items_start()
            .gap(px(6.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text)
            .child(
                div()
                    .flex_none()
                    .pt(px(2.))
                    .child(Icon::CIRCLE_ALERT.element(px(13.), palette.danger)),
            )
            .child(div().flex_1().min_w_0().child(SharedString::from(text)))
            .into_any_element()
    }

    /// A block of BibTeX or standard error (`.plugin-bib-entry`,
    /// `.plugin-stderr`): the editor's face at the micro size, on the
    /// panel's ground, scrolling past 180px.
    fn code_block(
        id: impl Into<gpui::ElementId>,
        text: String,
        ground: gpui::Hsla,
        ink: gpui::Hsla,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mono = cx.lattice().fonts.editor.clone();
        div()
            .id(id)
            .w_full()
            .max_h(px(180.))
            .overflow_y_scroll()
            .p(px(8.))
            .rounded(px(6.))
            .bg(ground)
            .text_color(ink)
            .text_role(TextRole::Micro, cx)
            .font_family(mono)
            .font_weight(gpui::FontWeight::NORMAL)
            .line_height(px(18.))
            .child(SharedString::from(text))
            .into_any_element()
    }

    pub(super) fn error_view(&self, error: text::ErrorText, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let settings = error.settings.then(|| {
            Button::new("plugin-open-settings", t!("Open Settings"))
                .compact()
                .on_click(cx.listener(|this, _, window, cx| this.open_plugin_settings(window, cx)))
        });
        let stderr = error.stderr.map(|stderr| {
            Self::code_block(
                "plugin-stderr",
                stderr,
                palette.panel,
                palette.text_secondary,
                cx,
            )
        });
        div()
            .id("plugin-error")
            .flex()
            .flex_col()
            .items_start()
            .gap(px(8.))
            .px(px(16.))
            .py(px(12.))
            .child(Self::inline_error(error.text, cx))
            .children(stderr)
            .children(settings)
            .into_any_element()
    }

    pub(super) fn quiet(&self, words: &'static str, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        div()
            .px(px(16.))
            .py(px(20.))
            .flex()
            .justify_center()
            .text_role(TextRole::Body, cx)
            .text_color(palette.text_secondary)
            .child(words)
            .into_any_element()
    }

    /// A bibliography change asked about (`ConfirmView`): the question, the
    /// entry (or the entry now over the plugin's), what went wrong, then
    /// Cancel and the answer.
    pub(super) fn confirm_view(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let palette = cx.palette().clone();
        let Some(Step::Done {
            confirm: Some(confirm),
            ..
        }) = &self.plugin
        else {
            return div().into_any_element();
        };
        let title = confirm.title();
        let busy = confirm.busy;
        let error = confirm.target.error.clone();
        let before = confirm.target.before.clone();
        let (replacing, bibtex) = match &confirm.change {
            BibChange::Add { bibtex } => (false, bibtex.trim().to_string()),
            BibChange::Replace { bibtex, .. } => (true, bibtex.trim().to_string()),
        };
        let unable = confirm.target.file.is_empty() || (replacing && before.is_none());
        let label = |words: String, cx: &mut Context<Self>| {
            div()
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(SharedString::from(words))
        };
        let entries: Option<AnyElement> = match (replacing, before) {
            (true, Some(before)) => Some(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(label(t!("Now").to_string(), cx))
                    .child(Self::code_block(
                        "plugin-bib-now",
                        before,
                        palette.danger_soft,
                        palette.text,
                        cx,
                    ))
                    .child(label(t!("After").to_string(), cx))
                    .child(Self::code_block(
                        "plugin-bib-after",
                        bibtex,
                        palette.success_soft,
                        palette.text,
                        cx,
                    ))
                    .into_any_element(),
            ),
            (false, _) => Some(Self::code_block(
                "plugin-bib-entry",
                bibtex,
                palette.panel,
                palette.text,
                cx,
            )),
            (true, None) => None,
        };
        let answer = Button::new(
            "plugin-bib-answer",
            if replacing {
                t!("Update entry")
            } else {
                t!("Add entry")
            },
        )
        .primary()
        .disabled(busy || unable)
        .on_click(cx.listener(|this, _, window, cx| this.write_bib(window, cx)));
        let cancel = Button::new("plugin-bib-cancel", t!("Cancel"))
            .ghost()
            .disabled(busy)
            .on_click(cx.listener(|this, _, _, cx| this.cancel_bib(cx)));
        div()
            .id("plugin-confirm")
            .flex()
            .flex_col()
            .gap(px(8.))
            .px(px(16.))
            .py(px(12.))
            .child(
                div()
                    .text_role(TextRole::Subtitle, cx)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .text_color(palette.text)
                    .child(SharedString::from(title)),
            )
            .children(entries)
            .children(error.map(|error| Self::inline_error(error, cx)))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(cancel)
                    .child(answer),
            )
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
        let max_h = px(RESULTS_MAX).min(window.viewport_size().height * 0.6);
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
                            .px(px(16.))
                            .py(px(12.))
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
            if let Row::File(file) = row {
                // `.plugin-file-header`: 10px over it (4px over the first),
                // 4px under, the caption in the secondary ink.
                drawn.push(
                    div()
                        .px(px(10.))
                        .pt(px(if at == 0 { 4. } else { 10. }))
                        .pb(px(4.))
                        .text_role(TextRole::Caption, cx)
                        .font_weight(FONT_WEIGHT_MEDIUM)
                        .text_color(palette.text_secondary)
                        .child(SharedString::from(file.clone()))
                        .into_any_element(),
                );
                continue;
            }
            let element = self.result_row(at, row, shown, cx);
            let row_div = div()
                .id(("plugin-result-row", at))
                .rounded(shape::PALETTE_LIST.inner())
                .when(at == selected && !hover.is_lit(at, cx), |row| {
                    row.bg(palette.accent_soft)
                })
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
                    .p(px(6.))
                    .children(drawn),
            )
            .child(FluidScrollbar::vertical(
                "plugin-result-scrollbar",
                &self.result_scroll,
            ))
            .into_any_element()
    }

    /// An item's or a diagnostic's row (`.plugin-row`): 32px at least,
    /// 6px and 10px in, its parts 8px apart; `shown` puts its other
    /// actions on it.
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
            .min_h(px(32.))
            .px(px(10.))
            .py(px(6.));
        // The title over its muted lines, 2px apart (`.plugin-row-text`).
        let column = |title: String, muted: Vec<String>, cx: &mut Context<Self>| {
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_role(TextRole::Body, cx)
                        .text_color(palette.text)
                        .child(SharedString::from(title)),
                )
                .children(
                    muted
                        .into_iter()
                        .filter(|line| !line.is_empty())
                        .map(|line| {
                            div()
                                .truncate()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(SharedString::from(line))
                        }),
                )
        };
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
                let muted = item
                    .subtitle
                    .iter()
                    .chain(item.detail.iter())
                    .cloned()
                    .collect();
                line.child(column(item.title.clone(), muted, cx))
                    .children(buttons)
                    .children(
                        item.badges
                            .iter()
                            .map(|badge| Badge::new(SharedString::from(badge.clone())).compact()),
                    )
                    .into_any_element()
            }
            (Row::Diagnostic(index), CommandResult::Diagnostics { items, .. }) => {
                let diagnostic = &items[*index];
                let (glyph, ink) = match diagnostic.severity {
                    Severity::Error => (Icon::CIRCLE_X, palette.danger),
                    Severity::Warning => (Icon::TRIANGLE_ALERT, palette.warning),
                    Severity::Info => (Icon::INFO, palette.info),
                };
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
                let place = text::place(diagnostic.line, diagnostic.code.as_deref());
                line.child(
                    div()
                        .flex_none()
                        .self_start()
                        .pt(px(3.))
                        .child(glyph.element(px(14.), ink)),
                )
                .child(column(diagnostic.message.clone(), vec![place], cx))
                .children(buttons)
                .into_any_element()
            }
            _ => div().into_any_element(),
        }
    }
}
