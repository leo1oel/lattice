//! A paper dragged out of the Papers list, as the Tauri app's rows start one
//! (`draggable` on `.paper-row`, `beginPaperDrag` in
//! `src/papers/paper-drag.ts`): what it carries, and how it looks under the
//! pointer.
//!
//! - The drag carries the paper's identity in its project (the root, the
//!   arXiv id and the citation key); where it lands looks the paper up in
//!   the library as it is then (`resolvePaperDrag`), never trusting the
//!   metadata the drag started with.
//! - Under the pointer is the row itself, as WebKit's drag image of a
//!   dragged element is: its glyph, title and byline at the place the press
//!   took it, on no fill of its own, translucent.
//! - A LaTeX or Markdown source cites it at the drop (`citation`,
//!   `editor_panel/papers.rs`); a Markdown file's visual editor takes it as an
//!   `@key` citation through its page (`md:paper-drag`).

use gpui::{
    App, AppContext as _, Context, IntoElement, ParentElement as _, Pixels, Render, Stateful,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_core::papers::PaperSummary;
use lattice_ui::{ActiveLattice as _, TextRole, TextRoleStyle as _};

use super::{PapersPanel, model};

pub mod citation;

/// WebKit draws an element's drag image at this opacity.
const DRAG_IMAGE_OPACITY: f32 = 0.75;

/// A paper on its way to an editor.
#[derive(Clone, Debug)]
pub struct DraggedPaper {
    /// The project the paper is in, as its Papers panel reads it.
    pub project_root: String,
    pub arxiv_id: String,
    pub citation_key: Option<String>,
    /// The row as it was when the drag started, for its preview.
    paper: PaperSummary,
    width: Pixels,
}

impl DraggedPaper {
    /// The paper this drag carries in `papers`, the library of the project
    /// at `project_root` as it is now: none for another project's paper, or
    /// one the library no longer holds.
    pub fn resolve<'a>(
        &self,
        project_root: &str,
        papers: &'a [PaperSummary],
    ) -> Option<&'a PaperSummary> {
        if self.project_root != project_root {
            return None;
        }
        papers.iter().find(|paper| {
            paper.arxiv_id == self.arxiv_id && paper.citation_key == self.citation_key
        })
    }

    /// The identity the Markdown page resolves against its own library
    /// (`PaperDrag`).
    pub fn identity(&self) -> serde_json::Value {
        serde_json::json!({
            "projectRoot": self.project_root,
            "arxivId": self.arxiv_id,
            "citationKey": self.citation_key,
        })
    }

    /// Whether a paper is being dragged now.
    pub fn dragging(cx: &App) -> bool {
        cx.has_active_drag_of::<Self>()
    }
}

/// What the dragged row looks like under the pointer.
struct DragPreview(DraggedPaper);

impl Render for DragPreview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let paper = &self.0.paper;
        let byline = [
            model::short_authors(paper),
            paper
                .year
                .as_deref()
                .map(str::trim)
                .filter(|year| !year.is_empty())
                .map(str::to_string),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("  ");
        div()
            .w(self.0.width)
            .flex()
            .flex_col()
            .px(px(8.))
            .py(px(10.))
            .opacity(DRAG_IMAGE_OPACITY)
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(6.))
                    .min_w_0()
                    .child(super::row::glyph(paper, None, &palette, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_role(TextRole::Body, cx)
                            .line_height(px(18.))
                            .text_color(palette.text)
                            .line_clamp(2)
                            .child(paper.title.clone()),
                    ),
            )
            .when(!byline.is_empty(), |preview| {
                preview.child(
                    div()
                        .mt(px(4.))
                        .pl(px(22.))
                        .h(px(16.))
                        .min_w_0()
                        .truncate()
                        .text_role(TextRole::Caption, cx)
                        .text_color(palette.text_secondary)
                        .child(byline),
                )
            })
    }
}

impl PapersPanel {
    /// The row of the paper titled `title`, as last laid out, for a scenario
    /// to drag it.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn row_bounds(&self, title: &str, cx: &App) -> Option<gpui::Bounds<Pixels>> {
        let shown = self.shown(cx);
        let sections = model::group(shown, self.group, &self.facts);
        let index = sections
            .iter()
            .flat_map(|section| section.papers.iter())
            .position(|paper| paper.title == title)?;
        let snapshot = self.hover.as_ref()?.snapshot(cx);
        snapshot
            .rows
            .iter()
            .find(|(row, ..)| *row == index)
            .map(|(_, bounds, _)| *bounds)
    }

    /// `row` as a drag source of `paper`, `width` wide as drawn.
    pub(super) fn paper_drag_source(
        &self,
        row: Stateful<gpui::Div>,
        paper: &PaperSummary,
        width: f32,
    ) -> Stateful<gpui::Div> {
        let Some(root) = self.root.as_ref() else {
            return row;
        };
        let dragged = DraggedPaper {
            project_root: root.to_string_lossy().into_owned(),
            arxiv_id: paper.arxiv_id.clone(),
            citation_key: paper.citation_key.clone(),
            paper: paper.clone(),
            width: px(width),
        };
        row.on_drag(dragged, |dragged, _, _, cx| {
            cx.new(|_| DragPreview(dragged.clone()))
        })
    }
}
