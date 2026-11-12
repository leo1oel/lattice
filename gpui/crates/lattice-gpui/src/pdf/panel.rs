//! The PDF in the dock: the project's live PDF in the PDF panel, and each
//! other root document's last PDF in a tab of its own
//! (`src/canvas/project-pdf-panel.tsx`, `root-pdf-tabs.tsx`).
//!
//! The live PDF follows the build: its diagnostics, SyncTeX and the separate
//! window are the build pipeline's. It can move into a window of its own
//! (`window.rs`); the panel then shows the way back, and everything the
//! shell asks of the live PDF (a new build, a jump into it) goes to the
//! window. A root document's tab shows the copy this machine last built of
//! it and jumps through that document's own SyncTeX map.

use std::path::PathBuf;

use gpui::{
    AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Point, Render, SharedString,
    Styled as _, Window, div, px,
};
use gpui_kit::component::{
    dock::{BasePanel, Panel, PanelEvent},
    menu::{PopupMenu, PopupMenuItem},
};
use lattice_core::latex::PdfSyncTarget;
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _, components::Button, dock::PANEL_RADIUS,
    icons::ICON_LARGE,
};

use super::{
    view::{PdfView, PdfViewEvent, ToolbarAction},
    window::PdfWindow,
};

/// Which PDF a panel shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PdfPanelKind {
    /// The build's PDF.
    Live,
    /// The last PDF built of another root document (project-relative).
    Root(String),
    /// A PDF of the project, opened from the tree as a document of its own.
    File(PathBuf),
}

/// What the panel tells the shell.
pub enum PdfEvent {
    /// A double-click at (`x`, `y`) PDF points from the top-left corner of
    /// page `page` (1-based) of `document`'s PDF (`None`: the live one):
    /// show its source.
    SourceAt {
        document: Option<String>,
        page: u32,
        x: f64,
        y: f64,
    },
    /// Reveal cursor in PDF, in `document`'s PDF (`None`: the live one).
    RevealCursor {
        document: Option<String>,
    },
    /// Build `document` (`None`: the project).
    Build {
        document: Option<String>,
    },
    /// An Outline row: open `path` at `line`, and show it in the PDF.
    Outline {
        path: String,
        line: u32,
    },
    /// The live PDF moved into its own window, or came back.
    Detached,
    Docked,
}

pub struct PdfPanel {
    focus_handle: FocusHandle,
    kind: PdfPanelKind,
    /// The workspace window the panel is in.
    home: AnyWindowHandle,
    view: Entity<PdfView>,
    /// The live PDF's separate window and the viewer in it.
    window: Option<(AnyWindowHandle, Entity<PdfView>)>,
    /// The PDF shown, which the window or the panel opens again when the
    /// live PDF moves between them.
    source: Option<PathBuf>,
    building: bool,
    /// The window's title: the PDF's and the project's names.
    title: SharedString,
    /// The live PDF's Outline, carried into its window.
    outline: Option<super::OutlineState>,
    _subscriptions: Vec<gpui::Subscription>,
}

impl PdfPanel {
    pub fn new(kind: PdfPanelKind, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let view = cx.new(|cx| PdfView::new(window, cx));
        let compiled = !matches!(kind, PdfPanelKind::File(_));
        let live = kind == PdfPanelKind::Live;
        view.update(cx, |view, cx| {
            // A compiled PDF reveals the cursor and builds; a project's PDF
            // file is only read.
            view.set_can_reveal(compiled, cx);
            view.set_build(compiled, false, cx);
            if live {
                view.set_action(Some(open_in_window()), cx);
            }
        });
        let subscription = cx.subscribe_in(&view, window, Self::on_view_event);
        Self {
            focus_handle: cx.focus_handle(),
            kind,
            home: window.window_handle(),
            view,
            window: None,
            source: None,
            building: false,
            title: "PDF".into(),
            outline: None,
            _subscriptions: vec![subscription],
        }
    }

    pub fn kind(&self) -> &PdfPanelKind {
        &self.kind
    }

    pub fn document(&self) -> Option<&str> {
        match &self.kind {
            PdfPanelKind::Root(document) => Some(document),
            PdfPanelKind::Live | PdfPanelKind::File(_) => None,
        }
    }

    /// The viewer the live PDF is in: the window's while it has one.
    pub fn live_view(&self) -> &Entity<PdfView> {
        self.window
            .as_ref()
            .map(|(_, view)| view)
            .unwrap_or(&self.view)
    }

    pub(super) fn home(&self) -> AnyWindowHandle {
        self.home
    }

    pub fn in_window(&self) -> bool {
        self.window.is_some()
    }

    #[cfg(target_os = "macos")]
    pub fn window_handle(&self) -> Option<AnyWindowHandle> {
        self.window.as_ref().map(|(handle, _)| *handle)
    }

    fn on_view_event(
        &mut self,
        _: &Entity<PdfView>,
        event: &PdfViewEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if matches!(self.kind, PdfPanelKind::File(_)) {
            return;
        }
        let document = self.document().map(str::to_string);
        match event {
            PdfViewEvent::SourceAt { page, x, y } => cx.emit(PdfEvent::SourceAt {
                document,
                page: *page,
                x: *x,
                y: *y,
            }),
            PdfViewEvent::RevealCursor => cx.emit(PdfEvent::RevealCursor { document }),
            PdfViewEvent::Build => cx.emit(PdfEvent::Build { document }),
            PdfViewEvent::Outline { path, line } => cx.emit(PdfEvent::Outline {
                path: path.clone(),
                line: *line,
            }),
            PdfViewEvent::Action => self.detach(window, cx),
        }
    }

    /// Show `path`, or show it again after a build, wherever the live PDF is.
    pub fn open(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.source = Some(path.clone());
        match &self.window {
            Some((handle, view)) => {
                let view = view.clone();
                handle
                    .update(cx, |_, window, cx| {
                        view.update(cx, |view, cx| view.open(path, window, cx))
                    })
                    .ok();
            }
            None => self.view.update(cx, |view, cx| view.open(path, window, cx)),
        }
        cx.notify();
    }

    /// Show nothing, for a project without a built PDF.
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.source = None;
        match &self.window {
            Some((handle, view)) => {
                let view = view.clone();
                handle
                    .update(cx, |_, window, cx| {
                        view.update(cx, |view, cx| view.close(window, cx))
                    })
                    .ok();
            }
            None => self.view.update(cx, |view, cx| view.close(window, cx)),
        }
        cx.notify();
    }

    /// A build is running, or has ended.
    pub fn set_building(&mut self, building: bool, cx: &mut Context<Self>) {
        self.building = building;
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_build(true, building, cx));
        }
        cx.notify();
    }

    /// The manuscript's outline for the live PDF's Outline button, wherever
    /// the live PDF is (`None`: no button).
    pub fn set_outline(&mut self, outline: Option<super::OutlineState>, cx: &mut Context<Self>) {
        self.outline = outline.clone();
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_outline(outline.clone(), cx));
        }
    }

    pub fn set_window_title(&mut self, title: SharedString) {
        self.title = title;
    }

    /// Mark `target` (a forward SyncTeX answer) in the live PDF, and bring
    /// its window forward when it has one.
    pub fn show_sync_target(&mut self, target: &PdfSyncTarget, cx: &mut Context<Self>) {
        self.live_view()
            .update(cx, |view, cx| view.show_sync_target(target, cx));
        if let Some((handle, _)) = &self.window {
            handle
                .update(cx, |_, window, _| window.activate_window())
                .ok();
        }
    }

    /// Move the live PDF into a window of its own: the window opens where it
    /// was last left for this project, at the place the panel showed.
    pub fn detach(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.kind != PdfPanelKind::Live || self.window.is_some() {
            return;
        }
        let place = self.view.read(cx).view_place();
        let source = self.source.clone();
        let owner = cx.entity().downgrade();
        let title = self.title.clone();
        let outline = self.outline.clone();
        match PdfWindow::open(owner, title, source, place, self.building, outline, cx) {
            Ok((handle, view)) => {
                // The panel's own viewer lets go of its pages.
                self.view.update(cx, |view, cx| view.close(window, cx));
                self.window = Some((handle, view));
                cx.emit(PdfEvent::Detached);
                cx.notify();
            }
            Err(error) => {
                log::error!("could not open the PDF window: {error:#}");
                crate::notices::error(
                    "Could not open the PDF in a new window",
                    format!("{error:#}"),
                    cx,
                );
            }
        }
    }

    /// Bring the live PDF back into its panel, at the place the window
    /// showed; the window closes (unless it is closing already).
    pub fn dock(&mut self, close_window: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((handle, view)) = self.window.take() else {
            return;
        };
        let place = view.read(cx).view_place();
        if close_window {
            handle
                .update(cx, |_, window, _| window.remove_window())
                .ok();
        }
        if let Some(source) = self.source.clone() {
            self.view.update(cx, |view, cx| {
                view.restore_place(place);
                view.open(source, window, cx)
            });
        }
        cx.emit(PdfEvent::Docked);
        cx.notify();
    }

    /// The window the live PDF is in was closed by the reader.
    pub(super) fn window_closed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dock(false, window, cx);
    }

    // ---- What scenarios read ------------------------------------------------

    pub fn sync_mark(&self, cx: &App) -> Option<(usize, bool)> {
        self.live_view().read(cx).sync_mark()
    }

    pub fn sync_mark_top(&self, cx: &App) -> Option<f32> {
        self.live_view().read(cx).sync_mark_top()
    }

    pub fn sync_mark_center(&self, cx: &App) -> Option<Point<Pixels>> {
        self.live_view().read(cx).sync_mark_center()
    }

    pub fn page_count(&self, cx: &App) -> usize {
        self.live_view().read(cx).page_count()
    }

    #[cfg(all(target_os = "macos", feature = "offscreen-shots"))]
    pub fn pages_drawn(&self, cx: &App) -> usize {
        self.live_view().read(cx).pages_drawn()
    }

    pub fn scroll_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        self.live_view()
            .clone()
            .update(cx, |view, cx| view.go_to_page(page, cx));
    }
}

impl PdfPanel {
    /// The tab's name: "PDF" for the live one, the PDF's file name for the
    /// others.
    fn name(&self) -> String {
        match &self.kind {
            PdfPanelKind::Live => "PDF".to_string(),
            PdfPanelKind::Root(document) => pdf_tab_label(document, &[]),
            PdfPanelKind::File(path) => path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "PDF".into()),
        }
    }
}

/// The live panel's toolbar action.
fn open_in_window() -> ToolbarAction {
    ToolbarAction {
        label: "Open in separate window".into(),
        icon: Icon::SQUARE_ARROW_OUT_UP_RIGHT,
    }
}

impl EventEmitter<PanelEvent> for PdfPanel {}
impl EventEmitter<PdfEvent> for PdfPanel {}

impl Focusable for PdfPanel {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        if self.window.is_some() {
            self.focus_handle.clone()
        } else {
            self.view.read(cx).focus_handle(cx)
        }
    }
}

impl BasePanel for PdfPanel {
    fn panel_name(&self) -> &'static str {
        match self.kind {
            PdfPanelKind::Live => "PdfPanel",
            PdfPanelKind::Root(_) => "RootPdfPanel",
            PdfPanelKind::File(_) => "FilePdfPanel",
        }
    }

    /// A root document's tab and a PDF file's close; the live PDF stays (the
    /// Panels menu hides it).
    fn closable(&self, _: &App) -> bool {
        !matches!(self.kind, PdfPanelKind::Live)
    }
}

impl Panel for PdfPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(self.name().into())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.name()
    }

    fn dropdown_menu(
        &mut self,
        menu: PopupMenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> PopupMenu {
        let view = self.live_view().clone();
        let zoom = |label: &'static str, direction: f32| {
            let view = view.downgrade();
            PopupMenuItem::new(label).on_click(move |_, _, cx| {
                view.update(cx, |view, cx| view.step_zoom(direction, cx))
                    .ok();
            })
        };
        let menu = menu.item(zoom("Zoom in", 1.)).item(zoom("Zoom out", -1.));
        let fit = {
            let view = view.downgrade();
            PopupMenuItem::new("Fit width").on_click(move |_, _, cx| {
                view.update(cx, |view, cx| {
                    if view.fit() != Some(super::layout::FitMode::Width) {
                        view.toggle_fit(super::layout::FitMode::Width, cx)
                    }
                })
                .ok();
            })
        };
        let menu = menu.item(fit);
        match &self.kind {
            PdfPanelKind::Root(document) => {
                let panel = cx.entity().downgrade();
                let document = document.clone();
                menu.item(
                    PopupMenuItem::new("Build this document").on_click(move |_, _, cx| {
                        panel
                            .update(cx, |_, cx| {
                                cx.emit(PdfEvent::Build {
                                    document: Some(document.clone()),
                                })
                            })
                            .ok();
                    }),
                )
            }
            PdfPanelKind::Live | PdfPanelKind::File(_) => menu,
        }
    }

    fn inner_padding(&self, _: &App) -> bool {
        false
    }
}

impl Render for PdfPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        if self.window.is_none() {
            return div()
                .id("pdf-panel")
                .size_full()
                .rounded_b(PANEL_RADIUS)
                .overflow_hidden()
                .child(self.view.clone())
                .into_any_element();
        }
        // In its own window, the PDF leaves the panel: a layout that brings
        // the panel up anyway shows the way back.
        div()
            .id("pdf-panel")
            .track_focus(&self.focus_handle)
            .size_full()
            .rounded_b(PANEL_RADIUS)
            .bg(palette.pdf_ground)
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(12.))
            .p(px(24.))
            .child(Icon::SQUARE_ARROW_OUT_UP_RIGHT.element(ICON_LARGE, palette.text_secondary))
            .child(
                div()
                    .text_role(TextRole::BodyCompact, cx)
                    .font_weight(lattice_ui::tokens::FONT_WEIGHT_SEMIBOLD)
                    .text_color(palette.text)
                    .child("The PDF is in a separate window"),
            )
            .child(
                Button::new("pdf-return", "Return to workspace")
                    .compact()
                    .icon(Icon::SQUARE_ARROW_DOWN_LEFT)
                    .on_click(cx.listener(|this, _, window, cx| this.dock(true, window, cx))),
            )
            .into_any_element()
    }
}

/// A root document's tab name: its PDF's file name, with its folder when
/// another open document's PDF has the same name (`pdfTabLabel`).
pub fn pdf_tab_label(document: &str, documents: &[String]) -> String {
    let pdf = |path: &str| {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".tex") {
            format!("{}.pdf", &path[..path.len() - 4])
        } else {
            path.to_string()
        }
    };
    let name = |path: &str| pdf(path).rsplit('/').next().unwrap_or(path).to_string();
    let clash = documents
        .iter()
        .any(|other| other != document && name(other) == name(document));
    if clash {
        let full = pdf(document);
        let parts: Vec<&str> = full.split('/').collect();
        parts[parts.len().saturating_sub(2)..].join("/")
    } else {
        name(document)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_documents_tab_is_named_for_its_pdf() {
        assert_eq!(pdf_tab_label("supplement.tex", &[]), "supplement.pdf");
        let open = ["cvpr/main.tex".to_string(), "arxiv/main.tex".to_string()];
        assert_eq!(pdf_tab_label("cvpr/main.tex", &open), "cvpr/main.pdf");
        assert_eq!(pdf_tab_label("deep/a/b/main.tex", &[]), "main.pdf");
    }
}
