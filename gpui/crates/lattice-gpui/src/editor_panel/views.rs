//! An HTML, Markdown or `.bib` file's three views, as the Tauri app's file
//! panel has them (`src/app/document-view-modes.ts`,
//! `trellis-header-tools.tsx`): Edit (the source), Split (the source beside
//! its preview) and Preview (the preview alone). Each HTML file keeps the
//! view it was last shown in, Preview until one is chosen; Markdown files
//! share one, Split until one is chosen (`documentModeRef`); every `.bib`
//! file opens in the view a bibliography was last shown in, Edit at first
//! (`bib_view.rs`). The switch rides in the panel's strip, and its ⋯ menu
//! repeats it.
//!
//! An HTML file's preview is its page (`html_preview.rs`); a Markdown file's
//! is its visual editor (`markdown_view.rs`), as Markdown's Preview is in the
//! Tauri app. Each is a webview island, made the first time a view needs it
//! and shown only while its panel is the displayed tab and the view includes
//! it: an island's page does not hide by not being drawn. A bibliography's
//! is its reference list, which `bib_view.rs` owns.

use std::{collections::HashMap, path::PathBuf};

use gpui::{
    AnyElement, App, AppContext as _, Context, DragMoveEvent, Entity, Focusable as _,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels,
    StatefulInteractiveElement as _, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use lattice_ui::{ActiveLattice as _, Icon, components::Segmented};

use super::EditorPanel;
use crate::{
    html_preview::{self, HtmlPreview, HtmlPreviewEvent},
    structured::StructuredDocument,
};

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
/// (`isHtmlFilePath`), a Markdown file (`panelViewMode`'s `.md`) or a
/// bibliography (`isBibFilePath`).
pub fn has_views(path: &std::path::Path) -> bool {
    is_html(path)
        || lattice_editor::markdown::is_markdown(path)
        || super::bib_view::is_bib_path(path)
}

fn is_html(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
}

/// The view each HTML file was last shown in, this session.
#[derive(Default)]
struct RememberedViews(HashMap<PathBuf, DocumentView>);

impl gpui::Global for RememberedViews {}

/// The view Markdown files were last shown in, this session: one for all of
/// them, Split until one is chosen (`documentModeRef`).
struct MarkdownView(DocumentView);

impl gpui::Global for MarkdownView {}

fn remembered(path: &std::path::Path, cx: &App) -> DocumentView {
    if super::bib_view::is_bib_path(path) {
        return super::bib_view::remembered_bib_view(cx);
    }
    if !is_html(path) {
        return cx
            .try_global::<MarkdownView>()
            .map_or(DocumentView::Split, |view| view.0);
    }
    cx.try_global::<RememberedViews>()
        .and_then(|views| views.0.get(path).copied())
        .unwrap_or(DocumentView::Preview)
}

fn remember(path: &std::path::Path, view: DocumentView, cx: &mut App) {
    if super::bib_view::is_bib_path(path) {
        super::bib_view::remember_bib_view(view, cx);
    } else if is_html(path) {
        cx.default_global::<RememberedViews>()
            .0
            .insert(path.to_path_buf(), view);
    } else {
        cx.set_global(MarkdownView(view));
    }
}

/// What a document's Split and Preview show.
#[derive(Clone)]
pub enum Preview {
    /// An HTML file's page.
    Html(Entity<HtmlPreview>),
    /// A Markdown file's visual editor.
    Markdown(Entity<StructuredDocument>),
}

impl Preview {
    fn element(&self) -> AnyElement {
        match self {
            Preview::Html(preview) => preview.clone().into_any_element(),
            Preview::Markdown(document) => document.clone().into_any_element(),
        }
    }

    pub fn focus_handle(&self, cx: &App) -> Option<gpui::FocusHandle> {
        match self {
            Preview::Html(preview) => Some(preview.read(cx).island().focus_handle(cx)),
            Preview::Markdown(document) => document.read(cx).focus_handle(cx),
        }
    }
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
    preview: Option<Preview>,
    /// The panel is its group's displayed tab.
    shown: bool,
    /// The split's width as last laid out, for a drag of its divider.
    width: std::rc::Rc<std::cell::Cell<Pixels>>,
    divider_hovered: bool,
    dragging: bool,
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
        }
    }

    pub fn view(&self) -> DocumentView {
        self.view
    }

    pub fn preview(&self) -> Option<&Preview> {
        self.preview.as_ref()
    }
}

impl EditorPanel {
    /// The document's preview, made the first time a view shows it.
    pub(super) fn ensure_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(views) = &self.views else {
            return;
        };
        // A bibliography's preview is its own (`bib_for_view`).
        if self.is_bib() || views.preview.is_some() || !views.view.previews() {
            return;
        }
        let preview = if is_html(&self.path) {
            Preview::Html(self.new_html_preview(window, cx))
        } else {
            Preview::Markdown(self.new_markdown_document(window, cx))
        };
        if let Some(views) = &mut self.views {
            views.preview = Some(preview);
        }
    }

    fn new_html_preview(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<HtmlPreview> {
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
        preview
    }

    /// Show the island while the panel is shown and the view includes it.
    fn sync_preview(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.ensure_preview(window, cx);
        let Some(views) = &self.views else {
            return;
        };
        let active = views.shown && views.view.previews();
        let split = views.view == DocumentView::Split;
        match views.preview.clone() {
            Some(Preview::Html(preview)) => {
                preview.update(cx, |preview, cx| preview.set_active(active, cx))
            }
            Some(Preview::Markdown(document)) => document.update(cx, |document, cx| {
                document.set_split(split, cx);
                document.set_shown(active, cx);
            }),
            None => {}
        }
    }

    /// The panel became, or stopped being, its group's displayed tab.
    pub(super) fn views_shown(&mut self, shown: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(views) = &mut self.views {
            views.shown = shown;
            self.sync_preview(window, cx);
        }
    }

    /// The view the document is shown in, for the scripted checks and the menu.
    pub fn document_view(&self) -> Option<DocumentView> {
        self.views.as_ref().map(|views| views.view)
    }

    pub fn html_preview(&self) -> Option<&Entity<HtmlPreview>> {
        match self.views.as_ref()?.preview.as_ref()? {
            Preview::Html(preview) => Some(preview),
            Preview::Markdown(_) => None,
        }
    }

    /// A Markdown file's visual editor, once a view has shown it.
    pub fn markdown_document(&self) -> Option<&Entity<StructuredDocument>> {
        match self.views.as_ref()?.preview.as_ref()? {
            Preview::Markdown(document) => Some(document),
            Preview::Html(_) => None,
        }
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
        remember(&self.path, view, cx);
        self.sync_preview(window, cx);
        // Writing goes on in the source when it comes back.
        if view != DocumentView::Preview {
            window.focus(&self.editor.focus_handle(cx), cx);
        }
        self.bib_view_chosen(view, window, cx);
        lattice_webview::check_drawn_after_frame(window, cx);
        cx.notify();
    }

    /// The editor's text changed: the preview follows once typing settles.
    pub(super) fn views_source_changed(&mut self, cx: &mut Context<Self>) {
        let text = self.buffer.read(cx).text();
        match self.views.as_ref().and_then(|views| views.preview.clone()) {
            Some(Preview::Html(preview)) => {
                preview.update(cx, |preview, cx| preview.set_source(text, cx))
            }
            Some(Preview::Markdown(document)) => {
                document.update(cx, |document, cx| document.set_source(text, cx))
            }
            None => {}
        }
    }

    /// Files changed in the project: the preview loads its images again.
    pub(super) fn views_assets_changed(&mut self, cx: &mut Context<Self>) {
        // A Markdown file's visual editor follows the project itself.
        if let Some(preview) = self.html_preview().cloned() {
            preview.update(cx, |preview, cx| preview.assets_changed(cx));
        }
    }

    /// The Edit / Split / Preview switch, in the panel's strip: icons, each
    /// named in its tooltip. The Tauri app also names them beside the icons
    /// in room to spare (the Trellis patch's named state); the Trellis skin
    /// does not report a strip's spare room yet, so they stay icons.
    pub(super) fn view_switch(
        &mut self,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let current = self.views.as_ref()?.view;
        let mut switch = Segmented::new("document-view").parity(if is_html(&self.path) {
            "html/views"
        } else if self.is_bib() {
            "bib/views"
        } else {
            "markdown/views"
        });
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

    /// The split's drag ended, wherever the button came up.
    fn end_split_drag(&mut self, cx: &mut Context<Self>) {
        if let Some(views) = &mut self.views
            && views.dragging
        {
            views.dragging = false;
            cx.notify();
        }
    }

    /// The panel's body: the editor over its status bar, and for a document
    /// with views, that beside or instead of its preview (`bib`, a
    /// bibliography's references, or else the HTML file's page).
    pub(super) fn render_views(
        &mut self,
        editor: AnyElement,
        status: AnyElement,
        bib: Option<AnyElement>,
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
        let preview = bib.or_else(|| views.preview.as_ref().map(Preview::element));
        match (views.view, preview) {
            (DocumentView::Source, _) | (_, None) => source.size_full().into_any_element(),
            (DocumentView::Preview, Some(preview)) => {
                div().size_full().child(preview).into_any_element()
            }
            (DocumentView::Split, Some(preview)) => {
                let palette = cx.palette().clone();
                let width = views.width.clone();
                let ratio = cx.try_global::<SplitRatio>().copied().unwrap_or_default().0;
                let (source_width, preview_width) = split_widths(f32::from(width.get()), ratio);
                let measured_once = width.get() > px(0.);
                let strong = views.divider_hovered || views.dragging;
                let measured = width.clone();
                let panel = cx.entity().downgrade();
                div()
                    .id("document-split")
                    .size_full()
                    .flex()
                    .relative()
                    .child(
                        // A new width draws again: the first frame of a split
                        // has no width yet, and lays its columns out on none.
                        gpui::canvas(
                            move |bounds, _, cx| {
                                if measured.get() != bounds.size.width {
                                    measured.set(bounds.size.width);
                                    let panel = panel.clone();
                                    cx.defer(move |cx| {
                                        panel.update(cx, |_, cx| cx.notify()).ok();
                                    });
                                }
                            },
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
                    // The preview's own width, as the source has: a column
                    // only stretched to fill leaves wrapped text (a
                    // bibliography's) without a width to wrap at.
                    .child(
                        div()
                            .min_w_0()
                            .h_full()
                            .when(measured_once, |column| {
                                column.flex_none().w(px(preview_width))
                            })
                            .when(!measured_once, |column| column.flex_1())
                            .child(preview),
                    )
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
    fn html_markdown_and_bib_files_have_views() {
        assert!(has_views(std::path::Path::new("a/b/page.HTML")));
        assert!(has_views(std::path::Path::new("notes/README.md")));
        assert!(has_views(std::path::Path::new("references.bib")));
        assert!(!has_views(std::path::Path::new("main.tex")));
    }
}
