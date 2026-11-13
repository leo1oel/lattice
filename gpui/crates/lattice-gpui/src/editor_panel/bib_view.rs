//! A `.bib` file's views (`trellis-header-tools.tsx`, `bib-preview.tsx`):
//! Edit, the source alone; Split, the source beside its visual form, the
//! list following the reference under the caret and a reference picked in
//! the list shown in the source; Preview, the visual form alone. The switch
//! sits in the tab strip before the build chip, in room to spare; the view last chosen is the
//! one the next bibliography opens in, as the Tauri app remembers one view
//! for every bibliography (Edit at first).

use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Div, Entity, Focusable as _, Global,
    InteractiveElement as _, IntoElement, ParentElement as _, Styled as _, WeakEntity, Window, div,
    px,
};
use gpui_kit::component::menu::PopupMenu;
use lattice_i18n::t;
use lattice_ui::{ActiveLattice as _, Icon, components::ViewSwitch, dock::SpareTools};

use super::{EditorPanel, EditorPanelEvent};
use crate::papers::{
    PapersPanel,
    bib_editor::{BibEditor, BibEditorEvent},
};

gpui::actions!(
    lattice_bib_view,
    [
        /// A `.bib` file's source alone.
        ShowBibEdit,
        /// A `.bib` file's source beside its visual form.
        ShowBibSplit,
        /// A `.bib` file's visual form alone.
        ShowBibPreview,
    ]
);

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
            .flex()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .child(self.render_source(window, cx));
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

    /// Edit, Split and Preview, for a `.bib` file: the strip shows them in
    /// room to spare, before the build chip, as the Tauri header folds them
    /// away when short of room; the ⋯ menu repeats them (`bib_menu`).
    pub(super) fn bib_spare_tools(&self, cx: &mut Context<Self>) -> Option<SpareTools> {
        if !self.is_bib() {
            return None;
        }
        let entity = cx.entity().downgrade();
        Some(SpareTools {
            width: Rc::new(|window, cx| {
                let names = [t!("Edit"), t!("Split"), t!("Preview")];
                let names: Vec<&str> = names.iter().map(|name| name.as_ref()).collect();
                ViewSwitch::width(&names, true, window, cx)
            }),
            render: Rc::new(move |_, cx| {
                let view = entity
                    .upgrade()
                    .map(|entity| entity.read(cx).bib_view)
                    .unwrap_or_default();
                bib_switch(entity.clone(), view, cx).into_any_element()
            }),
        })
    }

    /// The ⋯ menu's Edit, Split and Preview, for when the strip is short of
    /// room for the switch.
    pub(super) fn bib_menu(&self, menu: PopupMenu) -> PopupMenu {
        if !self.is_bib() {
            return menu;
        }
        let view = self.bib_view;
        menu.separator()
            .menu_with_check(t!("Edit"), view == BibView::Source, Box::new(ShowBibEdit))
            .menu_with_check(t!("Split"), view == BibView::Split, Box::new(ShowBibSplit))
            .menu_with_check(
                t!("Preview"),
                view == BibView::Preview,
                Box::new(ShowBibPreview),
            )
    }

    /// The menu's actions, on the panel's root.
    pub(super) fn on_bib_actions(&self, root: Div, cx: &mut Context<Self>) -> Div {
        root.on_action(cx.listener(|this, _: &ShowBibEdit, window, cx| {
            this.set_bib_view(BibView::Source, window, cx)
        }))
        .on_action(cx.listener(|this, _: &ShowBibSplit, window, cx| {
            this.set_bib_view(BibView::Split, window, cx)
        }))
        .on_action(cx.listener(|this, _: &ShowBibPreview, window, cx| {
            this.set_bib_view(BibView::Preview, window, cx)
        }))
    }
}

/// The Tauri header's Edit / Split / Preview (`trellis-header-tools.tsx`).
fn bib_switch(entity: WeakEntity<EditorPanel>, view: BibView, cx: &App) -> impl IntoElement {
    let choose = move |target: BibView| {
        let entity = entity.clone();
        move |_: &gpui::ClickEvent, window: &mut Window, cx: &mut App| {
            entity
                .update(cx, |this, cx| this.set_bib_view(target, window, cx))
                .ok();
        }
    };
    ViewSwitch::new("bib-view-switch")
        .mode(
            Icon::PEN_LINE,
            t!("Edit"),
            view == BibView::Source,
            choose(BibView::Source),
        )
        .mode(
            Icon::COLUMNS_2,
            t!("Split"),
            view == BibView::Split,
            choose(BibView::Split),
        )
        .mode(
            Icon::EYE,
            t!("Preview"),
            view == BibView::Preview,
            choose(BibView::Preview),
        )
        .surface(cx.palette().editor)
}
