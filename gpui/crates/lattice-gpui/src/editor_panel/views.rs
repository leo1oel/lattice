//! An HTML file's three views, as the Tauri app's file panel has them
//! (`src/app/document-view-modes.ts`, `trellis-header-tools.tsx`): Edit (the
//! source), Split (the source beside its preview) and Preview (the page
//! alone). Each HTML file keeps the view it was last shown in, Preview until
//! one is chosen; the switch rides in the panel's strip, and its ⋯ menu
//! repeats it.
//!
//! The preview is a webview island (`html_preview.rs`), made the first time
//! a view needs it and shown only while its panel is the displayed tab and
//! the view includes it: an island's page does not hide by not being drawn.

use std::{collections::HashMap, path::PathBuf};

use gpui::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    StatefulInteractiveElement as _, Styled as _, Window, div, px,
};
use lattice_ui::{ActiveLattice as _, Icon, components::Segmented};

use super::EditorPanel;
use crate::html_preview::{self, HtmlPreview, HtmlPreviewEvent};

/// The views of a readable document (`DocumentViewMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DocumentView {
    /// "Edit": the source.
    Source,
    Split,
    Preview,
}

impl DocumentView {
    pub const ALL: [DocumentView; 3] = [
        DocumentView::Source,
        DocumentView::Split,
        DocumentView::Preview,
    ];

    pub fn label(self) -> &'static str {
        match self {
            DocumentView::Source => "Edit",
            DocumentView::Split => "Split",
            DocumentView::Preview => "Preview",
        }
    }

    pub fn icon(self) -> Icon {
        match self {
            DocumentView::Source => Icon::PEN_LINE,
            DocumentView::Split => Icon::COLUMNS_2,
            DocumentView::Preview => Icon::EYE,
        }
    }

    fn previews(self) -> bool {
        self != DocumentView::Source
    }
}

/// Whether `path` is a document with views here: an HTML file
/// (`isHtmlFilePath`).
pub fn has_views(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
}

/// The view each HTML file was last shown in, this session.
#[derive(Default)]
struct RememberedViews(HashMap<PathBuf, DocumentView>);

impl gpui::Global for RememberedViews {}

fn remembered(path: &std::path::Path, cx: &App) -> DocumentView {
    cx.try_global::<RememberedViews>()
        .and_then(|views| views.0.get(path).copied())
        .unwrap_or(DocumentView::Preview)
}

/// The split's share for the source, as the Tauri app keeps one for every
/// document (`loadSplitRatio`: 0.46 until moved, within 0.2 to 0.8).
#[derive(Clone, Copy)]
struct SplitRatio(f32);

impl Default for SplitRatio {
    fn default() -> Self {
        Self(0.46)
    }
}

impl gpui::Global for SplitRatio {}

/// The split's columns: the source never under 240px nor the preview under
/// 280px while both fit, shrunk in proportion when they do not
/// (`splitGridTemplate`, `fitSplitMinimums`).
pub fn split_widths(width: f32, ratio: f32) -> (f32, f32) {
    const SOURCE_MIN: f32 = 240.;
    const PREVIEW_MIN: f32 = 280.;
    let tracks = (width - 1.).max(0.);
    let (source_min, preview_min) = if tracks >= SOURCE_MIN + PREVIEW_MIN {
        (SOURCE_MIN, PREVIEW_MIN)
    } else {
        let share = tracks / (SOURCE_MIN + PREVIEW_MIN);
        (SOURCE_MIN * share, PREVIEW_MIN * share)
    };
    let source = (tracks * ratio).clamp(source_min, (tracks - preview_min).max(source_min));
    (source, tracks - source)
}

/// What a drag of the split's divider carries.
#[derive(Clone)]
struct SplitDrag;

impl gpui::Render for SplitDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        gpui::Empty
    }
}

pub(super) struct DocumentViews {
    view: DocumentView,
    preview: Option<Entity<HtmlPreview>>,
    /// The panel is its group's displayed tab.
    shown: bool,
    /// The split's width as last laid out, for a drag of its divider.
    width: std::rc::Rc<std::cell::Cell<Pixels>>,
    divider_hovered: bool,
    dragging: bool,
    /// The view switch names its modes (room to spare in the strip).
    named: bool,
}

impl DocumentViews {
    pub fn new(path: &std::path::Path, cx: &App) -> Self {
        Self {
            view: remembered(path, cx),
            preview: None,
            shown: false,
            width: Default::default(),
            divider_hovered: false,
            dragging: false,
            named: false,
        }
    }

    pub fn view(&self) -> DocumentView {
        self.view
    }

    pub fn preview(&self) -> Option<&Entity<HtmlPreview>> {
        self.preview.as_ref()
    }
}

impl EditorPanel {
    /// The HTML file's preview, made the first time a view shows it.
    pub(super) fn ensure_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(views) = &self.views else {
            return;
        };
        if views.preview.is_some() || !views.view.previews() {
            return;
        }
        let root = self.project_root(cx);
        let relative = self.relative.clone();
        let source = self.buffer.read(cx).text();
        let state = html_preview::saved_view_state(&self.path, cx);
        let preview = cx.new(|cx| HtmlPreview::new(&root, relative, source, state, window, cx));
        let path = self.path.clone();
        self._subscriptions.push(cx.subscribe(
            &preview,
            move |_, _, event: &HtmlPreviewEvent, cx| match event {
                HtmlPreviewEvent::ViewState(state) => {
                    html_preview::save_view_state(&path, *state, cx)
                }
            },
        ));
        // The first text, at once: the page has nothing to wait for.
        preview.update(cx, |preview, cx| preview.publish_now(cx));
        if let Some(views) = &mut self.views {
            views.preview = Some(preview);
        }
    }

    /// Show the island while the panel is shown and the view includes it.
    fn sync_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_preview(window, cx);
        let Some(views) = &self.views else {
            return;
        };
        let active = views.shown && views.view.previews();
        if let Some(preview) = views.preview.clone() {
            preview.update(cx, |preview, cx| preview.set_active(active, cx));
        }
    }

    /// The panel became, or stopped being, its group's displayed tab.
    pub(super) fn views_shown(&mut self, shown: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(views) = &mut self.views {
            views.shown = shown;
            self.sync_preview(window, cx);
        }
    }

    /// The view the HTML file is shown in, for the scripted checks and the menu.
    pub fn document_view(&self) -> Option<DocumentView> {
        self.views.as_ref().map(|views| views.view)
    }

    pub fn html_preview(&self) -> Option<&Entity<HtmlPreview>> {
        self.views.as_ref().and_then(|views| views.preview.as_ref())
    }

    /// Show the file in `view`, and remember it for the file.
    pub fn set_document_view(
        &mut self,
        view: DocumentView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(views) = &mut self.views else {
            return;
        };
        if views.view == view {
            return;
        }
        views.view = view;
        cx.default_global::<RememberedViews>()
            .0
            .insert(self.path.clone(), view);
        self.sync_preview(window, cx);
        // Writing goes on in the source when it comes back.
        if view != DocumentView::Preview {
            window.focus(&self.editor.focus_handle(cx), cx);
        }
        lattice_webview::check_drawn_after_frame(window, cx);
        cx.notify();
    }

    /// The editor's text changed: the preview follows once typing settles.
    pub(super) fn views_source_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(preview) = self.views.as_ref().and_then(|views| views.preview.clone()) {
            let text = self.buffer.read(cx).text();
            preview.update(cx, |preview, cx| preview.set_source(text, cx));
        }
    }

    /// Files changed in the project: the preview loads its images again.
    pub(super) fn views_assets_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(preview) = self.views.as_ref().and_then(|views| views.preview.clone()) {
            preview.update(cx, |preview, cx| preview.assets_changed(cx));
        }
    }

    /// The Edit / Split / Preview switch, in the panel's strip: icons, each
    /// named in its tooltip, and named beside it too in room to spare.
    pub(super) fn view_switch(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let current = self.views.as_ref()?.view;
        // Named only in room to spare beside every tab at its natural width
        // (the Trellis patch's named state), judged from the strip as last
        // drawn: its spare room with the switch as it was, plus what names
        // took then, must hold the names.
        let extra: Pixels = DocumentView::ALL
            .iter()
            .map(|view| Segmented::name_room(view.label(), window, cx))
            .fold(px(0.), |sum, room| sum + room);
        let panel = gpui_kit::component::dock::PanelId::from(cx.entity().entity_id());
        let was_named = self.views.as_ref().is_some_and(|views| views.named);
        let named = lattice_ui::dock::strip_spare(panel, cx)
            .is_some_and(|spare| spare + if was_named { extra } else { px(0.) } >= extra);
        if let Some(views) = &mut self.views
            && views.named != named
        {
            views.named = named;
            // The strip measures the switch's new width next frame.
            cx.notify();
        }
        let mut switch = Segmented::new("document-view")
            .parity("html/views")
            .named(named);
        for view in DocumentView::ALL {
            let this = cx.entity().downgrade();
            switch = switch.icon_choice(
                view.icon(),
                view.label(),
                view == current,
                move |_, window, cx| {
                    this.update(cx, |panel, cx| panel.set_document_view(view, window, cx))
                        .ok();
                },
            );
        }
        Some(switch.into_any_element())
    }

    /// The panel's body: the editor over its status bar, and for a document
    /// with views, that beside or instead of its preview.
    fn end_split_drag(&mut self, cx: &mut Context<Self>) {
        if let Some(views) = &mut self.views
            && views.dragging
        {
            views.dragging = false;
            cx.notify();
        }
    }

    pub(super) fn render_views(
        &mut self,
        editor: AnyElement,
        status: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let source = div()
            .flex()
            .flex_col()
            .min_w_0()
            .min_h_0()
            .h_full()
            .child(div().flex_1().min_h_0().child(editor))
            .child(status);
        let Some(views) = self.views.as_ref() else {
            return source.size_full().into_any_element();
        };
        let preview = views.preview.clone();
        match (views.view, preview) {
            (DocumentView::Source, _) | (_, None) => source.size_full().into_any_element(),
            (DocumentView::Preview, Some(preview)) => {
                div().size_full().child(preview).into_any_element()
            }
            (DocumentView::Split, Some(preview)) => {
                let palette = cx.palette().clone();
                let width = views.width.clone();
                let ratio = cx.try_global::<SplitRatio>().copied().unwrap_or_default().0;
                let (source_width, _) = split_widths(f32::from(width.get()), ratio);
                let strong = views.divider_hovered || views.dragging;
                let measured = width.clone();
                div()
                    .id("document-split")
                    .size_full()
                    .flex()
                    .relative()
                    .child(
                        gpui::canvas(
                            move |bounds, _, _| measured.set(bounds.size.width),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .on_drag_move(cx.listener(
                        move |this, event: &DragMoveEvent<SplitDrag>, window, cx| {
                            let bounds = event.bounds;
                            let x = f32::from(event.event.position.x - bounds.left());
                            let tracks = (f32::from(bounds.size.width) - 1.).max(1.);
                            let ratio = (x / tracks).clamp(0.2, 0.8);
                            cx.set_global(SplitRatio(ratio));
                            if let Some(views) = &mut this.views {
                                views.dragging = true;
                            }
                            let _ = window;
                            cx.notify();
                        },
                    ))
                    .on_mouse_up(
                        gpui::MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.end_split_drag(cx)),
                    )
                    .on_mouse_up_out(
                        gpui::MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.end_split_drag(cx)),
                    )
                    .child(source.flex_none().w(px(source_width)))
                    // The divider: a 1px rule, a firmer one under the
                    // pointer or while dragged, with 4px to grab on each side
                    // (`.split-resizer`).
                    .child(
                        div()
                            .id("document-split-divider")
                            .flex_none()
                            .relative()
                            .w(px(1.))
                            .h_full()
                            .bg(if strong {
                                palette.line_strong
                            } else {
                                palette.line
                            })
                            .child(
                                div()
                                    .id("document-split-grip")
                                    .absolute()
                                    .top_0()
                                    .bottom_0()
                                    .left(px(-4.))
                                    .w(px(9.))
                                    .cursor_col_resize()
                                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                                        if let Some(views) = &mut this.views {
                                            views.divider_hovered = *hovered;
                                        }
                                        cx.notify();
                                    }))
                                    .on_drag(SplitDrag, |drag, _, _, cx| cx.new(|_| drag.clone())),
                            ),
                    )
                    .child(div().flex_1().min_w_0().h_full().child(preview))
                    .into_any_element()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_split_keeps_both_minimums_while_they_fit() {
        let (source, preview) = split_widths(1001., 0.46);
        assert_eq!(source, 460.);
        assert_eq!(preview, 540.);
        // Dragged far left: the source keeps 240px.
        assert_eq!(split_widths(1001., 0.05).0, 240.);
        // Far right: the preview keeps 280px.
        assert_eq!(split_widths(1001., 0.95).1, 280.);
    }

    #[test]
    fn a_narrow_split_shrinks_both_minimums_in_proportion() {
        let (source, preview) = split_widths(261., 0.05);
        assert!((source - 120.).abs() < 0.01, "{source}");
        assert!((preview - 140.).abs() < 0.01, "{preview}");
    }

    #[test]
    fn only_html_files_have_views() {
        assert!(has_views(std::path::Path::new("a/b/page.HTML")));
        assert!(!has_views(std::path::Path::new("main.tex")));
    }
}
