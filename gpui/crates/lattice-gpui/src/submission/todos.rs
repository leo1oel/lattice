//! The TODOs tool panel, ported from the Tauri app's `TodoScavengerPanel`
//! (`src/project/todo-scavenger-panel.tsx`, `.todo-*` in
//! `src/styles/dialogs.css`), docked as the Tauri app docks the drawer: a
//! Trellis tool panel on the input surface, its content 14px in, no header
//! of its own (the panel's tab names it and closes it).
//!
//! With markers: a count ("3 markers", and "in 2 files" when they are spread
//! out), then each file's markers under its name, as Find groups its hits;
//! a row is the kind as the writer typed it, the line, and the comment
//! itself in two lines at most, FIXME and XXX in the danger tone. The rows
//! light with one fluid hover fill. Without any: the note spike, a title,
//! and the markers the scan matches.
//!
//! The hits are the project's scan (`status_counters`, lattice-core's
//! `list_todos`, read again after each save and outside edit) with each open
//! editor's file replaced by its buffer's markers once typing settles, as
//! the Tauri app's `mergeTodosWithBuffer` rescans the open file.

use std::path::PathBuf;

use gpui::{
    AnyElement, App, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div,
    prelude::FluentBuilder as _, px,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_core::project::TodoHit;
use lattice_i18n::t;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, TypeScale,
    fluid_hover::FluidHover,
    scrollbar::FluidScrollbar,
    tokens::{
        FONT_WEIGHT_MEDIUM, FONT_WEIGHT_REGULAR, FONT_WEIGHT_SEMIBOLD, RADIUS_COMPACT,
        RADIUS_CONTROL,
    },
    typography::tabular_nums,
};

use crate::research_art::{Drawing, research_art};

/// The markers the scan matches, as the writer types them.
const MARKERS: [&str; 4] = ["% TODO", "% FIXME", "% XXX", "\\todo"];

/// What the panel asks of the window.
pub enum TodosEvent {
    /// Open `path` (in the project) at `line`.
    Open { path: String, line: u32 },
}

pub struct TodosPanel {
    focus_handle: FocusHandle,
    root: Option<PathBuf>,
    scroll: ScrollHandle,
    _counters: Subscription,
}

impl EventEmitter<TodosEvent> for TodosPanel {}
impl EventEmitter<PanelEvent> for TodosPanel {}

impl TodosPanel {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let counters = crate::status_counters::project_counters(cx);
        Self {
            focus_handle: cx.focus_handle(),
            root: None,
            scroll: ScrollHandle::new(),
            _counters: cx.observe(&counters, |_, _, cx| cx.notify()),
        }
    }

    pub fn set_root(&mut self, root: Option<PathBuf>, cx: &mut Context<Self>) {
        self.root = root;
        self.scroll.set_offset(gpui::point(px(0.), px(0.)));
        cx.notify();
    }

    /// The hits shown, in the panel's order.
    pub fn hits(&self, cx: &App) -> Vec<TodoHit> {
        self.root
            .as_ref()
            .map(|root| crate::status_counters::todo_hits(root, cx))
            .unwrap_or_default()
    }
}

/// The kind as the writer typed it: a `\todo` command is not a comment marker.
fn kind_label(kind: &str) -> String {
    if kind == "todo" {
        "\\todo".into()
    } else {
        kind.into()
    }
}

/// Hits in the scan's order, gathered under the file they sit in.
pub fn by_file(hits: &[TodoHit]) -> Vec<(String, Vec<&TodoHit>)> {
    let mut files: Vec<(String, Vec<&TodoHit>)> = Vec::new();
    for hit in hits {
        match files.iter_mut().find(|(path, _)| *path == hit.path) {
            Some((_, list)) => list.push(hit),
            None => files.push((hit.path.clone(), vec![hit])),
        }
    }
    files
}

impl Render for TodosPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let hits = self.hits(cx);
        let content = if hits.is_empty() {
            empty(cx)
        } else {
            self.render_hits(&hits, window, cx)
        };
        div()
            .id("todos-panel")
            .track_focus(&self.focus_handle)
            .relative()
            .size_full()
            .bg(palette.input)
            .child(
                div()
                    .id("todos-scroll")
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .min_h_full()
                            .flex()
                            .flex_col()
                            .p(px(14.))
                            .child(content),
                    ),
            )
            .child(FluidScrollbar::vertical("todos-scrollbar", &self.scroll))
    }
}

/// `EmptyState fill` (`.todo-empty`): the note spike on the panel's own
/// surface, the title, then the markers the scan matches.
fn empty(cx: &App) -> AnyElement {
    let palette = cx.palette().clone();
    let editor_font = cx.lattice().fonts.editor.clone();
    let markers = MARKERS.iter().map(|marker| {
        div()
            .px(px(8.))
            .py(px(2.))
            .rounded(RADIUS_COMPACT)
            .border_1()
            .border_color(palette.line)
            .bg(palette.raised)
            .text_color(palette.text_secondary)
            .font_family(editor_font.clone())
            .text_size(TextRole::Micro.font_size(TypeScale::Interface, cx))
            .line_height(TextRole::Caption.leading(TypeScale::Interface))
            .whitespace_nowrap()
            .child(*marker)
    });
    div()
        .flex_1()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(6.))
        .py(px(20.))
        .px(px(12.))
        .children(lattice_ui::parity::probe("todos/empty"))
        .child(div().mb(px(8.)).child(research_art(
            Drawing::NoteSpike,
            px(144.),
            palette.input,
            cx,
        )))
        .child(
            div()
                .text_role(TextRole::Subtitle, cx)
                .text_color(palette.text)
                .text_center()
                .child(t!("No TODO markers found")),
        )
        .child(
            div()
                .mt(px(8.))
                .flex()
                .flex_wrap()
                .justify_center()
                .gap(px(6.))
                .children(markers),
        )
        .into_any_element()
}

impl TodosPanel {
    fn render_hits(
        &self,
        hits: &[TodoHit],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = cx.palette().clone();
        let editor_font = cx.lattice().fonts.editor.clone();
        let files = by_file(hits);
        let count = hits.len();
        let summary = div()
            .mb(px(8.))
            .flex()
            .flex_wrap()
            .gap_x(px(6.))
            .text_role(TextRole::Subtitle, cx)
            .text_color(palette.text)
            .font_features(tabular_nums())
            .children(lattice_ui::parity::probe("todos/summary"))
            .child(if count == 1 {
                t!("{count} marker", count = count)
            } else {
                t!("{count} markers", count = count)
            })
            .when(files.len() > 1, |summary| {
                summary.child(
                    div()
                        .text_color(palette.text_secondary)
                        .font_weight(FONT_WEIGHT_REGULAR)
                        .child(t!("in {0} files", files.len())),
                )
            });
        // One fill for every row of every file, as the Tauri app's surface
        // spans the whole list (`follow={null}`: the keys do not move it).
        let hover = FluidHover::new("todos-hover", window, cx)
            .fill(palette.hover)
            .radius(lattice_ui::shape::RADIUS_TARGET);
        let mut index = 0;
        let mut first_row = true;
        let groups: Vec<AnyElement> = files
            .into_iter()
            .enumerate()
            .map(|(group, (path, hits))| {
                let head = div()
                    .min_w_0()
                    .mb(px(4.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_role(TextRole::Caption, cx)
                    .font_weight(FONT_WEIGHT_MEDIUM)
                    .text_color(palette.text_secondary)
                    .when(group == 0, |head| {
                        head.children(lattice_ui::parity::probe("todos/file"))
                    })
                    .child(Icon::FILE_TEXT.element(px(13.), palette.text_secondary))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .child(path.clone()),
                    )
                    .child(
                        div()
                            .flex_none()
                            .ml_auto()
                            .font_features(tabular_nums())
                            .child(hits.len().to_string()),
                    );
                let rows = hits.into_iter().map(|hit| {
                    let danger = matches!(hit.kind.to_ascii_lowercase().as_str(), "fixme" | "xxx");
                    let (chip_bg, chip_ink) = if danger {
                        (palette.danger_soft, palette.danger)
                    } else {
                        (palette.accent_soft, palette.accent)
                    };
                    let (path, line) = (hit.path.clone(), hit.line);
                    let row = div()
                        .id(SharedString::from(format!(
                            "todo-hit-{}-{}-{}",
                            hit.path, hit.line, hit.kind
                        )))
                        .relative()
                        .w_full()
                        .px(px(10.))
                        .py(px(8.))
                        .rounded(RADIUS_CONTROL)
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .cursor_pointer()
                        .when(first_row, |row| {
                            row.children(lattice_ui::parity::probe("todos/hit"))
                        })
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(TodosEvent::Open {
                                path: path.clone(),
                                line,
                            })
                        }))
                        .child(
                            div()
                                .flex()
                                .items_baseline()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .flex_none()
                                        .px(px(6.))
                                        .rounded(RADIUS_COMPACT)
                                        .bg(chip_bg)
                                        .text_color(chip_ink)
                                        .font_family(editor_font.clone())
                                        .text_size(
                                            TextRole::Micro.font_size(TypeScale::Interface, cx),
                                        )
                                        .line_height(
                                            TextRole::Caption.leading(TypeScale::Interface),
                                        )
                                        .font_weight(FONT_WEIGHT_SEMIBOLD)
                                        .whitespace_nowrap()
                                        .child(kind_label(&hit.kind)),
                                )
                                .child(
                                    div()
                                        .ml_auto()
                                        .text_role(TextRole::Caption, cx)
                                        .text_color(palette.text_secondary)
                                        .font_features(tabular_nums())
                                        .whitespace_nowrap()
                                        .child(t!("Line {0}", hit.line)),
                                ),
                        )
                        .child(
                            div()
                                .min_w_0()
                                .text_color(palette.text)
                                .font_family(editor_font.clone())
                                .text_size(TextRole::Caption.font_size(TypeScale::Interface, cx))
                                .line_height(TextRole::Caption.leading(TypeScale::Interface))
                                .line_clamp(2)
                                .child(hit.preview.clone()),
                        );
                    first_row = false;
                    let item = hover.item(index, row);
                    index += 1;
                    item
                });
                div()
                    .min_w_0()
                    .child(head)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .children(rows.collect::<Vec<_>>()),
                    )
                    .into_any_element()
            })
            .collect();
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(summary)
            .child(
                // Rows reach into the panel's inset so their text lines up
                // with the count.
                div()
                    .relative()
                    .mx(px(-10.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(hover.highlight())
                    .children(groups),
            )
            .into_any_element()
    }
}

impl Focusable for TodosPanel {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl BasePanel for TodosPanel {
    fn panel_name(&self) -> &'static str {
        "TodosPanel"
    }

    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl Panel for TodosPanel {
    /// The tab's title, as Trellis names the tool (`trellis-titles.ts`).
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(t!("TODOs").into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        t!("TODOs")
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, line: u32, kind: &str) -> TodoHit {
        TodoHit {
            path: path.into(),
            line,
            kind: kind.into(),
            preview: String::new(),
        }
    }

    #[test]
    fn hits_gather_under_their_file_in_scan_order() {
        let hits = [
            hit("main.tex", 3, "TODO"),
            hit("intro.tex", 1, "FIXME"),
            hit("main.tex", 9, "todo"),
        ];
        let files = by_file(&hits);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "main.tex");
        assert_eq!(
            files[0].1.iter().map(|hit| hit.line).collect::<Vec<_>>(),
            [3, 9]
        );
        assert_eq!(files[1].0, "intro.tex");
        assert_eq!(kind_label("todo"), "\\todo");
        assert_eq!(kind_label("FIXME"), "FIXME");
    }
}
