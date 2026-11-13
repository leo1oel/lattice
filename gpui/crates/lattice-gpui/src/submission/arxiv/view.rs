//! How the arXiv export sheet is drawn (`.arxiv-export-*` and
//! `.arxiv-check-*` in the Tauri app's `dialogs.css`): the title, a blocked
//! state's message and its one action, what will be sent and its files,
//! what was left out, the checks in one ringed list, the two switches, and
//! the status beside Cancel and Export ZIP.

use gpui::{
    AnimationExt as _, AnyElement, App, Context, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, StatefulInteractiveElement as _, Styled as _, Transformation,
    Window, div, percentage, prelude::FluentBuilder as _, px,
};
use lattice_core::latex::{ArxivCheck, ArxivOptions, ArxivPackage};
use lattice_i18n::{t, tc};
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, LayerPlacement, ModalLayer, Switch},
    interaction::use_interaction,
    scrollbar::FluidScrollbar,
    shape::{CHROME, RADIUS_SURFACE},
    tokens::{
        FONT_WEIGHT_MEDIUM, FONT_WEIGHT_SEMIBOLD, RADIUS_CONTROL, RADIUS_DIALOG, RADIUS_PILL,
    },
    typography::tabular_nums,
};

use super::{
    ArxivExportSheet, Phase,
    rows::{
        CheckId, CheckRow, CheckState, archive_name, check_rows, left_out_line, pending_rows,
        status_line, summary_line,
    },
};
use crate::submission::format_size;

/// A spinning loader, as `.spin` turns Lucide's.
fn spinner(id: &'static str, size: f32, color: gpui::Hsla) -> AnyElement {
    Icon::LOADER
        .element(px(size), color)
        .with_animation(
            id,
            gpui::Animation::new(std::time::Duration::from_secs(1)).repeat(),
            |mark, t| mark.with_transformation(Transformation::rotate(percentage(t))),
        )
        .into_any_element()
}

impl Render for ArxivExportSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = px(520.).min(viewport.width - px(40.));
        let running = self.running();
        let pack = self.pack().cloned();
        let rows = pack.as_ref().map(check_rows).unwrap_or_else(pending_rows);
        let failures = rows
            .iter()
            .filter(|row| row.state == CheckState::Fail)
            .count();
        let file_name = archive_name(&self.project_name);
        let root_document = self
            .current_check()
            .map(|check| match check {
                ArxivCheck::Unbuilt { root_document } => root_document.clone(),
                ArxivCheck::Package(pack) => pack.root_document.clone(),
            })
            .unwrap_or_else(|| "main.tex".into());
        let unbuilt = matches!(self.current_check(), Some(ArxivCheck::Unbuilt { .. }));
        let mut body: Vec<AnyElement> = vec![
            div()
                .text_role(TextRole::Title, cx)
                .text_color(palette.text)
                .child(t!("Export for arXiv"))
                .into_any_element(),
        ];
        if let Phase::Error(message) = &self.phase {
            body.push(blocked(
                crate::history::inline_message(message.clone(), true, cx),
                Button::new("arxiv-check-again", t!("Check again"))
                    .compact()
                    .on_click(cx.listener(|this, _, _, cx| this.recheck(cx)))
                    .into_any_element(),
            ));
        }
        if unbuilt {
            body.push(blocked(
                crate::history::inline_message(t!("Build the paper first"), false, cx),
                Button::new(
                    "arxiv-build-first",
                    if self.building {
                        t!("Building…")
                    } else {
                        t!("Build")
                    },
                )
                .compact()
                .disabled(self.building || running)
                .on_click(cx.listener(|this, _, window, cx| this.build_first(window, cx)))
                .into_any_element(),
            ));
        }
        if pack.is_some() || (running && self.current_check().is_none()) {
            body.push(self.render_summary(pack.as_ref(), &file_name, window, cx));
            if let Some(pack) = pack.as_ref().filter(|_| self.files_open) {
                body.push(files_list(pack, cx));
            }
            if let Some(pack) = pack.as_ref().filter(|pack| !pack.left_out.is_empty()) {
                body.push(
                    div()
                        .mt(px(-4.))
                        .text_role(TextRole::Micro, cx)
                        .text_color(palette.text_secondary)
                        .child(left_out_line(&pack.left_out))
                        .into_any_element(),
                );
            }
            body.push(self.render_checks(&rows, pack.as_ref(), cx));
            body.push(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(self.switch_field(
                        "arxiv-strip-comments",
                        t!("Remove % comments").to_string(),
                        self.options.strip_comments,
                        |options, on| options.strip_comments = on,
                        cx,
                    ))
                    .child(self.switch_field(
                        "arxiv-merge-inputs",
                        t!(
                            "Merge \\input files into {rootDocument}",
                            rootDocument = root_document
                        ),
                        self.options.merge_inputs,
                        |options, on| options.merge_inputs = on,
                        cx,
                    ))
                    .into_any_element(),
            );
        }
        let status = status_line(running, pack.is_some(), &rows);
        let actions = div()
            .mt(px(8.))
            .flex()
            .flex_wrap()
            .items_center()
            .justify_end()
            .gap(px(8.))
            .child(
                div()
                    .mr_auto()
                    .min_w_0()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .children(lattice_ui::parity::probe("arxiv/status"))
                    .child(status),
            )
            .child(
                Button::new("arxiv-cancel", t!("Cancel"))
                    .ghost()
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
            )
            .child(
                Button::new(
                    "arxiv-export",
                    if self.exporting {
                        t!("Exporting…")
                    } else {
                        t!("Export ZIP")
                    },
                )
                .primary()
                .disabled(pack.is_none() || running || failures > 0 || self.exporting)
                .on_click(cx.listener(|this, _, _, cx| this.export(cx))),
            );
        body.push(actions.into_any_element());
        let card = div()
            .id("arxiv-export-card")
            .relative()
            .w(width)
            .max_h(viewport.height - px(40.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .overflow_hidden()
            .children(lattice_ui::parity::probe("arxiv/modal"))
            .child(
                div()
                    .id("arxiv-export-scroll")
                    .max_h(viewport.height - px(40.))
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .pt(px(20.))
                            .px(px(20.))
                            .pb(px(16.))
                            .children(body),
                    ),
            )
            .child(FluidScrollbar::vertical(
                "arxiv-export-scrollbar",
                &self.scroll,
            ));
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "arxiv-export",
            LayerPlacement::Center,
            lattice_ui::components::rise_in("arxiv-export-rise", card),
            move |_, cx| {
                this.update(cx, |sheet, cx| sheet.close(cx)).ok();
            },
        )
    }
}

/// An inline message with the one thing to do about it under it.
fn blocked(message: AnyElement, action: AnyElement) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .items_start()
        .gap(px(8.))
        .child(message)
        .child(action)
        .into_any_element()
}

/// The pack's files, each with its size.
fn files_list(pack: &ArxivPackage, cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let editor_font = cx.lattice().fonts.editor.clone();
    div()
        .id("arxiv-export-files")
        .max_h(px(160.))
        .overflow_y_scroll()
        .py(px(4.))
        .text_role(TextRole::Caption, cx)
        .children(pack.files.iter().map(|file| {
            div()
                .flex()
                .gap(px(8.))
                .px(px(10.))
                .py(px(2.))
                .text_color(palette.text_secondary)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .whitespace_nowrap()
                        .font_family(editor_font.clone())
                        .child(file.path.clone()),
                )
                .child(
                    div()
                        .flex_none()
                        .font_features(tabular_nums())
                        .child(format_size(file.bytes)),
                )
        }))
        .into_any_element()
}

impl ArxivExportSheet {
    /// What will be sent: the archive's icon and name, the summary line, and
    /// the Files disclosure.
    fn render_summary(
        &self,
        pack: Option<&ArxivPackage>,
        file_name: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let line = match pack {
            Some(pack) => summary_line(pack),
            None => t!("Gathering the files the paper uses…").to_string(),
        };
        let disclosure = pack.map(|_| {
            let (state, pointer) = use_interaction("arxiv-files-disclosure", window, cx);
            let open = self.files_open;
            let button = div()
                .id("arxiv-files-disclosure")
                .flex_none()
                .flex()
                .items_center()
                .gap(px(2.))
                .px(px(6.))
                .py(px(4.))
                .rounded(RADIUS_CONTROL)
                .bg(state.wash(gpui::transparent_black(), palette.hover, palette.pressed))
                .text_role(TextRole::Caption, cx)
                .text_color(if state.hover > 0.5 {
                    palette.text
                } else {
                    palette.text_secondary
                })
                .cursor_pointer()
                .child(t!("Files"))
                .child(
                    if open {
                        Icon::CHEVRON_DOWN
                    } else {
                        Icon::CHEVRON_RIGHT
                    }
                    .element(px(12.), palette.text_secondary),
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.files_open = !this.files_open;
                    cx.notify();
                }));
            lattice_ui::interaction::track_pointer(button, pointer)
        });
        div()
            .flex()
            .items_center()
            .gap(px(10.))
            .p(px(10.))
            .rounded(CHROME.paint(RADIUS_SURFACE))
            .bg(palette.raised)
            .border_1()
            .border_color(palette.line)
            .children(lattice_ui::parity::probe("arxiv/summary"))
            .child(
                div()
                    .flex_none()
                    .size(px(36.))
                    .rounded(lattice_ui::shape::RADIUS_TARGET)
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(palette.accent_soft)
                    .child(Icon::FILE_ARCHIVE.element(px(18.), palette.text_secondary)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_role(TextRole::Body, cx)
                            .font_weight(FONT_WEIGHT_SEMIBOLD)
                            .text_color(palette.text)
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(file_name.to_string()),
                    )
                    .child(
                        div()
                            .text_role(TextRole::Caption, cx)
                            .text_color(palette.text_secondary)
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(line),
                    ),
            )
            .children(disclosure)
            .into_any_element()
    }

    /// The checks, one row each, in one ringed list.
    fn render_checks(
        &self,
        rows: &[CheckRow],
        pack: Option<&ArxivPackage>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let log = pack.and_then(|pack| pack.compile.as_ref()?.log.clone());
        let count = rows.len();
        let items = rows.iter().enumerate().map(|(index, check)| {
            let (mark, mark_bg) = match check.state {
                CheckState::Ok => (
                    Icon::CHECK
                        .element(px(13.), palette.success)
                        .into_any_element(),
                    Some(palette.success_soft),
                ),
                CheckState::Warn => (
                    Icon::TRIANGLE_ALERT
                        .element(px(13.), palette.warning)
                        .into_any_element(),
                    None,
                ),
                CheckState::Fail => (
                    Icon::CIRCLE_X
                        .element(px(13.), palette.danger)
                        .into_any_element(),
                    None,
                ),
                CheckState::Running => (
                    spinner("arxiv-check-spinner", 13., palette.text_secondary),
                    None,
                ),
                CheckState::Pending => (
                    Icon::CIRCLE_DASHED
                        .element(px(13.), palette.text_secondary)
                        .into_any_element(),
                    None,
                ),
            };
            let failed = check.state == CheckState::Fail;
            let review = check.review.as_ref().filter(|lines| !lines.is_empty());
            let tool = if review.is_some() {
                Some(
                    Button::new(
                        "arxiv-review-comments",
                        tc!("arXiv export comments", "Review"),
                    )
                    .ghost()
                    .compact()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.review_open = !this.review_open;
                        cx.notify();
                    }))
                    .into_any_element(),
                )
            } else if check.id == CheckId::Compile && failed && log.is_some() {
                Some(
                    Button::new("arxiv-copy-log", t!("Copy log"))
                        .ghost()
                        .compact()
                        .on_click(cx.listener(|this, _, _, cx| this.copy_log(cx)))
                        .into_any_element(),
                )
            } else {
                None
            };
            let head = div()
                .flex()
                .items_center()
                .gap(px(8.))
                .min_h(px(44.))
                .px(px(10.))
                .py(px(6.))
                .when(index == 0, |head| {
                    head.children(lattice_ui::parity::probe("arxiv/check"))
                })
                .child(
                    div()
                        .flex_none()
                        .size(px(18.))
                        .rounded(RADIUS_PILL)
                        .flex()
                        .items_center()
                        .justify_center()
                        .when_some(mark_bg, |mark, bg| mark.bg(bg))
                        .child(mark),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .font_weight(FONT_WEIGHT_MEDIUM)
                                .text_color(if check.state == CheckState::Pending {
                                    palette.text_secondary
                                } else {
                                    palette.text
                                })
                                .child(check.label.clone()),
                        )
                        .when(!check.detail.is_empty(), |text| {
                            text.child(
                                div()
                                    .text_role(TextRole::Micro, cx)
                                    .font_weight(lattice_ui::tokens::FONT_WEIGHT_REGULAR)
                                    .text_color(palette.text_secondary)
                                    .min_w_0()
                                    .map(|detail| {
                                        if failed {
                                            detail.line_clamp(2)
                                        } else {
                                            detail
                                                .overflow_hidden()
                                                .text_ellipsis()
                                                .whitespace_nowrap()
                                        }
                                    })
                                    .child(check.detail.clone()),
                            )
                        }),
                )
                .children(tool);
            let comments = review.filter(|_| self.review_open).map(|lines| {
                div()
                    .id("arxiv-export-comments")
                    .max_h(px(160.))
                    .overflow_y_scroll()
                    .mb(px(6.))
                    .ml(px(36.))
                    .mr(px(10.))
                    .text_role(TextRole::Caption, cx)
                    .children(lines.iter().map(|comment| {
                        div()
                            .flex()
                            .gap(px(8.))
                            .py(px(2.))
                            .child(
                                div()
                                    .flex_none()
                                    .font_family(editor_font.clone())
                                    .font_features(tabular_nums())
                                    .whitespace_nowrap()
                                    .text_color(palette.text_secondary)
                                    .child(format!("{}:{}", comment.file, comment.line)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .text_ellipsis()
                                    .whitespace_nowrap()
                                    .text_color(if comment.todo {
                                        palette.warning
                                    } else {
                                        palette.text_secondary
                                    })
                                    .child(comment.text.clone()),
                            )
                    }))
            });
            div()
                .when(index + 1 < count, |item| {
                    item.border_b_1().border_color(palette.line)
                })
                .child(head)
                .children(comments)
        });
        div()
            .rounded(CHROME.paint(RADIUS_SURFACE))
            .border_1()
            .border_color(palette.line)
            .overflow_hidden()
            .children(lattice_ui::parity::probe("arxiv/checks"))
            .children(items)
            .into_any_element()
    }

    /// A `SwitchField`: the label, the switch at the end.
    fn switch_field(
        &self,
        id: &'static str,
        label: String,
        on: bool,
        set: fn(&mut ArxivOptions, bool),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let this = cx.entity().downgrade();
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(16.))
            .py(px(4.))
            .child(
                div()
                    .min_w_0()
                    .text_role(TextRole::BodyCompact, cx)
                    .text_color(palette.text)
                    .child(label),
            )
            .child(Switch::new(id, on).on_toggle(move |value, _, cx| {
                let value = *value;
                this.update(cx, |sheet, cx| {
                    sheet.set_options(|options| set(options, value), cx)
                })
                .ok();
            }))
            .into_any_element()
    }
}
