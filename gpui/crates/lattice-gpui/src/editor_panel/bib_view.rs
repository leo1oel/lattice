//! A `.bib` file's views (`trellis-header-tools.tsx`, `bib-preview.tsx`):
//! Edit, the source alone; Split, the source beside its visual form, the
//! list following the reference under the caret and a reference picked in
//! the list shown in the source; Preview, the visual form alone. The switch
//! sits in the tab strip before the build chip; the view last chosen is the
//! one the next bibliography opens in, as the Tauri app remembers one view
//! for every bibliography (Edit at first).

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, Global, IntoElement,
    ParentElement as _, Styled as _, Window, div, px,
};
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, components::Segmented};

use super::{EditorPanel, EditorPanelEvent};
use crate::papers::{
    PapersPanel,
    bib_editor::{BibEditor, BibEditorEvent},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BibView {
    #[default]
    Source,
    Split,
    Preview,
}

/// The view the next bibliography opens in.
#[derive(Default)]
struct RememberedBibView(BibView);

impl Global for RememberedBibView {}

impl EditorPanel {
    pub(super) fn is_bib(&self) -> bool {
        self.path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("bib"))
    }

    pub(super) fn remembered_bib_view(&self, cx: &App) -> BibView {
        if !self.is_bib() {
            return BibView::Source;
        }
        cx.try_global::<RememberedBibView>()
            .map_or(BibView::Source, |remembered| remembered.0)
    }

    /// The library a bibliography's references open their papers from.
    pub fn set_papers(&mut self, papers: Entity<PapersPanel>, cx: &mut Context<Self>) {
        if let Some(bib) = &self.bib {
            bib.update(cx, |bib, cx| bib.set_papers(papers.clone(), cx));
        }
        self.papers = Some(papers);
    }

    /// The `.bib` file's visual form, when it is showing.
    pub fn bib_editor(&self) -> Option<&Entity<BibEditor>> {
        self.bib
            .as_ref()
            .filter(|_| self.bib_view != BibView::Source)
    }

    pub fn bib_view(&self) -> BibView {
        self.bib_view
    }

    pub fn set_bib_view(&mut self, view: BibView, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_bib() {
            return;
        }
        self.bib_view = view;
        cx.set_global(RememberedBibView(view));
        match view {
            BibView::Preview => {
                let bib = self.ensure_bib(window, cx);
                window.focus(&bib.focus_handle(cx), cx);
            }
            BibView::Split => {
                let line = self.cursor.0;
                let bib = self.ensure_bib(window, cx);
                bib.update(cx, |bib, cx| bib.follow_line(line, cx));
            }
            BibView::Source => window.focus(&self.editor.focus_handle(cx), cx),
        }
        cx.notify();
    }

    fn ensure_bib(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Entity<BibEditor> {
        if let Some(bib) = &self.bib {
            return bib.clone();
        }
        let root = self.project.read(cx).root().to_path_buf();
        let (relative, buffer) = (self.relative.clone(), self.buffer.clone());
        let bib = cx.new(|cx| BibEditor::new(root, relative, buffer, window, cx));
        if let Some(papers) = self.papers.clone() {
            bib.update(cx, |bib, cx| bib.set_papers(papers, cx));
        }
        cx.subscribe_in(&bib, window, |this, _, event, window, cx| match event {
            BibEditorEvent::OpenLine { path, line } => {
                if *path == this.relative {
                    // The source of this file: beside the list, unless only
                    // the source is showing.
                    if this.bib_view == BibView::Preview {
                        this.set_bib_view(BibView::Split, window, cx);
                    }
                    this.go_to_line(*line, window, cx);
                } else {
                    cx.emit(EditorPanelEvent::OpenLocation {
                        path: path.clone(),
                        line: *line,
                    });
                }
            }
            BibEditorEvent::Picked { line } => {
                if this.bib_view == BibView::Split {
                    this.show_line(*line, window, cx);
                }
            }
        })
        .detach();
        self.bib = Some(bib.clone());
        bib
    }

    /// The caret moved to `line`: the list beside the source follows it.
    pub(super) fn bib_follow_caret(&mut self, line: u32, cx: &mut Context<Self>) {
        if self.bib_view == BibView::Split
            && let Some(bib) = &self.bib
        {
            bib.update(cx, |bib, cx| bib.follow_line(line, cx));
        }
    }

    /// The body: the source, the visual form, or both side by side.
    pub(super) fn render_body(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let source = div()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(self.lattice.clone());
        match self.bib_view {
            BibView::Source => source.into_any_element(),
            BibView::Preview => {
                let bib = self.ensure_bib(window, cx);
                div().flex_1().min_h_0().child(bib).into_any_element()
            }
            BibView::Split => {
                let bib = self.ensure_bib(window, cx);
                let palette = cx.palette().clone();
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(source)
                    .child(div().flex_none().w(px(1.)).h_full().bg(palette.line))
                    .child(div().flex_1().min_w_0().min_h_0().child(bib))
                    .into_any_element()
            }
        }
    }

    /// Edit, Split and Preview, for a `.bib` file.
    pub(super) fn bib_switch(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.is_bib() {
            return None;
        }
        let view = self.bib_view;
        let entity = cx.entity().downgrade();
        let choose = move |target: BibView| {
            let entity = entity.clone();
            move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
                entity
                    .update(cx, |this, cx| this.set_bib_view(target, window, cx))
                    .ok();
            }
        };
        Some(
            Segmented::new("bib-view-switch")
                .label(t!("Edit"), view == BibView::Source, choose(BibView::Source))
                .label(t!("Split"), view == BibView::Split, choose(BibView::Split))
                .label(
                    t!("Preview"),
                    view == BibView::Preview,
                    choose(BibView::Preview),
                )
                .into_any_element(),
        )
    }
}
