// Copied from quiet.md (https://github.com/s1dashu/quiet-md), a Rust port of
// Excalidraw (https://github.com/excalidraw/excalidraw @ 3a317b5), for
// Lattice's native whiteboard. quiet.md: MIT License, Copyright (c) 2026
// s1dashu. Excalidraw: MIT License, Copyright (c) 2020 Excalidraw. See
// THIRD_PARTY_NOTICES.md.

//! 画板 view: the full-window board over the document (or a standalone
//! `.excalidraw` file), after Excalidraw's `components/App.tsx`. The model,
//! geometry, editing algorithms and history are `lattice_board_core::board`
//! (re-exported here, so `crate::board::scene` etc. name the core modules);
//! this module adds the GPUI side: `BoardView` (the live scene, the store and
//! history, the in-gesture state upstream keeps in `appState`), `canvas`
//! (pointer dispatch), `tools/*` (the tool state machines), `keys` (the
//! shortcut map), `run` (actions), `overlay` (selection, handles, snap lines:
//! upstream's interactive canvas), `text_editor` (the wysiwyg editor) and
//! `render` (the display-list backend). The chrome (toolbar, panels, menus)
//! is `chrome` and only uses the public methods below.
//!
//! Every change follows upstream's commit cycle: change the scene / app state,
//! then `commit` with the action's `CaptureUpdateAction` (None: an
//! in-gesture step, `Eventually`), which records undo history and, when the
//! elements changed, emits `BoardEvent::Changed` so the editor saves.

pub mod action;
pub mod agent_canvas;
pub mod canvas;
pub mod chrome;
pub mod fonts;
pub mod frame_name;
mod host;
pub mod keys;
pub mod overlay;
pub mod render;
pub mod run;
pub mod text_editor;
pub mod tools;

pub use lattice_board_core::board::*;

use crate::whiteboard::Board;
use action::{BoardAction, Tool};
use app_state::{AppState, SelectedLinearElement, ToolType};
use flowchart::{FlowChartCreator, FlowChartNavigator};
use gpui::prelude::FluentBuilder;
use gpui::*;
use history::{CaptureUpdateAction, History, Store};
use linear::{LinearElementEditor, SuggestedBinding};
use render::GpuiMeasure;
use rustc_hash::FxHashMap;
use scene::Scene;
use snapping::SnapLine;
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;
use types::{Element, FileData};
use viewport::{Canvas, Viewport};

pub use keys::bind_keys;

pub enum BoardEvent {
    /// The elements changed (a committed step): save.
    Changed,
    /// The camera moved (the host keeps it for the reader).
    ViewChanged,
}

/// Room the chrome takes from the canvas edges when fitting (screen px):
/// upstream `viewport.getOffsets()` measures the `data-viewport-ui` toolbar
/// (its bottom: ours at 8 + 44, upstream 16 + 44) and adds 24 on every side.
pub(crate) const FIT_OFFSETS: viewport::Offsets = viewport::Offsets {
    top: chrome::style::TOP_PADDING as f64 + 44. + 24.,
    right: 24.,
    bottom: 24.,
    left: 24.,
};

/// Elbow routing (core's default) plus arrow labels laid out with our
/// measurer: the hooks every core call that moves arrows gets.
pub struct Hooks<'a>(pub &'a dyn text_measure::Measure);
impl binding::BindingHooks for Hooks<'_> {
    fn handle_bind_text_resize(&self, arrow_id: &str, store: &mut dyn binding::BindingStore) {
        text::handle_bind_text_resize(store, arrow_id, self.0, None, false, false, false)
    }
}

/// What the linear editor reads from the app (with our hooks).
pub(crate) fn lctx<'a>(app: &AppState, hooks: &'a Hooks<'a>, new: bool) -> linear::LinearCtx<'a> {
    linear::LinearCtx {
        hooks,
        ..linear::LinearCtx::from_app(app, new)
    }
}

pub struct BoardView {
    /// The live scene, deleted elements included (history needs them).
    pub scene: Scene,
    pub files: BTreeMap<String, FileData>,
    /// Tool, selection, viewport, defaults for new elements.
    pub app: AppState,
    pub(crate) store: Store,
    pub(crate) history: History,
    pub(crate) m: Rc<GpuiMeasure>,
    pub(crate) painter: Rc<RefCell<render::Painter>>,
    pub(crate) focus: FocusHandle,
    /// The canvas in window coordinates, from the last layout.
    pub(crate) bounds: Rc<Cell<Bounds<Pixels>>>,
    pub(crate) gesture: Option<canvas::Gesture>,
    /// Space held: dragging pans.
    pub(crate) space: bool,
    /// Zoomed to fit once the canvas had a size.
    fitted: bool,
    /// The selected line's editor (`appState.selectedLinearElement` in full;
    /// `app.selected_linear_element` is its observed part).
    pub(crate) linear: Option<LinearElementEditor>,
    /// `multiElement`: the line or arrow being drawn click by click.
    pub(crate) multi: Option<String>,
    pub(crate) suggested: Option<SuggestedBinding>,
    pub(crate) snap_lines: Vec<SnapLine>,
    pub(crate) text: Option<text_editor::TextEditing>,
    /// The frame whose name is being edited (`editingFrame`).
    pub(crate) frame_name: Option<frame_name::FrameNameEditing>,
    /// The frame name labels' window rects, at the last render.
    pub(crate) frame_labels: Vec<(String, Bounds<Pixels>)>,
    /// The elements as they were when the font list opened (upstream's
    /// `cachedElements`), and whether a hovered font is being previewed.
    pub(crate) font_cache: Option<Vec<types::Element>>,
    pub(crate) font_previewing: bool,
    /// A popup with its own field closed: focus goes back to the board at
    /// the next render (unless a text or frame name is being edited).
    pub(crate) refocus: bool,
    /// The cursor the pointer position asks for (`cursor.ts`).
    pub(crate) hover_cursor: CursorStyle,
    /// The last pointer position (window px).
    pub(crate) pointer: Point<Pixels>,
    pub(crate) menu: Option<(Point<Pixels>, bool)>,
    pub(crate) help: bool,
    /// Find on canvas (⌘F), while open.
    pub(crate) search: Option<chrome::search::Search>,
    /// Export image (⇧⌘E), while open.
    pub(crate) export: Option<chrome::export::ExportImage>,
    /// Where an exported image is saved first, and its name: the board's
    /// folder and file stem (\`set_export_target\`).
    pub(crate) export_target: Option<(std::path::PathBuf, String)>,
    /// ⌥⌘C's elements.
    pub(crate) copied_styles: Vec<Element>,
    pub(crate) flowchart: FlowChartCreator,
    pub(crate) navigator: FlowChartNavigator,
    /// Elements drawn faded (about to be erased).
    pub(crate) faded: FxHashMap<String, f32>,
    /// What `Changed` last reported.
    saved: u64,
    /// A panel slider is being dragged: its steps are captured as one.
    slider: bool,
    /// Bounds cache for hit tests: id → (version, nonce, padded AABB).
    pub(crate) aabbs: RefCell<FxHashMap<String, (i64, i64, [f64; 4])>>,
    /// `aabbs` bucketed by place, for hit tests (`canvas::HitIndex`).
    pub(crate) hits: RefCell<canvas::HitIndex>,
    /// The chrome's view (made on the first render).
    chrome: Option<Entity<chrome::ChromeView>>,
    /// The next notify comes from a pointer move that leaves the chrome as
    /// it was (`chrome::ChromeView`).
    pub(crate) chrome_quiet: Cell<bool>,
    /// The file as the board last read or wrote it (`host.rs`'s merge base).
    base: Board,
    /// Why the file couldn't be read: the board shows it and saves nothing.
    unreadable: Option<String>,
}

/// `BoardView::scope_stamp`: the content nonce, and each element of the
/// selection scope with its version (None: too many to check one by one).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ScopeStamp {
    content: i64,
    items: Option<Vec<(String, i64, i64)>>,
}

impl EventEmitter<BoardEvent> for BoardView {}
impl Focusable for BoardView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

pub(crate) fn tool_type(t: Tool) -> ToolType {
    match t {
        Tool::Selection => ToolType::Selection,
        Tool::Lasso => ToolType::Lasso,
        Tool::Hand => ToolType::Hand,
        Tool::Rectangle => ToolType::Rectangle,
        Tool::Diamond => ToolType::Diamond,
        Tool::Ellipse => ToolType::Ellipse,
        Tool::Arrow => ToolType::Arrow,
        Tool::Line => ToolType::Line,
        Tool::FreeDraw => ToolType::FreeDraw,
        Tool::Text => ToolType::Text,
        Tool::Image => ToolType::Image,
        Tool::Eraser => ToolType::Eraser,
        Tool::Frame => ToolType::Frame,
        Tool::StickyNote => ToolType::StickyNote,
    }
}

pub(crate) fn tool_of(t: ToolType) -> Tool {
    match t {
        ToolType::Lasso => Tool::Lasso,
        ToolType::Hand => Tool::Hand,
        ToolType::Rectangle => Tool::Rectangle,
        ToolType::Diamond => Tool::Diamond,
        ToolType::Ellipse => Tool::Ellipse,
        ToolType::Arrow => Tool::Arrow,
        ToolType::Line => Tool::Line,
        ToolType::FreeDraw => Tool::FreeDraw,
        ToolType::Text => Tool::Text,
        ToolType::Image => Tool::Image,
        ToolType::Eraser => Tool::Eraser,
        ToolType::Frame | ToolType::MagicFrame => Tool::Frame,
        ToolType::StickyNote => Tool::StickyNote,
        _ => Tool::Selection,
    }
}

impl BoardView {
    pub fn new(board: Arc<Board>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut app = AppState::default();
        app.apply_exported(&board.app);
        let bd = Arc::unwrap_or_clone(board);
        let mut v = BoardView {
            scene: Scene::new(bd.elements),
            files: bd.files,
            app,
            store: Store::new(),
            history: History::new(),
            m: render::measure(window),
            painter: Rc::new(RefCell::new({
                let mut p = render::Painter::default();
                p.screen_frame_names = true;
                p
            })),
            focus: cx.focus_handle(),
            bounds: Rc::default(),
            gesture: None,
            space: false,
            fitted: false,
            linear: None,
            multi: None,
            suggested: None,
            snap_lines: vec![],
            text: None,
            frame_name: None,
            frame_labels: vec![],
            font_cache: None,
            font_previewing: false,
            refocus: false,
            hover_cursor: CursorStyle::Arrow,
            pointer: point(px(0.), px(0.)),
            menu: None,
            help: false,
            search: None,
            export: None,
            export_target: None,
            copied_styles: vec![],
            flowchart: FlowChartCreator::default(),
            navigator: FlowChartNavigator::default(),
            faded: FxHashMap::default(),
            saved: 0,
            slider: false,
            aabbs: RefCell::default(),
            hits: RefCell::default(),
            chrome: None,
            chrome_quiet: Cell::new(false),
            base: Board::default(),
            unreadable: None,
        };
        // the loaded scene is the baseline, not an undoable step
        v.store.schedule_action(CaptureUpdateAction::Never);
        let _ = v
            .store
            .commit(Some(v.scene.elements_including_deleted()), Some(&v.app));
        v.saved = v.scene_version();
        v
    }

    // ---- what the chrome reads and calls

    pub fn tool(&self) -> Tool {
        tool_of(self.app.active_tool.ty)
    }
    pub fn tool_locked(&self) -> bool {
        self.app.active_tool.locked
    }
    pub fn app_state(&self) -> &AppState {
        &self.app
    }
    /// The scene in z-order, deleted elements included (what core's actions take).
    pub fn elements(&self) -> &[Element] {
        self.scene.elements_including_deleted()
    }
    /// `getSelectedElements` (default options): looked up by id and put in
    /// scene order instead of walking every element (the same list; upstream
    /// scans, which costs milliseconds per call on big boards mid-drag).
    pub fn selected_elements(&self) -> Vec<&Element> {
        let all = self.scene.elements_including_deleted();
        let mut idx: Vec<usize> = self
            .app
            .selected_element_ids
            .iter()
            .filter_map(|id| self.scene.get_element_index(id))
            .filter(|&i| !all[i].is_deleted)
            .collect();
        idx.sort_unstable();
        idx.into_iter().map(|i| &all[i]).collect()
    }
    /// What the properties panel's predicates read (`getTargetElements`,
    /// `getFormValue`, color targets, grouping): the selection, its labels and
    /// label containers and the edited text, in scene order. Upstream hands them
    /// every element; the answers are the same. A big selection keeps the
    /// whole scene (copying it would cost more than scanning).
    pub fn selection_scope(&self) -> Option<Vec<Element>> {
        if self.app.selected_element_ids.len() > 256 {
            return None;
        }
        let all = self.scene.elements_including_deleted();
        let mut idx: Vec<usize> = vec![];
        for id in self
            .app
            .selected_element_ids
            .iter()
            .chain(self.app.editing_text_element.iter())
        {
            let Some(i) = self.scene.get_element_index(id) else {
                continue;
            };
            idx.push(i);
            let e = &all[i];
            idx.extend(
                e.bound_text_id()
                    .into_iter()
                    .chain(e.container_id())
                    .filter_map(|r| self.scene.get_element_index(r)),
            );
        }
        idx.sort_unstable();
        idx.dedup();
        Some(idx.into_iter().map(|i| all[i].clone()).collect())
    }
    /// What `selection_scope` holds now, to tell later whether it changed
    /// other than by moves (`scope_unchanged`).
    pub(crate) fn scope_stamp(&self) -> ScopeStamp {
        let items = self.selection_scope().map(|v| {
            v.into_iter()
                .map(|e| (e.id, e.version, e.version_nonce))
                .collect()
        });
        ScopeStamp {
            content: self.scene.content_nonce(),
            items,
        }
    }
    /// The scene's content is as at `stamp`, or (with the selection as it
    /// was: the caller checks the app state) its selection scope is, but
    /// for moves: an arrow bound to a dragged shape bends, the panel and
    /// chrome stay as they were.
    pub(crate) fn scope_unchanged(&self, stamp: &ScopeStamp) -> bool {
        stamp.content == self.scene.content_nonce()
            || stamp.items.as_ref().is_some_and(|v| {
                v.iter().all(|(id, ver, n)| {
                    self.scene.get_element(id).is_some_and(|e| {
                        (e.version, e.version_nonce) == (*ver, *n)
                            || self
                                .scene
                                .translation(id)
                                .is_some_and(|t| t.from == (*ver, *n))
                    })
                })
            })
    }
    pub fn can_undo(&self) -> bool {
        !self.history.is_undo_stack_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.history.is_redo_stack_empty()
    }
    pub fn context_menu(&self) -> Option<(Point<Pixels>, bool)> {
        self.menu
    }
    pub fn close_context_menu(&mut self, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            cx.notify();
        }
    }
    pub fn help_open(&self) -> bool {
        self.help
    }
    /// A slider drag starts: until `end_slider`, its steps aren't undo steps.
    pub fn begin_slider(&mut self) {
        self.slider = true;
    }
    pub fn sliding(&self) -> bool {
        self.slider
    }
    /// The slider released: the drag's change becomes one undo step.
    pub fn end_slider(&mut self, cx: &mut Context<Self>) {
        if !std::mem::replace(&mut self.slider, false) {
            return;
        }
        self.store.schedule_capture();
        self.commit(None, cx);
    }
    pub fn set_help_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.help != open {
            self.help = open;
            cx.notify();
        }
    }

    /// `setActiveTool`: other tools than selection / lasso clear the
    /// selection; the image tool asks for files and goes back.
    pub fn set_tool(&mut self, t: Tool, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_pending(window, cx);
        let ty = tool_type(t);
        let toggle = matches!(ty, ToolType::Hand | ToolType::Eraser);
        let mut next = actions::update_active_tool(&self.app, ty);
        if toggle && self.app.active_tool.ty != ty {
            next.last_active_tool = Some(self.app.active_tool.ty);
        }
        if !toggle {
            next.last_active_tool = None;
        }
        if !matches!(ty, ToolType::Arrow | ToolType::Line) {
            self.suggested = None;
        }
        if !matches!(ty, ToolType::Selection | ToolType::Lasso) {
            self.set_linear(None);
        }
        self.snap_lines.clear();
        self.app.frame_to_highlight = None;
        self.app.active_tool = next;
        if !matches!(ty, ToolType::Selection) {
            self.clear_selection();
            self.multi = None;
        }
        if ty == ToolType::FreeDraw {
            self.store.schedule_capture();
        }
        self.commit(None, cx);
        if ty == ToolType::Image {
            tools::image::pick_images(self, window, cx);
        }
        self.focus(window, cx);
    }

    /// `run`: one user action (toolbar, panel, menu or shortcut).
    pub fn run(&mut self, a: BoardAction, window: &mut Window, cx: &mut Context<Self>) {
        run::run(self, a, window, cx)
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }

    // ---- state helpers

    pub fn viewport(&self) -> Viewport {
        self.app.viewport()
    }

    /// Excalidraw's `isMobileBreakpoint`: narrower than 730px the chrome takes
    /// upstream's mobile layout, as the web board does in the editor pane.
    pub(crate) fn compact(&self) -> bool {
        let w = f32::from(self.bounds.get().size.width);
        w > 0. && w < 730.
    }

    pub(crate) fn canvas(&self) -> Canvas {
        let b = self.bounds.get();
        Canvas {
            offset_left: f32::from(b.origin.x) as f64,
            offset_top: f32::from(b.origin.y) as f64,
            width: f32::from(b.size.width) as f64,
            height: f32::from(b.size.height) as f64,
        }
    }

    /// What the painter draws with: `screen = canvas origin + (scene + scroll) * zoom`.
    pub(crate) fn view(&self) -> render::View {
        let (v, b) = (self.viewport(), self.bounds.get());
        let z = v.zoom as f32;
        render::View {
            zoom: z,
            origin: point(
                b.origin.x + px(v.scroll_x as f32 * z),
                b.origin.y + px(v.scroll_y as f32 * z),
            ),
        }
    }

    /// A window position in scene coordinates.
    pub(crate) fn scene_point(&self, p: Point<Pixels>) -> [f64; 2] {
        self.view().to_scene(p)
    }

    pub(crate) fn set_viewport(&mut self, v: Viewport, cx: &mut Context<Self>) {
        if v != self.viewport() {
            self.app.set_viewport(v);
            if let Some(t) = &mut self.text {
                t.restyle = true;
            }
            cx.emit(BoardEvent::ViewChanged);
            cx.notify();
        }
    }

    /// The selection's line editor follows `app.selected_linear_element`
    /// (undo, actions and selection changes set only that).
    pub(crate) fn sync_linear(&mut self) {
        match &self.app.selected_linear_element {
            None => self.linear = None,
            Some(s) => {
                if self
                    .linear
                    .as_ref()
                    .is_none_or(|l| l.element_id != s.element_id)
                {
                    self.linear =
                        LinearElementEditor::new(&s.element_id, &mut self.scene, s.is_editing);
                }
                if let Some(l) = &mut self.linear {
                    l.is_editing = s.is_editing;
                }
                if self.linear.is_none() {
                    self.app.selected_linear_element = None;
                }
            }
        }
    }

    pub(crate) fn set_linear(&mut self, l: Option<LinearElementEditor>) {
        self.app.selected_linear_element = l.as_ref().map(|l| SelectedLinearElement {
            element_id: l.element_id.clone(),
            is_editing: l.is_editing,
        });
        self.linear = l;
    }

    pub(crate) fn clear_selection(&mut self) {
        self.app.selected_element_ids.clear();
        self.app.selected_group_ids.clear();
        self.app.editing_group_id = None;
    }

    /// Applies an action's result and records it (`syncActionResult`).
    pub(crate) fn apply(&mut self, r: actions::ActionResult, cx: &mut Context<Self>) {
        if let Some(els) = r.elements {
            self.scene.replace_all_elements(els);
        }
        if let Some(a) = r.app_state {
            let vp = self.viewport();
            self.app = a;
            if self.viewport() != vp
                && let Some(t) = &mut self.text
            {
                t.restyle = true;
            }
        }
        self.sync_linear();
        self.commit(Some(r.capture_update), cx);
    }

    /// Upstream's store commit after a state update: `action` scheduled
    /// (None: `Eventually`), increments recorded, a save asked for when the
    /// elements changed.
    pub(crate) fn commit(&mut self, action: Option<CaptureUpdateAction>, cx: &mut Context<Self>) {
        if let Some(a) = action {
            self.store.schedule_action(a);
        }
        let incs = self.store.commit(
            Some(self.scene.elements_including_deleted()),
            Some(&self.app),
        );
        self.history.record_increments(&incs);
        let v = self.scene_version();
        if v != self.saved && self.unreadable.is_none() {
            self.saved = v;
            cx.emit(BoardEvent::Changed);
            self.refresh_search(false, cx);
        }
        cx.notify();
    }

    fn scene_version(&self) -> u64 {
        let els = self.scene.elements_including_deleted();
        els.iter().fold(
            els.len() as u64 ^ (self.files.len() as u64) << 40,
            |n, e| {
                n.wrapping_mul(31).wrapping_add(
                    e.version as u64 ^ (e.version_nonce as u64) << 1 ^ e.is_deleted as u64,
                )
            },
        )
    }

    /// The board as it is now (non-deleted elements, their files): what
    /// the block and the file save.
    pub fn board(&self) -> Arc<Board> {
        let elements: Vec<Element> = self.scene.non_deleted_elements().cloned().collect();
        let used: rustc_hash::FxHashSet<&str> = elements
            .iter()
            .filter_map(|e| e.image().and_then(|i| i.file_id.as_deref()))
            .collect();
        let files = self
            .files
            .iter()
            .filter(|(k, _)| used.contains(k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        Arc::new(Board {
            elements,
            files,
            app: self.app.for_export(),
        })
    }

    /// Ends what's pending before another action: text editing, a line
    /// drawn click by click.
    pub(crate) fn finish_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.text.is_some() {
            text_editor::submit(self, false, window, cx);
        }
        if self.frame_name.is_some() {
            frame_name::end(self, cx);
        }
        if self.multi.is_some() {
            tools::linear::finalize(self, cx);
        }
    }

    /// `actionZoomToFit` (⇧1); an empty board goes back to 100% at the origin.
    pub fn zoom_to_fit(&mut self, cx: &mut Context<Self>) {
        let r = actions::action_zoom_to_fit(
            self.scene.elements_including_deleted(),
            &self.app,
            self.canvas(),
            Some(FIT_OFFSETS),
            None,
        );
        match r.app_state {
            Some(a) if self.scene.non_deleted_len() > 0 => self.set_viewport(a.viewport(), cx),
            _ => self.set_viewport(
                Viewport {
                    scroll_x: self.canvas().width / 2.,
                    scroll_y: self.canvas().height / 2.,
                    zoom: 1.,
                },
                cx,
            ),
        }
    }

    pub fn zoom_in(&mut self, cx: &mut Context<Self>) {
        let v = viewport::zoom_in(self.viewport(), self.canvas(), None, None);
        self.set_viewport(v, cx);
    }
    pub fn zoom_out(&mut self, cx: &mut Context<Self>) {
        let v = viewport::zoom_out(self.viewport(), self.canvas(), None, None);
        self.set_viewport(v, cx);
    }
    pub fn reset_zoom(&mut self, cx: &mut Context<Self>) {
        let v = viewport::reset_zoom(self.viewport(), self.canvas(), None, None);
        self.set_viewport(v, cx);
    }

    /// Ends what's pending (the text being typed, a line drawn click by
    /// click) so the host saves all of it: before a flush, a hide, a quit.
    pub fn finish_editing(&mut self, cx: &mut Context<Self>) {
        if self.text.is_some() {
            text_editor::submit_text(self, false, cx);
        }
        if self.frame_name.is_some() {
            frame_name::end(self, cx);
        }
        if self.multi.is_some() {
            tools::linear::finalize(self, cx);
        }
    }
}

impl Render for BoardView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        {
            let app: &App = cx;
            crate::theme::set_dark(lattice_ui::ActiveLattice::palette(app).is_dark());
            crate::theme::set_palette(lattice_ui::ActiveLattice::palette(app));
            crate::theme::set_ui_family(lattice_ui::ActiveLattice::lattice(app).fonts.ui.clone());
        }
        text_editor::restyle(self, window, cx);
        if std::mem::take(&mut self.refocus) && self.text.is_none() && self.frame_name.is_none() {
            self.focus(window, cx);
        }
        let canvas_el = canvas::canvas_element(self, cx).into_any_element();
        let editor = text_editor::element(self);
        let labels = frame_name::labels(self, window);
        let frame_name = frame_name::element(self, cx);
        let me = cx.entity();
        let chrome = self
            .chrome
            .get_or_insert_with(|| cx.new(|cx| chrome::ChromeView::new(&me, cx)))
            .clone();
        div()
            .id("board")
            .key_context("Board")
            .track_focus(&self.focus)
            .occlude()
            .relative()
            .size_full()
            .bg(crate::theme::canvas())
            .font_family(crate::theme::ui_family())
            .cursor(canvas::cursor(self))
            .map(|d| keys::listeners(d, cx))
            .map(|d| canvas::listeners(d, cx))
            .child(canvas_el)
            // frame names (and the rename field) stay inside the board: a
            // frame scrolled off the left edge would put its name over the sidebar
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .overflow_hidden()
                    .children(labels)
                    .children(frame_name),
            )
            .children(editor)
            .child(
                AnyView::from(chrome).cached(
                    StyleRefinement::default()
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full(),
                ),
            )
            .children(canvas::capture_layer(self, cx))
    }
}
