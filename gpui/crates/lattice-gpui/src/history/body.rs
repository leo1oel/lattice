//! An opened row's body, ported from the Tauri app's `HistoryDrawer`
//! (`renderTransaction`) and `VersionBody` / `VersionFileChanges`
//! (`versions-timeline.tsx`), with their rules in `history-timeline.css`
//! and `workspace-panels.css`.
//!
//! - An activity entry shows its one file's diff and "Restore this file",
//!   or, for several files, a chip per file over one 420px view of their
//!   diffs one after another, each headed by its path, its kind of change
//!   and a restore of that file alone; a chip scrolls the view to its file.
//! - A version lists its files as chips (the first twelve, the rest on
//!   request); the open file reads as its changed passages in the reading
//!   font with ↑ ↓ between them, or as its source diff (Text / Source); then
//!   Compare with now and the restores. Compared with now, a note says so
//!   with the way back to the version's own changes.

use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, InteractiveElement as _, IntoElement, ParentElement as _,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    prelude::FluentBuilder as _, px,
};
use lattice_core::{git::GitLogEntry, project::HistoryItem};
use lattice_i18n::{format_count, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::Segmented,
    tokens::{RADIUS_CONTROL, RADIUS_PANEL},
    typography::tabular_nums,
};

use super::{
    diff_view::history_diff,
    inline_edits::passage_text,
    panel::{HistoryPanel, VersionFile},
    prose::ProsePassage,
    timeline,
    widgets::{Control, inline_message, loading_line},
};

/// Past this many files a version lists the first ones and offers the rest.
const FILE_CHIPS: usize = 12;

/// The glyph beside a file in a version's file list, in its kind's ink.
pub fn file_kind_icon(kind: &str, cx: &App) -> AnyElement {
    let palette = cx.palette();
    let (icon, ink) = match kind {
        "added" => (Icon::FILE_PLUS_CORNER, palette.success),
        "deleted" | "removed" => (Icon::FILE_X_CORNER, palette.danger),
        "renamed" => (Icon::MOVE_RIGHT, palette.accent),
        _ => (Icon::FILE_PEN, palette.text_secondary),
    };
    icon.element(px(12.), ink).into_any_element()
}

fn open_line(path: String, cx: &mut Context<HistoryPanel>) -> super::OnLine {
    let panel = cx.entity().downgrade();
    Rc::new(move |line, _, cx| {
        let path = path.clone();
        panel
            .update(cx, |panel, cx| panel.open_file(path, Some(line as u32), cx))
            .ok();
    })
}

pub fn activity_body(
    panel: &mut HistoryPanel,
    item: &HistoryItem,
    window: &mut Window,
    cx: &mut Context<HistoryPanel>,
) -> AnyElement {
    let mut body = div().flex().flex_col().gap(px(8.)).min_w_0();
    if panel.entry.loading && panel.entry.is(&item.id) {
        body = body.child(loading_line(
            "history-entry-loading",
            t!("Loading diff…"),
            cx,
        ));
    }
    if !panel.entry.error.is_empty() && panel.entry.is(&item.id) {
        body = body.child(inline_message(panel.entry.error.clone(), true, cx));
    }
    let Some(entry) = panel
        .entry
        .value
        .as_ref()
        .filter(|entry| entry.id == item.id)
    else {
        return body.into_any_element();
    };
    let id = item.id.clone();
    match entry.diffs.as_slice() {
        [] => {}
        [single] => {
            let path = single.change.path.clone();
            body = body
                .child(history_diff(
                    format!("history-entry-{}", item.id),
                    single,
                    false,
                    None,
                    Some(open_line(path.clone(), cx)),
                    window,
                    cx,
                ))
                .child(
                    div().flex().flex_wrap().gap(px(6.)).child(
                        Control::action("history-entry-restore-file", t!("Restore this file"))
                            .icon(Icon::ROTATE_CCW, px(12.))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.revert_entry(id.clone(), Some(path.clone()), cx)
                            })),
                    ),
                );
        }
        diffs => {
            let active = entry.active;
            let chips = diffs
                .iter()
                .enumerate()
                .map(|(index, diff)| {
                    Control::chip(
                        SharedString::from(format!("history-entry-file-{index}")),
                        diff.change.path.clone(),
                    )
                    .on(index == active)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(entry) = this.entry.value.as_mut() {
                            entry.active = index;
                            entry.scroll.scroll_to_item(index);
                            cx.notify();
                        }
                    }))
                    .into_any_element()
                })
                .collect::<Vec<_>>();
            let palette = cx.palette().clone();
            let views: Vec<AnyElement> = diffs
                .iter()
                .enumerate()
                .map(|(index, diff)| {
                    let path = diff.change.path.clone();
                    let entry_id = id.clone();
                    let restore = Control::tool(
                        SharedString::from(format!("history-entry-restore-{index}")),
                        Icon::ROTATE_CCW,
                        t!("Restore only {0}", path),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.revert_entry(entry_id.clone(), Some(path.clone()), cx)
                    }))
                    .into_any_element();
                    div()
                        .pb(px(8.))
                        .child(history_diff(
                            format!("history-entry-{}-{index}", item.id),
                            diff,
                            false,
                            Some(restore),
                            Some(open_line(diff.change.path.clone(), cx)),
                            window,
                            cx,
                        ))
                        .into_any_element()
                })
                .collect();
            let scroll = entry.scroll.clone();
            body = body
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(px(4.))
                        .min_w_0()
                        .children(chips),
                )
                .child(
                    div()
                        .relative()
                        .h(px(420.))
                        .min_h(px(220.))
                        .overflow_hidden()
                        .border_1()
                        .border_color(palette.line)
                        .rounded(RADIUS_CONTROL)
                        .bg(palette.window)
                        .child(
                            div()
                                .id(SharedString::from(format!("history-code-view-{}", item.id)))
                                .size_full()
                                .overflow_y_scroll()
                                .track_scroll(&scroll)
                                .children(views),
                        )
                        .child(lattice_ui::scrollbar::FluidScrollbar::vertical(
                            SharedString::from(format!("history-code-view-scrollbar-{}", item.id)),
                            &scroll,
                        )),
                );
        }
    }
    body.into_any_element()
}

pub fn version_body(
    panel: &mut HistoryPanel,
    entry: &GitLogEntry,
    window: &mut Window,
    cx: &mut Context<HistoryPanel>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let key = timeline::version_key(&entry.hash);
    let busy = panel.versions.busy;
    let Some(opened) = panel
        .opened
        .as_ref()
        .filter(|opened| opened.hash == entry.hash)
    else {
        return div().into_any_element();
    };
    let compare = opened.compare;
    let active = opened.active_path.clone();
    let all = opened.all_files;
    let mut body = div().flex().flex_col().gap(px(8.)).min_w_0();
    if compare {
        let key = key.clone();
        body = body.child(
            div()
                .flex()
                .flex_wrap()
                .items_baseline()
                .gap_x(px(12.))
                .text_role(TextRole::Caption, cx)
                .text_color(palette.text_secondary)
                .child(t!("Compared with now"))
                .child(
                    Control::link("version-mode-switch", t!("Show this version's changes"))
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.compare_row(key.clone(), cx)),
                        ),
                ),
        );
    }
    let shown = if all {
        entry.files.len()
    } else {
        entry.files.len().min(FILE_CHIPS)
    };
    let chips = entry.files[..shown].iter().map(|file| {
        let path = file.path.clone();
        Control::chip(
            SharedString::from(format!("version-file-{}", file.path)),
            file.path.clone(),
        )
        .leading(file_kind_icon(&file.kind, cx))
        .on(active.as_deref() == Some(file.path.as_str()))
        .tooltip(file.path.clone())
        .on_click(cx.listener(move |this, _, _, cx| this.open_version_file(path.clone(), cx)))
        .into_any_element()
    });
    let hidden = entry.files.len() - shown;
    body = body.child(
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .min_w_0()
            .children(chips)
            .when(hidden > 0, |this| {
                this.child(
                    Control::quiet(
                        "version-more-files",
                        t!("{hidden} more files", hidden = format_count(hidden as i64)),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(opened) = this.opened.as_mut() {
                            opened.all_files = true;
                            cx.notify();
                        }
                    })),
                )
            }),
    );
    if let Some(path) = &active {
        body = body.child(version_file(panel, path, window, cx));
    }
    let hash = entry.hash.clone();
    let mut actions = div()
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(8.))
        .gap_y(px(6.))
        .min_w_0();
    if !compare {
        let key = key.clone();
        actions = actions.child(
            Control::action("version-compare-now", t!("Compare with now"))
                .icon(Icon::GIT_COMPARE_ARROWS, px(12.))
                .on_click(cx.listener(move |this, _, _, cx| this.compare_row(key.clone(), cx))),
        );
    }
    if let Some(path) = active.clone() {
        let hash = hash.clone();
        actions = actions.child(
            Control::action("version-restore-file", t!("Restore this file"))
                .icon(Icon::ROTATE_CCW, px(12.))
                .disabled(busy)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.restore_file(hash.clone(), path.clone(), cx)
                })),
        );
    }
    actions = actions.child(
        Control::action(
            "version-restore-project",
            t!("Restore project to this version"),
        )
        .icon(Icon::ROTATE_CCW, px(12.))
        .disabled(busy)
        .on_click(cx.listener(move |this, _, _, cx| this.restore_project(hash.clone(), cx))),
    );
    body.child(actions).into_any_element()
}

/// The open file of a version: its passages as prose, or its source diff.
fn version_file(
    panel: &mut HistoryPanel,
    path: &str,
    window: &mut Window,
    cx: &mut Context<HistoryPanel>,
) -> AnyElement {
    let Some(opened) = panel.opened.as_ref() else {
        return div().into_any_element();
    };
    if !opened.diff.error.is_empty() {
        return inline_message(opened.diff.error.clone(), true, cx);
    }
    let Some(VersionFile {
        diff,
        loaded,
        passages,
    }) = opened.diff.value.as_ref()
    else {
        return loading_line("version-file-loading", t!("Loading diff…"), cx);
    };
    let source = opened.source;
    let current = opened.current;
    let mode = passages.as_ref().map(|_| reader_mode(source, cx));
    if passages.is_none() || source {
        let diff_view = match loaded {
            Some(loaded) => history_diff(
                format!("version-file-{path}"),
                loaded,
                false,
                None,
                None,
                window,
                cx,
            ),
            None => {
                let change = super::diff_view::FileChange {
                    path: path.to_string(),
                    before: diff.before.clone(),
                    after: diff.after.clone(),
                };
                let loaded = super::diff_view::LoadedDiff::new(change, cx);
                history_diff(
                    format!("version-file-{path}"),
                    &loaded,
                    diff.binary,
                    None,
                    None,
                    window,
                    cx,
                )
            }
        };
        return div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .min_w_0()
            .children(mode.map(|mode| div().flex().justify_end().child(mode)))
            .child(diff_view)
            .into_any_element();
    }
    let passages = passages.as_ref().expect("prose was read");
    let prose = prose_box(path, passages, current, cx);
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .min_w_0()
        .children(mode.map(|mode| div().flex().justify_end().child(mode)))
        .child(prose)
        .into_any_element()
}

/// Text or Source.
fn reader_mode(source: bool, cx: &mut Context<HistoryPanel>) -> AnyElement {
    Segmented::new("version-reader-mode")
        .filled()
        .label(
            t!("Text"),
            !source,
            cx.listener(|this, _, _, cx| set_source(this, false, cx)),
        )
        .label(
            t!("Source"),
            source,
            cx.listener(|this, _, _, cx| set_source(this, true, cx)),
        )
        .into_any_element()
}

fn set_source(panel: &mut HistoryPanel, source: bool, cx: &mut Context<HistoryPanel>) {
    if let Some(opened) = panel.opened.as_mut() {
        opened.source = source;
        cx.notify();
    }
}

fn step(panel: &mut HistoryPanel, by: isize, total: usize, cx: &mut Context<HistoryPanel>) {
    if let Some(opened) = panel.opened.as_mut() {
        let next = (opened.current as isize + by).clamp(0, total.saturating_sub(1) as isize);
        opened.current = next as usize;
        cx.notify();
    }
}

/// The passages in their box: the count and the steps, then each passage
/// with the line it starts on.
fn prose_box(
    path: &str,
    passages: &[ProsePassage],
    current: usize,
    cx: &mut Context<HistoryPanel>,
) -> AnyElement {
    let palette = cx.palette().clone();
    let total = passages.len();
    let head = (total > 0).then(|| {
        let count = if total == 1 {
            t!("1 change").to_string()
        } else {
            t!("{count} changes", count = format_count(total as i64))
        };
        div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .min_h(px(28.))
            .pl(px(12.))
            .pr(px(6.))
            .border_b_1()
            .border_color(palette.line)
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(count)
            .when(total > 1, |this| {
                this.child(
                    div()
                        .flex()
                        .gap(px(2.))
                        .child(
                            Control::step(
                                "version-step-up",
                                Icon::ARROW_UP,
                                t!("Previous change"),
                                false,
                            )
                            .disabled(current == 0)
                            .on_click(cx.listener(move |this, _, _, cx| step(this, -1, total, cx))),
                        )
                        .child(
                            Control::step(
                                "version-step-down",
                                Icon::ARROW_DOWN,
                                t!("Next change"),
                                false,
                            )
                            .disabled(current + 1 >= total)
                            .on_click(cx.listener(move |this, _, _, cx| step(this, 1, total, cx))),
                        ),
                )
            })
    });
    let empty = (total == 0).then(|| {
        div()
            .px(px(12.))
            .py(px(10.))
            .text_role(TextRole::Caption, cx)
            .text_color(palette.text_secondary)
            .child(t!("No textual changes"))
    });
    let rows = passages.iter().enumerate().map(|(index, passage)| {
        let current = total > 1 && index == current;
        div()
            .id(SharedString::from(format!(
                "version-passage-{path}-{index}"
            )))
            .flex()
            .gap(px(8.))
            .px(px(12.))
            .py(px(10.))
            .when(index > 0, |this| {
                this.border_t_1().border_color(palette.line)
            })
            .relative()
            // The change ↑ ↓ last stepped to: a bar in the gutter, not a second fill.
            .when(current, |this| {
                this.child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom_0()
                        .w(px(2.))
                        .bg(palette.line_strong),
                )
            })
            .child(
                div()
                    .flex_none()
                    .min_w(px(14.))
                    .flex()
                    .justify_end()
                    .text_role(TextRole::Caption, cx)
                    .line_height(px(22.))
                    .text_color(palette.text_secondary)
                    .font_features(tabular_nums())
                    .child(passage.line.to_string()),
            )
            .child(div().flex_1().min_w_0().child(passage_text(passage, cx)))
    });
    div()
        .min_w_0()
        .border_1()
        .border_color(palette.line)
        .rounded(RADIUS_PANEL)
        .bg(palette.raised)
        .overflow_hidden()
        .children(head)
        .children(empty)
        .children(rows)
        .into_any_element()
}
