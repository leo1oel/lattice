//! The PDF in the dock: the project's live PDF in the PDF panel, and each
//! other root document's last PDF in a tab of its own
//! (`src/canvas/project-pdf-panel.tsx`, `root-pdf-tabs.tsx`).
//!
//! The live PDF follows the build: its diagnostics, SyncTeX and the separate
//! window are the build pipeline's. It can move into a window of its own
//! (`window.rs`); the panel then shows the way back, and everything the
//! shell asks of the live PDF (a new build, a jump into it) goes to the
//! window. Whether the project's PDF is in its window is remembered per
//! project (`src/app/pdf-window-state.ts`): the window opens again, behind
//! the workspace, when the project opens next. A window that goes with its
//! project (another one opening, the app quitting) leaves that choice as it
//! was. A root document's tab shows the copy this machine last built of
//! it and jumps through that document's own SyncTeX map.

use std::path::{Path, PathBuf};

use gpui::{
    AnyView, AnyWindowHandle, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, ParentElement as _, Pixels, Point, Render,
    SharedString, Styled as _, Window, div, px,
};
use gpui_kit::component::dock::{BasePanel, Panel, PanelEvent};
use lattice_core::latex::PdfSyncTarget;
use lattice_i18n::{n, t};
use lattice_ui::{
    ActiveLattice as _, Icon, TextRole, TextRoleStyle as _,
    components::{Button, Menu, MenuAction},
    dock::PANEL_RADIUS,
    icons::ICON_LARGE,
};

use super::{
    preferences,
    view::{PdfView, PdfViewEvent, ToolbarAction},
    window::{self, PdfWindow},
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
        word: Option<lattice_editor::latex::synctex_word::SyncTexWord>,
        figure: bool,
    },
    /// Reveal cursor in PDF, in `document`'s PDF (`None`: the live one).
    RevealCursor {
        document: Option<String>,
    },
    /// Build `document` (`None`: the project).
    Build {
        document: Option<String>,
    },
    /// A citation card's title: open the paper cited under the key.
    OpenCitation(String),
    /// A note's card on the PDF asked something of it.
    Annotation(crate::annotations::AnnotationRequest),
    /// A note made on this panel's PDF goes to Overleaf
    /// (`PdfViewEvent::OverleafNote`).
    OverleafNote {
        id: u64,
        path: String,
        line: usize,
        selection: String,
        quote: String,
        body: String,
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
    /// The open project's folder, which the separate window is remembered
    /// by.
    project: Option<PathBuf>,
    /// A root document's tab name, which tells it from the other open
    /// documents' (`pdf_tab_label`).
    label: SharedString,
    view: Entity<PdfView>,
    /// The live PDF's separate window and the viewer in it.
    window: Option<(AnyWindowHandle, Entity<PdfView>)>,
    /// The PDF shown, which the window or the panel opens again when the
    /// live PDF moves between them.
    source: Option<PathBuf>,
    building: bool,
    /// Whether Reveal cursor in PDF can jump, and whether a jump is being
    /// located, carried into the window.
    reveal: (bool, bool),
    /// The build's diagnostics card (`crate::build::card`), over the top of
    /// the pages or docked under them, as the Tauri app puts it in its PDF
    /// column. Only the live panel has one.
    build_output: Option<AnyView>,
    /// The window's title: the PDF's and the project's names.
    title: SharedString,
    /// The live PDF's Outline, carried into its window.
    outline: Option<super::OutlineState>,
    /// The project's citations, carried into the window.
    citations: Option<super::CitationLookup>,
    /// The last build's compounds, carried into the window.
    compounds: Option<super::CompoundSource>,
    /// The project's notes, carried into the window.
    notes: Option<super::PdfNotes>,
    /// The project, the document (project-relative) whose place this
    /// panel's PDF keeps, and that document's PDF: a place taken in any
    /// other PDF shown here (the marked one) is not that document's.
    place_key: Option<(PathBuf, String, PathBuf)>,
    /// Track changes' marked PDF building, or why it could not be made.
    pub(super) marking: super::review_marking::Marking,
    _subscriptions: Vec<gpui::Subscription>,
}

impl PdfPanel {
    /// Whether Reveal cursor in PDF can jump now, and whether a jump is
    /// being located.
    pub fn set_reveal(&mut self, enabled: bool, locating: bool, cx: &mut Context<Self>) {
        self.reveal = (enabled, locating);
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_reveal(enabled, locating, cx));
        }
    }

    /// The project's citations, for the cards over citation links.
    pub fn set_citations(&mut self, lookup: Option<super::CitationLookup>, cx: &mut Context<Self>) {
        self.citations = lookup.clone();
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_citations(lookup.clone(), cx));
        }
    }

    /// Whether the notes it was given offer Annotate.
    /// What this PDF knows of a linked project's Overleaf side (`None`
    /// inside: not linked); `None` without a project's notes.
    pub fn overleaf_notes(&self) -> Option<Option<&super::OverleafNotes>> {
        self.notes.as_ref().map(|notes| notes.overleaf.as_ref())
    }

    /// The project's notes, drawn on the PDF.
    pub fn set_notes(&mut self, notes: Option<super::PdfNotes>, cx: &mut Context<Self>) {
        self.notes = notes.clone();
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_notes(notes.clone(), cx));
        }
    }

    /// The last build's compounds, for the key cards over their numbers.
    pub fn set_compounds(&mut self, source: Option<super::CompoundSource>, cx: &mut Context<Self>) {
        self.compounds = source.clone();
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_compounds(source.clone(), cx));
        }
    }

    /// The document (project-relative) in `root` whose PDF, `pdf`, this
    /// panel shows, under which its place is kept.
    pub fn set_place_key(&mut self, root: PathBuf, document: String, pdf: PathBuf) {
        self.place_key = Some((root, document, pdf));
    }

    /// Keep where the PDF was left, under the document it shows.
    pub(super) fn remember_place(&self, place: super::view::ViewPlace) {
        if let Some((root, document, pdf)) = &self.place_key
            && self.source.as_ref() == Some(pdf)
        {
            preferences::update(|preferences| preferences.remember_place(root, document, place));
        }
    }

    /// Show `path` where its document was last left, when this viewer shows
    /// nothing yet or `mounted` (a project shown anew): the Tauri app
    /// restores the place a viewer mounts with (`SavedViewState`). Else as
    /// [`Self::open`] does.
    pub fn open_restoring(
        &mut self,
        path: PathBuf,
        mounted: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let saved = self
            .place_key
            .as_ref()
            .and_then(|(root, document, _)| preferences::get().place(root, document));
        let fresh = self.window.is_none() && (mounted || self.view.read(cx).page_count() == 0);
        match saved {
            Some(place) if fresh => {
                self.source = Some(path.clone());
                self.view
                    .update(cx, |view, cx| view.open_at(path, place, window, cx));
                cx.notify();
            }
            _ => self.open(path, window, cx),
        }
    }

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
        let subscriptions = vec![
            cx.subscribe_in(&view, window, Self::on_view_event),
            // A window that goes with its panel (the workspace closing) keeps
            // the project's choice.
            cx.on_release(|this, cx| {
                if let Some((handle, _)) = this.window.take() {
                    window::close(handle, this.project.as_deref(), cx);
                }
            }),
        ];
        let label = match &kind {
            PdfPanelKind::Live => "PDF".into(),
            PdfPanelKind::Root(_) => SharedString::default(),
            PdfPanelKind::File(path) => path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "PDF".into())
                .into(),
        };
        Self {
            focus_handle: cx.focus_handle(),
            kind,
            home: window.window_handle(),
            project: None,
            label,
            view,
            window: None,
            source: None,
            building: false,
            reveal: (true, false),
            build_output: None,
            title: "PDF".into(),
            outline: None,
            citations: None,
            compounds: None,
            notes: None,
            place_key: None,
            marking: Default::default(),
            _subscriptions: subscriptions,
        }
    }

    /// Draw `preview` over the live PDF's pages in this panel only: the
    /// separate window shows the paper's own PDF, without the live layer.
    pub fn set_live_preview(
        &mut self,
        preview: Option<Entity<crate::live_preview::LivePreview>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.view
            .update(cx, |view, cx| view.set_live_preview(preview, cx));
    }

    /// Show the build's diagnostics card over (or under) the pages.
    pub fn set_build_output(&mut self, view: AnyView, cx: &mut Context<Self>) {
        self.build_output = Some(view);
        cx.notify();
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

    /// The PDF shown, wherever it is.
    pub fn source(&self) -> Option<&Path> {
        self.source.as_deref()
    }

    /// The live PDF's separate window, while it has one.
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
            PdfViewEvent::SourceAt {
                page,
                x,
                y,
                word,
                figure,
            } => cx.emit(PdfEvent::SourceAt {
                document,
                page: *page,
                x: *x,
                y: *y,
                word: word.clone(),
                figure: *figure,
            }),
            PdfViewEvent::RevealCursor => cx.emit(PdfEvent::RevealCursor { document }),
            PdfViewEvent::Build => cx.emit(PdfEvent::Build { document }),
            PdfViewEvent::Outline { path, line } => cx.emit(PdfEvent::Outline {
                path: path.clone(),
                line: *line,
            }),
            PdfViewEvent::OpenCitation(key) => cx.emit(PdfEvent::OpenCitation(key.clone())),
            PdfViewEvent::Annotation(request) => cx.emit(PdfEvent::Annotation(request.clone())),
            PdfViewEvent::OverleafNote {
                id,
                path,
                line,
                selection,
                quote,
                body,
            } => cx.emit(PdfEvent::OverleafNote {
                id: *id,
                path: path.clone(),
                line: *line,
                selection: selection.clone(),
                quote: quote.clone(),
                body: body.clone(),
            }),
            PdfViewEvent::PlaceChanged(place) => self.remember_place(*place),
            PdfViewEvent::Action => self.detach(window, cx),
        }
    }

    /// Show `project`'s live PDF, `pdf` (`None`: it has none yet). The window
    /// of the project before goes, its choice left as it was, and a window
    /// this project left open opens again, behind the workspace.
    pub fn show_project(
        &mut self,
        project: PathBuf,
        pdf: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let switched = self.project.as_ref() != Some(&project);
        // A place is kept per project: another project's key never applies.
        if self
            .place_key
            .as_ref()
            .is_some_and(|(root, ..)| *root != project)
        {
            self.place_key = None;
        }
        if switched {
            if let Some((handle, _)) = self.window.take() {
                window::close(handle, self.project.as_deref(), cx);
            }
            self.project = Some(project.clone());
        }
        match pdf {
            Some(pdf) => self.open_restoring(pdf, switched, window, cx),
            None => self.close(window, cx),
        }
        if preferences::get().window(&project).open {
            self.open_window(false, window, cx);
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

    /// The PDF of the project this tab shows changed on disk (`removed`:
    /// it is gone): it is read again, or says it was removed, keeping the
    /// pages it showed until it comes back (`useProjectPdfWatch`).
    pub fn file_changed(&mut self, removed: bool, window: &mut Window, cx: &mut Context<Self>) {
        let notice = removed.then(|| t!("This PDF was removed from the project.").into());
        self.view.update(cx, |view, cx| view.set_notice(notice, cx));
        if !removed && let Some(path) = self.source.clone() {
            self.open(path, window, cx);
        }
    }

    /// The status line over the pages, for a scenario.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn notice(&self, cx: &App) -> Option<SharedString> {
        self.view.read(cx).notice.clone()
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
        let same = match (&self.outline, &outline) {
            (None, None) => true,
            (Some(shown), Some(outline)) => {
                std::rc::Rc::ptr_eq(&shown.headings, &outline.headings)
                    && shown.active == outline.active
            }
            _ => false,
        };
        if same {
            return;
        }
        self.outline = outline.clone();
        let views = [
            Some(self.view.clone()),
            self.window.as_ref().map(|(_, view)| view.clone()),
        ];
        for view in views.into_iter().flatten() {
            view.update(cx, |view, cx| view.set_outline(outline.clone(), cx));
        }
    }

    /// The separate window's title, now and for when it opens.
    pub fn set_window_title(&mut self, title: SharedString, cx: &mut App) {
        if let Some((handle, _)) = &self.window {
            handle
                .update(cx, |_, window, _| window.set_window_title(&title))
                .ok();
        }
        self.title = title;
    }

    /// A root document's tab name, among the documents open now.
    pub fn set_label(&mut self, label: SharedString, cx: &mut Context<Self>) {
        if self.label != label {
            self.label = label;
            cx.notify();
        }
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

    /// Whether the live PDF is in a window of its own.
    pub fn is_detached(&self) -> bool {
        self.window.is_some()
    }

    /// Move the live PDF into a window of its own: the window opens where it
    /// was last left for this project, at the place the panel showed.
    pub fn detach(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_window(true, window, cx);
    }

    /// Open the separate window, in front (`focus`) or behind the workspace,
    /// and remember that the project's PDF is in it.
    fn open_window(&mut self, focus: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.kind != PdfPanelKind::Live || self.window.is_some() {
            return;
        }
        let place = self.view.read(cx).view_place();
        let source = self.source.clone();
        let owner = cx.entity().downgrade();
        let project = self.project.clone();
        let title = self.title.clone();
        let outline = self.outline.clone();
        let citations = self.citations.clone();
        let opened = PdfWindow::open(
            owner,
            project.clone(),
            title,
            source,
            place,
            self.building,
            self.reveal,
            outline,
            citations,
            focus,
            cx,
        );
        match opened {
            Ok((handle, view)) => {
                // The panel's own viewer lets go of its pages.
                self.view.update(cx, |view, cx| view.close(window, cx));
                let compounds = self.compounds.clone();
                let notes = self.notes.clone();
                view.update(cx, |view, cx| {
                    view.set_compounds(compounds, cx);
                    view.set_notes(notes, cx);
                });
                self.window = Some((handle, view));
                if let Some(root) = project {
                    preferences::update(|preferences| preferences.window_mut(&root).open = true);
                }
                if !focus {
                    window.activate_window();
                }
                cx.emit(PdfEvent::Detached);
                cx.notify();
            }
            Err(error) => {
                log::error!("could not open the PDF window: {error:#}");
                crate::notices::error(
                    t!("Could not open the PDF in a new window"),
                    format!("{error:#}"),
                    cx,
                );
            }
        }
    }

    /// Return to workspace: the live PDF comes back into its panel and the
    /// project remembers it there; the window closes (unless the reader is
    /// closing it already).
    pub fn dock(&mut self, close_window: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((handle, view)) = self.window.take() else {
            return;
        };
        let place = view.read(cx).view_place();
        if close_window {
            window::close(handle, self.project.as_deref(), cx);
        }
        if let Some(source) = self.source.clone() {
            self.view
                .update(cx, |view, cx| view.open_at(source, place, window, cx));
        }
        if let Some(root) = self.project.clone() {
            preferences::update(|preferences| preferences.window_mut(&root).open = false);
        }
        cx.emit(PdfEvent::Docked);
        cx.notify();
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

/// The live panel's toolbar action.
fn open_in_window() -> ToolbarAction {
    ToolbarAction {
        label: n!("Open in separate window"),
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

    /// Its tab's X takes it off screen, as the Tauri app's does: a root
    /// document's tab and a PDF file's close, and the Panels menu brings the
    /// live PDF back.
    fn closable(&self, _: &App) -> bool {
        true
    }
}

impl PdfPanel {
    /// The PDF's own items at the head of its ⋯ menu, as the Tauri app's
    /// PDF panel has them (`use-trellis-bridge.ts`): Build project (⌘S
    /// saves and then builds; it has no key of its own) and Reveal cursor
    /// in PDF; a root document's tab builds that document.
    pub(crate) fn panel_menu(this: &Entity<Self>, menu: Menu, cx: &App) -> Menu {
        let panel = this.read(cx);
        let emit = |event: fn(Option<String>) -> PdfEvent, document: Option<String>| {
            let panel = this.downgrade();
            move |_: &mut Window, cx: &mut App| {
                panel
                    .update(cx, |_, cx| cx.emit(event(document.clone())))
                    .ok();
            }
        };
        let (save, reveal) = if cfg!(target_os = "macos") {
            ("⌘S", "⇧⌘J")
        } else {
            ("Ctrl+S", "Ctrl+Shift+J")
        };
        match &panel.kind {
            PdfPanelKind::Live => menu
                .item(
                    MenuAction::new(
                        t!("Build project"),
                        emit(|document| PdfEvent::Build { document }, None),
                    )
                    .shortcut(save),
                )
                .item(
                    MenuAction::new(
                        t!("Reveal cursor in PDF"),
                        emit(|document| PdfEvent::RevealCursor { document }, None),
                    )
                    .shortcut(reveal),
                ),
            PdfPanelKind::Root(document) => menu.item(MenuAction::new(
                t!("Build this document"),
                emit(
                    |document| PdfEvent::Build { document },
                    Some(document.clone()),
                ),
            )),
            PdfPanelKind::File(_) => menu,
        }
    }
}

impl Panel for PdfPanel {
    fn tab_name(&self, _: &App) -> Option<SharedString> {
        Some(self.label.clone())
    }

    fn title(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.label.clone()
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
                .flex()
                .flex_col()
                .relative()
                .rounded_b(PANEL_RADIUS)
                .overflow_hidden()
                .children(self.marking_message(cx))
                .child(div().flex_1().min_h_0().child(self.view.clone()))
                .children(self.build_output.clone())
                .children(self.marking_pill(cx))
                .into_any_element();
        }
        // In its own window, the PDF leaves the panel: a layout that brings
        // the panel up anyway shows the way back, and the build's card, which
        // a failed build brings forward here.
        div()
            .id("pdf-panel")
            .track_focus(&self.focus_handle)
            .relative()
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
                    .child(t!("The PDF is in a separate window")),
            )
            .child(
                Button::new("pdf-return", t!("Return to workspace"))
                    .compact()
                    .icon(Icon::SQUARE_ARROW_DOWN_LEFT)
                    .on_click(cx.listener(|this, _, window, cx| this.dock(true, window, cx))),
            )
            .children(self.build_output.clone())
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
