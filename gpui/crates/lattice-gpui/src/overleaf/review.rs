//! "Review changes" for manual Overleaf sync (`overleaf-review.tsx`,
//! `overleaf-review.css`). Manual mode is meant to feel like reviewing a
//! pull rather than pressing a button and hoping: this asks lattice-core
//! what a sync would do, without writing anything, and shows it as the files
//! grouped by what happens to them beside their diffs, so nothing lands on
//! disk until the writer says so.

use std::collections::BTreeSet;

use gpui::{
    AnyElement, App, AppContext as _, Context, EventEmitter, FocusHandle, Focusable, Hsla,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Task, Window, div, prelude::FluentBuilder as _,
    px,
};
use lattice_core::overleaf::{OverleafChange, OverleafPreview};
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Elevation, Icon, TextRole, TextRoleStyle as _,
    components::{Button, ButtonSize, ButtonVariant, LayerPlacement, ModalLayer, rise_in},
    fluid_hover::{FluidHover, ItemKind},
    scrollbar::FluidScrollbar,
    tokens::{FONT_WEIGHT_SEMIBOLD, RADIUS_CONTROL, RADIUS_DIALOG, RADIUS_PANEL, RADIUS_PILL},
};

use super::{parts::wash, sync};
use crate::{
    build::chip_mark::infinity_loader,
    history::{
        diff_view::{FileChange, LoadedDiff, history_diff},
        widgets::inline_message,
    },
};

/// What the dialog tells the window.
pub enum ReviewEvent {
    Close,
    /// Apply: run the real sync.
    Apply,
}

/// A group of changes: what happens to its files says its title, and only
/// "Kept here" has a blurb, the one outcome a title cannot carry.
struct Group {
    kind: &'static str,
    icon: Icon,
    title: fn() -> SharedString,
    blurb: Option<fn() -> SharedString>,
}

const GROUPS: [Group; 8] = [
    Group {
        kind: "conflict",
        icon: Icon::TRIANGLE_ALERT,
        title: || t!("Edited on both sides").into(),
        blurb: None,
    },
    Group {
        kind: "unresolvedConflict",
        icon: Icon::TRIANGLE_ALERT,
        title: || t!("Waiting on conflict resolution").into(),
        blurb: None,
    },
    Group {
        kind: "refusedIncoming",
        icon: Icon::SHIELD_ALERT,
        title: || t!("Kept here").into(),
        blurb: Some(|| {
            t!("Overleaf sent these empty or much smaller, but its history does not confirm the change, so your copy stays. To take Overleaf's version anyway, delete the file here and sync again").into()
        }),
    },
    Group {
        kind: "incoming",
        icon: Icon::ARROW_DOWN_TO_LINE,
        title: || t!("Coming from Overleaf").into(),
        blurb: None,
    },
    Group {
        kind: "merge",
        icon: Icon::GIT_MERGE,
        title: || t!("Combines automatically").into(),
        blurb: None,
    },
    Group {
        kind: "outgoing",
        icon: Icon::ARROW_UP_FROM_LINE,
        title: || t!("Going to Overleaf").into(),
        blurb: None,
    },
    Group {
        kind: "deleteLocal",
        icon: Icon("icons/trash.svg"),
        title: || t!("Deleted here too").into(),
        blurb: None,
    },
    Group {
        kind: "skippedRemoteDelete",
        icon: Icon("icons/trash.svg"),
        title: || t!("Still on Overleaf").into(),
        blurb: None,
    },
];

/// The group's ink on its heading and on each diff's header.
fn kind_ink(kind: &str, cx: &App) -> Option<Hsla> {
    let palette = cx.palette();
    match kind {
        "conflict" => Some(palette.danger),
        "incoming" => Some(palette.accent),
        "refusedIncoming" => Some(palette.warning),
        _ => None,
    }
}

/// The line under the title: how many files would change, and how many
/// need a decision.
pub fn summary(changes: &[OverleafChange]) -> String {
    if changes.is_empty() {
        return t!("Everything already matches Overleaf").into();
    }
    let total = changes
        .iter()
        .filter(|change| change.kind != "unresolvedConflict")
        .count();
    let conflicts = changes
        .iter()
        .filter(|change| change.kind == "conflict" || change.kind == "unresolvedConflict")
        .count();
    let change_summary: String = if total == 1 {
        t!("{total} file would change", total = total)
    } else {
        t!("{total} files would change", total = total)
    };
    let conflict_summary: String = if conflicts == 1 {
        t!("{conflicts} needs your decision", conflicts = conflicts)
    } else {
        t!("{conflicts} need your decision", conflicts = conflicts)
    };
    if total == 0 {
        conflict_summary
    } else if conflicts > 0 {
        t!(
            "{changeSummary}, {conflictSummary}",
            changeSummary = &change_summary,
            conflictSummary = &conflict_summary
        )
        .into()
    } else {
        change_summary
    }
}

pub struct OverleafReview {
    root: std::path::PathBuf,
    preview: Option<OverleafPreview>,
    /// Each text change's diff, in the order the list shows them.
    diffs: Vec<(String, &'static str, LoadedDiff)>,
    loading: bool,
    error: Option<SharedString>,
    applying: bool,
    selected: Option<String>,
    list_scroll: ScrollHandle,
    diff_scroll: ScrollHandle,
    focus: FocusHandle,
    task: Option<Task<()>>,
}

impl EventEmitter<ReviewEvent> for OverleafReview {}

impl Focusable for OverleafReview {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl OverleafReview {
    pub fn new(root: std::path::PathBuf, cx: &mut Context<Self>) -> Self {
        let mut review = Self {
            root,
            preview: None,
            diffs: Vec::new(),
            loading: false,
            error: None,
            applying: false,
            selected: None,
            list_scroll: ScrollHandle::new(),
            diff_scroll: ScrollHandle::new(),
            focus: cx.focus_handle(),
            task: None,
        };
        review.load(cx);
        review
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.error = None;
        cx.notify();
        let root = self.root.clone();
        let read = cx.background_spawn(async move { sync::preview(&root, &BTreeSet::new()) });
        self.task = Some(cx.spawn(async move |this, cx| {
            let (preview, expired) = read.await;
            this.update(cx, |this, cx| {
                this.loading = false;
                if expired {
                    super::session_changed(cx);
                }
                match preview {
                    Ok(preview) => {
                        this.diffs = GROUPS
                            .iter()
                            .flat_map(|group| {
                                preview
                                    .changes
                                    .iter()
                                    .filter(|change| change.kind == group.kind && !change.binary)
                                    .map(|change| (change.clone(), group.kind))
                                    .collect::<Vec<_>>()
                            })
                            .map(|(change, kind)| {
                                let loaded = LoadedDiff::new(
                                    FileChange {
                                        path: change.path.clone(),
                                        before: change.before.clone(),
                                        after: change.after.clone(),
                                    },
                                    cx,
                                );
                                (change.path, kind, loaded)
                            })
                            .collect();
                        this.selected = this.diffs.first().map(|(path, ..)| path.clone());
                        this.preview = Some(preview);
                    }
                    Err(error) => {
                        this.preview = None;
                        this.diffs.clear();
                        this.selected = None;
                        this.error = Some(error.into());
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The window ran the sync this asked for: close on success, or say why
    /// it failed and stay.
    pub fn applied(&mut self, error: Option<String>, cx: &mut Context<Self>) {
        self.applying = false;
        match error {
            None => cx.emit(ReviewEvent::Close),
            Some(error) => self.error = Some(error.into()),
        }
        cx.notify();
    }

    fn apply(&mut self, cx: &mut Context<Self>) {
        if self.applying || self.loading {
            return;
        }
        self.applying = true;
        self.error = None;
        cx.emit(ReviewEvent::Apply);
        cx.notify();
    }

    fn reveal(&mut self, path: String, cx: &mut Context<Self>) {
        if let Some(index) = self.diffs.iter().position(|(diff, ..)| diff == &path) {
            self.diff_scroll.scroll_to_item(index);
        }
        self.selected = Some(path);
        cx.notify();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if !self.applying {
            cx.emit(ReviewEvent::Close);
        }
    }

    fn group_card(
        &self,
        group: &Group,
        changes: &[&OverleafChange],
        offset: usize,
        hover: &FluidHover,
        section: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let conflict = group.kind == "conflict";
        let ink = kind_ink(group.kind, cx).unwrap_or(palette.text);
        let rows = changes.iter().enumerate().map(|(ix, change)| {
            let active = self.selected.as_deref() == Some(change.path.as_str());
            let path = change.path.clone();
            let row = div()
                .id(SharedString::from(format!(
                    "overleaf-review-file-{}",
                    change.path
                )))
                .relative()
                .min_h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(RADIUS_CONTROL)
                .text_role(TextRole::Caption, cx)
                .text_color(if change.binary {
                    palette.text_secondary
                } else if active {
                    palette.accent
                } else {
                    palette.text
                })
                .when(active, |this| this.bg(palette.accent_soft))
                .when(!change.binary, |this| {
                    this.on_click(cx.listener(move |this, _, _, cx| this.reveal(path.clone(), cx)))
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(change.path.clone()),
                )
                .when(change.binary, |this| {
                    this.child(
                        div()
                            .flex_none()
                            .px(px(6.))
                            .py(px(2.))
                            .rounded(RADIUS_PILL)
                            .bg(palette.line)
                            .text_role(TextRole::Micro, cx)
                            .text_color(palette.text_secondary)
                            .child(t!("binary")),
                    )
                });
            let kind = if change.binary || active {
                ItemKind::skip()
            } else {
                ItemKind::target()
            };
            hover.item_as(offset + ix, kind.section(section), row)
        });
        div()
            .pt(px(10.))
            .px(px(10.))
            .pb(px(8.))
            .border_1()
            .border_color(if conflict {
                mix_over(palette.danger, 0.28, palette.line)
            } else {
                palette.line
            })
            .rounded(RADIUS_PANEL)
            .bg(if conflict {
                mix_over(palette.danger, 0.05, palette.panel)
            } else {
                palette.panel
            })
            .child(
                div()
                    .mb(px(2.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_SEMIBOLD)
                    .text_color(ink)
                    .child(group.icon.element(px(13.), ink))
                    .child((group.title)()),
            )
            .children(group.blurb.map(|blurb| {
                div()
                    .mb(px(8.))
                    .text_role(TextRole::Micro, cx)
                    .text_color(palette.text_secondary)
                    .child(blurb())
            }))
            .when(group.blurb.is_none(), |this| this.child(div().h(px(6.))))
            .child(div().flex().flex_col().gap(px(2.)).children(rows))
            .into_any_element()
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl OverleafReview {
    /// The summary under the title, once the preview has loaded.
    pub fn scenario_summary(&self) -> Option<String> {
        (!self.loading)
            .then(|| {
                self.preview
                    .as_ref()
                    .map(|preview| summary(&preview.changes))
            })
            .flatten()
    }

    /// Apply, as its button does.
    pub fn scenario_apply(&mut self, cx: &mut Context<Self>) {
        self.apply(cx);
    }
}

/// `color` at `share` over an opaque `ground` (`color-mix(in srgb, color N%,
/// ground)`), close enough for a tint.
fn mix_over(color: Hsla, share: f32, ground: Hsla) -> Hsla {
    let (a, b) = (gpui::Rgba::from(color), gpui::Rgba::from(ground));
    let mix = |x: f32, y: f32| x * share + y * (1. - share);
    gpui::Rgba {
        r: mix(a.r, b.r),
        g: mix(a.g, b.g),
        b: mix(a.b, b.b),
        a: b.a,
    }
    .into()
}

impl Render for OverleafReview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let viewport = window.viewport_size();
        let width = px(920.).min(viewport.width - px(48.));
        let max_height = viewport.height - px(64.);
        let narrow = width < px(640.);
        let changes = self
            .preview
            .as_ref()
            .map(|preview| preview.changes.clone())
            .unwrap_or_default();
        let total = changes
            .iter()
            .filter(|change| change.kind != "unresolvedConflict")
            .count();

        let head = div()
            .flex()
            .items_start()
            .justify_between()
            .gap(px(12.))
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_role(TextRole::Title, cx)
                            .text_color(palette.text)
                            .child(t!("Review changes")),
                    )
                    .when(!self.loading && self.preview.is_some(), |this| {
                        this.child(
                            div()
                                .text_role(TextRole::Caption, cx)
                                .text_color(palette.text_secondary)
                                .child(summary(&changes)),
                        )
                    }),
            )
            .child(
                Button::new("overleaf-review-refresh", t!("Refresh"))
                    .variant(ButtonVariant::Ghost)
                    .size(ButtonSize::Compact)
                    .icon(Icon::REFRESH)
                    .disabled(self.loading || self.applying)
                    .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
            );

        let error = self.error.clone().map(|error| {
            div()
                .py(px(8.))
                .px(px(10.))
                .rounded(RADIUS_CONTROL)
                .bg(wash(palette.danger, 0.12))
                .child(inline_message(error, true, cx))
        });

        let body: AnyElement = if self.loading {
            div()
                .min_h(px(280.))
                .py(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .child(infinity_loader(
                    "overleaf-review-loading",
                    px(16.),
                    &palette,
                ))
                .into_any_element()
        } else {
            let hover = FluidHover::new("overleaf-review-files", window, cx).fill(palette.hover);
            let mut offset = 0;
            let mut cards = Vec::new();
            for (section, group) in GROUPS.iter().enumerate() {
                let items: Vec<&OverleafChange> = changes
                    .iter()
                    .filter(|change| change.kind == group.kind)
                    .collect();
                if items.is_empty() {
                    continue;
                }
                cards.push(self.group_card(group, &items, offset, &hover, section, cx));
                offset += items.len();
            }
            let list = div()
                .relative()
                .when(narrow, |this| this.max_h(px(180.)))
                .when(!narrow, |this| this.w(px(260.)).flex_none())
                .min_h_0()
                .child(
                    div()
                        .id("overleaf-review-list")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.list_scroll)
                        .pr(px(4.))
                        .child(
                            div()
                                .relative()
                                .flex()
                                .flex_col()
                                .gap(px(8.))
                                .child(hover.highlight())
                                .children(cards),
                        ),
                )
                .child(FluidScrollbar::vertical(
                    "overleaf-review-list-scroll",
                    &self.list_scroll,
                ));
            let diffs: AnyElement = if self.diffs.is_empty() {
                div()
                    .py(px(24.))
                    .px(px(16.))
                    .text_center()
                    .text_role(TextRole::Caption, cx)
                    .text_color(palette.text_secondary)
                    .child(if total == 0 {
                        t!("Nothing to show")
                    } else {
                        t!("Only binary files would change")
                    })
                    .into_any_element()
            } else {
                let frames = self.diffs.iter().map(|(path, kind, diff)| {
                    let ink = kind_ink(kind, cx).unwrap_or(palette.text_secondary);
                    let group = GROUPS.iter().find(|group| group.kind == *kind);
                    let label = group.map(|group: &Group| {
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .text_color(ink)
                            .child(group.icon.element(px(13.), ink))
                            .child((group.title)())
                            .into_any_element()
                    });
                    div()
                        .p(px(8.))
                        .child(history_diff(
                            format!("overleaf-review-diff-{path}"),
                            diff,
                            false,
                            label,
                            None,
                            window,
                            cx,
                        ))
                        .into_any_element()
                });
                div()
                    .id("overleaf-review-diffs")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.diff_scroll)
                    .children(frames)
                    .into_any_element()
            };
            div()
                .flex_1()
                .min_h_0()
                .flex()
                .when(narrow, |this| this.flex_col())
                .gap(px(16.))
                .child(list)
                .child(
                    div()
                        .relative()
                        .flex_1()
                        .min_h(px(200.))
                        .rounded(RADIUS_PANEL)
                        .border_1()
                        .border_color(palette.line)
                        .bg(palette.window)
                        .overflow_hidden()
                        .child(diffs)
                        .child(FluidScrollbar::vertical(
                            "overleaf-review-diff-scroll",
                            &self.diff_scroll,
                        )),
                )
                .into_any_element()
        };

        let actions = div()
            .flex()
            .justify_end()
            .gap(px(8.))
            .child(
                Button::new("overleaf-review-cancel", t!("Cancel"))
                    .disabled(self.applying)
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
            )
            .child(
                Button::new(
                    "overleaf-review-apply",
                    if self.applying {
                        t!("Applying…")
                    } else {
                        t!("Apply and sync")
                    },
                )
                .variant(ButtonVariant::Primary)
                .disabled(self.applying || self.loading || total == 0)
                .on_click(cx.listener(|this, _, _, cx| this.apply(cx))),
            );

        let card = div()
            .id("overleaf-review")
            .w(width)
            .max_h(max_height)
            .h(px(640.).min(max_height))
            .flex()
            .flex_col()
            .gap(px(16.))
            .pt(px(20.))
            .px(px(20.))
            .pb(px(16.))
            .rounded(RADIUS_DIALOG)
            .bg(palette.raised)
            .shadow(Elevation::Dialog.shadows(&palette))
            .overflow_hidden()
            .track_focus(&self.focus)
            .child(head)
            .children(error)
            .child(body)
            .child(actions);
        let this = cx.entity().downgrade();
        ModalLayer::new(
            "overleaf-review-layer",
            LayerPlacement::Center,
            rise_in("overleaf-review-in", card),
            move |_, cx| {
                this.update(cx, |this, cx| this.close(cx)).ok();
            },
        )
        .closable_by_scrim(!self.applying)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(kind: &str) -> OverleafChange {
        OverleafChange {
            path: format!("{kind}.tex"),
            kind: kind.into(),
            before: None,
            after: None,
            binary: false,
        }
    }

    #[test]
    fn the_summary_counts_changes_and_decisions() {
        assert_eq!(summary(&[]), "Everything already matches Overleaf");
        assert_eq!(summary(&[change("incoming")]), "1 file would change");
        assert_eq!(
            summary(&[change("incoming"), change("conflict")]),
            "2 files would change, 1 needs your decision"
        );
        assert_eq!(
            summary(&[change("unresolvedConflict")]),
            "1 needs your decision"
        );
    }
}
