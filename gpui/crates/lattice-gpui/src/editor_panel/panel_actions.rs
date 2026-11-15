//! The panel's own keys, beside the LaTeX source's (`latex_format.rs`): an
//! HTML file's Edit, Split and Preview and every `.tex` file's Source and
//! Visual (`views.rs`, `latex_view.rs`), Find next and previous
//! (`find_bar.rs`, or the Visual page's own find), and the Proofread, Polish
//! and Rewrite asks (`proofread.rs`).

use gpui::{Context, InteractiveElement as _};

use super::{DocumentView, EditorPanel, choose_latex_view, find_bar, proofread};

gpui::actions!(
    lattice_document,
    [
        /// Show an HTML file's source ("Edit").
        ViewSource,
        /// Show an HTML file's source beside its preview.
        ViewSplit,
        /// Show an HTML file's preview alone.
        ViewPreview,
    ]
);

gpui::actions!(
    lattice_editor_panel,
    [
        /// Every .tex file's Source view.
        ShowSourceView,
        /// Every .tex file's Visual view (`latex_view.rs`).
        ShowVisualView,
    ]
);

impl EditorPanel {
    /// Every key's handler, on the panel's element.
    pub(super) fn panel_actions(element: gpui::Div, cx: &mut Context<Self>) -> gpui::Div {
        element
            .on_action(
                cx.listener(|this, _: &proofread::ProofreadSelection, window, cx| {
                    this.proofread_action(
                        Some(lattice_editor::proofread::Ask::Proofread),
                        window,
                        cx,
                    )
                }),
            )
            .on_action(
                cx.listener(|this, _: &proofread::PolishSelection, window, cx| {
                    this.proofread_action(Some(lattice_editor::proofread::Ask::Polish), window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &proofread::RewriteSelection, window, cx| {
                    this.proofread_action(None, window, cx)
                }),
            )
            .on_action(cx.listener(|this, _: &find_bar::FindNext, window, cx| {
                if !this.find_in_latex_visual("next", window, cx) {
                    this.find_bar
                        .update(cx, |bar, cx| bar.step(false, window, cx))
                }
            }))
            .on_action(cx.listener(|this, _: &find_bar::FindPrevious, window, cx| {
                if !this.find_in_latex_visual("previous", window, cx) {
                    this.find_bar
                        .update(cx, |bar, cx| bar.step(true, window, cx))
                }
            }))
            .on_action(cx.listener(|this, _: &ViewSource, window, cx| {
                this.set_document_view(DocumentView::Source, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ViewSplit, window, cx| {
                this.set_document_view(DocumentView::Split, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ViewPreview, window, cx| {
                this.set_document_view(DocumentView::Preview, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ShowSourceView, _, cx| {
                if this.latex_view(cx).is_some() {
                    choose_latex_view(lattice_settings::LatexView::Source, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &ShowVisualView, _, cx| {
                if this.latex_view(cx).is_some() {
                    choose_latex_view(lattice_settings::LatexView::Visual, cx);
                }
            }))
    }
}
