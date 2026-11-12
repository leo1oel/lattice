//! The window: Lattice's titlebar over GPUI Kit's dock area in Lattice's
//! look, holding the file tree, Papers and the Agent, the editors, the PDF
//! preview and the build panel; and the flows that tie them together on
//! lattice-core: open a project, open a file, build, jump between the source
//! and the PDF (SyncTeX), and the file tree's create, rename, move and
//! delete.
//!
//! The shell's own parts live beside it: the arrangement of panels and the
//! named workspaces (`layout`, `workspaces`, `arrange`, `workspace_flow`),
//! the command table, keymap and palette (`commands`, `actions`, `palette`),
//! the menu bar (`menus`), windows and project tabs (`windows`), floating
//! panels (`floating`), builds (`build`), the tree's operations (`entries`)
//! and SyncTeX (`synctex`).

mod actions;
mod arrange;
mod build;
pub mod commands;
mod entries;
mod floating;
pub mod layout;
pub(crate) mod menus;
mod palette;
mod synctex;
pub mod windows;
mod workspace_flow;
pub mod workspaces;

use std::path::{Path, PathBuf};

use futures::channel::oneshot;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, PathPromptOptions, PromptLevel,
    Render, SharedString, Styled as _, Subscription, Task, WeakEntity, Window, WindowBounds,
    WindowOptions, div, prelude::FluentBuilder as _, px, size,
};
use gpui_kit::component::{
    dock::{DockArea, DockEvent, PanelId},
    v_flex,
};
use lattice_ui::{ActiveLattice as _, Appearance, LatticeTheme, dock::LatticeDock};

use build::BuildRequest;
pub use commands::{Build, ForwardSync, OpenFolder, Save, ToggleVimMode};

use crate::{
    build_panel::{BuildPanel, OpenLocation},
    confirm::{self, ConfirmHost},
    editor_panel::{EditorPanel, EditorPanelEvent},
    file_tree::FileTreePanel,
    notices::{self, NoticeStack},
    pdf::{PdfEvent, PdfPanel},
    project::Project,
    stand_in_panels::{StandIn, StandInPanel},
    titlebar::TitlebarDrag,
};

/// The chrome around the cards: 12px from the window's sides and bottom and
/// 6px under the titlebar, less the groups' own half-gutter.
const WORKSPACE_SIDE: f32 = 12. - 3.;
const WORKSPACE_TOP: f32 = 6. - 3.;
/// The build panel's height when it is shown under the editors.
const BUILD_DOCK: f32 = 180. + 6.;

#[cfg(target_os = "macos")]
pub const BUILD_SHORTCUT_LABEL: &str = "⌘B";
#[cfg(not(target_os = "macos"))]
pub const BUILD_SHORTCUT_LABEL: &str = "Ctrl+B";

pub fn bind_keys(cx: &mut App) {
    commands::bind_keys(cx);
}

/// The window's layout state: the workspace the project is in, a preset or
/// focus mode laid over it, and whether its arrangement differs from the
/// workspace's.
#[derive(Default)]
pub(crate) struct LayoutState {
    pub workspace: Option<String>,
    pub preset: Option<workspaces::ActivePreset>,
    /// Focus mode's own layout to return to.
    pub focus: Option<layout::Arrangement>,
    pub dirty: bool,
    /// The workspace whose name is being edited in place.
    pub renaming: Option<String>,
    /// While an arrangement is being installed, the dock's change events are
    /// the install's own.
    pub installing: bool,
    /// Where each document stood in each workspace, by workspace id.
    pub places: std::collections::BTreeMap<String, std::collections::BTreeMap<String, usize>>,
}

pub struct Shell {
    project: Option<Entity<Project>>,
    pub(crate) focus_handle: FocusHandle,
    dock_area: Entity<DockArea>,
    titlebar_drag: TitlebarDrag,
    file_tree: Entity<FileTreePanel>,
    papers: Entity<StandInPanel>,
    agent: Entity<StandInPanel>,
    pdf: Entity<PdfPanel>,
    build_panel: Entity<BuildPanel>,
    notices: Entity<NoticeStack>,
    confirm: Entity<ConfirmHost>,
    editors: Vec<WeakEntity<EditorPanel>>,
    /// The editor the writer was last in (opened, or holding the keyboard),
    /// which a build compiles from and a jump to the PDF starts from. An
    /// overlay (the palette, a menu) taking focus does not change it.
    active_editor: Option<WeakEntity<EditorPanel>>,
    build_task: Option<Task<()>>,
    /// The build to run once the one under way ends.
    queued_build: Option<BuildRequest>,
    /// Told when the builds under way, queued ones included, are over.
    build_waiters: Vec<oneshot::Sender<()>>,
    _open_task: Option<Task<()>>,
    vim_mode: bool,
    pub(crate) layout: LayoutState,
    pub(crate) floating: floating::FloatingLayer,
    palette: Option<Entity<palette::CommandPaletteView>>,
    shortcuts: Option<Entity<palette::ShortcutSheet>>,
    /// The projects open in this window, in tab order; the open one is
    /// `project`'s.
    pub(crate) projects: Vec<PathBuf>,
    /// Documents closed in this window, most recent last, for ⌘⇧T.
    closed_tabs: Vec<PathBuf>,
    save_task: Option<Task<()>>,
    /// The field a workspace's name is edited in, while it is.
    pub(crate) rename_input: Option<Entity<gpui_kit::component::input::InputState>>,
    pub(crate) rename_subscription: Option<Subscription>,
    _subscriptions: Vec<Subscription>,
}

impl Shell {
    pub fn open_window(
        root: Option<PathBuf>,
        cx: &mut App,
    ) -> anyhow::Result<(AnyWindowHandle, Entity<Shell>)> {
        Self::open_window_with(root, None, cx)
    }

    /// A window `size` wide and high (1440×900 by default), cascaded from the
    /// active one when there is one.
    pub fn open_window_with(
        root: Option<PathBuf>,
        bounds: Option<Bounds<gpui::Pixels>>,
        cx: &mut App,
    ) -> anyhow::Result<(AnyWindowHandle, Entity<Shell>)> {
        let bounds = bounds.unwrap_or_else(|| Bounds::centered(None, window_size(), cx));
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(720.), px(480.))),
            titlebar: titlebar_options(),
            ..Default::default()
        };
        let (window, shell) = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| Shell::new(window, cx))
        })?;
        window.update(cx, |_, window, cx| {
            let closing = shell.downgrade();
            window.on_window_should_close(cx, move |window, cx| {
                closing
                    .update(cx, |shell, cx| shell.should_close(window, cx))
                    .unwrap_or(true)
            });
        })?;
        shell.update(cx, |_, cx| {
            cx.on_app_quit(|shell, cx| {
                for editor in shell.open_editors() {
                    editor.update(cx, |editor, cx| editor.write_before_quit(cx));
                }
                async {}
            })
            .detach();
        });
        windows::register(window, &shell, cx);
        if let Some(root) = root {
            window.update(cx, |_, window, cx| {
                shell.update(cx, |shell, cx| shell.open_project(root, window, cx));
            })?;
        }
        Ok((window, shell))
    }

    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::panels::present_tabs(cx);
        arrange::install_dock_hooks(cx);
        let dock_area = LatticeDock::dock_area("lattice", Some(1), window, cx);
        let file_tree = cx.new(FileTreePanel::new);
        let papers = cx.new(|cx| StandInPanel::new(StandIn::Papers, cx));
        let agent = cx.new(|cx| StandInPanel::new(StandIn::Agent, cx));
        let pdf = cx.new(PdfPanel::new);
        let build_panel = cx.new(BuildPanel::new);
        let notices = notices::install(cx);
        let confirm = confirm::install(cx);

        // The system's appearance, unless the run or the writer fixed one.
        if crate::app::appearance_override().is_none() {
            cx.observe_window_appearance(window, |_, window, cx| {
                if !crate::app::appearance_chosen(cx) {
                    LatticeTheme::set_appearance(Appearance::from(window.appearance()), cx);
                }
            })
            .detach();
        }

        cx.subscribe_in(&file_tree, window, Self::on_tree_event)
            .detach();
        cx.subscribe_in(
            &build_panel,
            window,
            |this, _, location: &OpenLocation, window, cx| {
                this.open_path(location.path.clone(), location.line, window, cx);
            },
        )
        .detach();
        cx.subscribe_in(
            &pdf,
            window,
            |this, _, event: &PdfEvent, window, cx| match event {
                PdfEvent::SourceAt { page, x, y } => this.inverse_sync(*page, *x, *y, window, cx),
            },
        )
        .detach();
        cx.observe(&notices, |_, _, cx| cx.notify()).detach();
        cx.observe(&confirm, |_, _, cx| cx.notify()).detach();
        let dock_events = cx.subscribe_in(&dock_area, window, |this, _, event, window, cx| {
            if let DockEvent::LayoutChanged = event {
                this.layout_changed(window, cx);
            }
        });
        let library = cx.observe_global::<workspaces::Workspaces>(|this, cx| {
            this.refresh_dirty(cx);
            cx.notify();
        });
        cx.on_release(|this, cx| this.flush_layout(cx)).detach();
        cx.on_app_quit(|this, cx| {
            this.flush_layout(cx);
            async {}
        })
        .detach();

        let mut shell = Self {
            project: None,
            focus_handle: cx.focus_handle(),
            dock_area,
            titlebar_drag: TitlebarDrag::default(),
            file_tree,
            papers,
            agent,
            pdf,
            build_panel,
            notices,
            confirm,
            editors: Vec::new(),
            active_editor: None,
            build_task: None,
            queued_build: None,
            build_waiters: Vec::new(),
            _open_task: None,
            vim_mode: crate::app::vim_mode_enabled(cx),
            layout: LayoutState::default(),
            floating: floating::FloatingLayer::default(),
            palette: None,
            shortcuts: None,
            projects: Vec::new(),
            closed_tabs: Vec::new(),
            save_task: None,
            rename_input: None,
            rename_subscription: None,
            _subscriptions: vec![dock_events, library],
        };
        // The Main window before a project opens: the default arrangement,
        // its document slot empty.
        let room = shell.room(window);
        let arrangement =
            layout::Arrangement::default_for(room).with_documents(&[], None, &Default::default());
        shell.install(&arrangement, window, cx);
        shell
    }

    /// The open project's folder.
    pub fn root(&self, cx: &App) -> Option<PathBuf> {
        self.project
            .as_ref()
            .map(|project| project.read(cx).root().to_path_buf())
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn project(&self) -> Option<&Entity<Project>> {
        self.project.as_ref()
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn pdf(&self) -> &Entity<PdfPanel> {
        &self.pdf
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn build_panel(&self) -> &Entity<BuildPanel> {
        &self.build_panel
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn file_tree(&self) -> &Entity<FileTreePanel> {
        &self.file_tree
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn confirm(&self) -> &Entity<ConfirmHost> {
        &self.confirm
    }

    /// The project-relative path of the editor the writer was last in.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn active_editor_path(&self, cx: &App) -> Option<String> {
        self.active_editor()
            .map(|editor| editor.read(cx).relative().to_string())
    }

    /// Whether a build is under way or queued.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn building(&self) -> bool {
        self.build_task.is_some()
    }

    pub fn dock_area(&self) -> &Entity<DockArea> {
        &self.dock_area
    }

    pub(crate) fn titlebar_drag(&self) -> &TitlebarDrag {
        &self.titlebar_drag
    }

    /// The open project's name, as the titlebar's switcher shows it: the
    /// name in its manifest, as the Tauri titlebar shows it.
    pub fn project_name(&self, cx: &App) -> SharedString {
        match &self.project {
            Some(project) => project.read(cx).manifest().name.clone().into(),
            None => "Open a project".into(),
        }
    }

    /// Open a project folder with lattice-core, as the Tauri app opens it,
    /// laid out as the project was left (its documents, its workspace). The
    /// project open before keeps its tab in the window: its layout is
    /// recorded and its edited files saved first.
    pub fn open_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.save_layout(cx);
        let editors = self.open_editors();
        let saves = Self::save_dirty(&editors, cx);
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            for save in saves {
                save.await.ok();
            }
            match crate::project::open(root.clone(), cx).await {
                Ok(project) => {
                    this.update_in(cx, |this, window, cx| this.set_project(project, window, cx))
                        .ok();
                }
                Err(error) => {
                    log::error!("could not open {}: {error}", root.display());
                    cx.update(|_, cx| notices::error("Could not open the project", error, cx))
                        .ok();
                }
            }
        }));
    }

    /// Show the opened project: in the tree, in the window's tabs, laid out
    /// as it was left (else with its main document open), and its PDF when
    /// one was already built.
    fn set_project(
        &mut self,
        project: Entity<Project>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (root, main, pdf) = {
            let project = project.read(cx);
            (
                project.root().to_path_buf(),
                project
                    .main_document()
                    .map(|main| project.root().join(main)),
                project.main_pdf().filter(|pdf| pdf.is_file()),
            )
        };
        if !self.projects.contains(&root) {
            match self
                .root(cx)
                .and_then(|current| self.projects.iter().position(|p| *p == current))
            {
                Some(ix) => self.projects.insert(ix + 1, root.clone()),
                None => self.projects.push(root.clone()),
            }
        }
        self.project = Some(project.clone());
        // The editors of the project open before go with its arrangement.
        self.editors.clear();
        self.active_editor = None;
        self.queued_build = None;
        self.closed_tabs.clear();
        self.file_tree
            .update(cx, |tree, cx| tree.set_project(project, cx));
        window.set_window_title(&format!(
            "{} — Lattice (GPUI preview)",
            root.file_name().unwrap_or_default().to_string_lossy()
        ));
        let restored = self.restore_layout(&root, main.as_deref(), window, cx);
        if let Some(main) = main.filter(|_| !restored) {
            self.open_path(main, None, window, cx);
        }
        self.pdf.update(cx, |panel, cx| match pdf {
            Some(pdf) => panel.open(pdf, window, cx),
            None => panel.close(window, cx),
        });
        cx.notify();
    }

    /// The window is closing: unsaved edits are saved first, and the window
    /// closes once they are, staying open (with the save's notice) when one
    /// could not be.
    fn should_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let saves = Self::save_dirty(&self.open_editors(), cx);
        if saves.is_empty() {
            return true;
        }
        cx.spawn_in(window, async move |_, cx| {
            for save in saves {
                if !save.await.unwrap_or(false) {
                    return;
                }
            }
            cx.update(|window, _| window.remove_window()).ok();
        })
        .detach();
        false
    }

    /// Close the window as its close button does (`should_close`).
    pub(crate) fn close_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.should_close(window, cx) {
            window.remove_window();
        }
    }

    /// Open a source file in an editor tab (or switch to its tab), or a PDF in
    /// the preview, then go to `line` when given.
    pub fn open_path(
        &mut self,
        path: PathBuf,
        line: Option<u32>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<EditorPanel>> {
        if path.extension().is_some_and(|extension| extension == "pdf") {
            self.pdf
                .update(cx, |panel, cx| panel.open(path, window, cx));
            self.show_view(layout::View::Pdf, window, cx);
            return None;
        }
        let path = path.canonicalize().unwrap_or(path);
        let editor = match self.open_editor(&path, cx) {
            Some(editor) if self.panel_shown(PanelId::from(editor.entity_id()), cx) => {
                let id = PanelId::from(editor.entity_id());
                self.dock_area
                    .update(cx, |area, cx| area.select_panel(id, window, cx));
                editor
            }
            _ => {
                let editor = self.editor_for(&path, window, cx)?;
                self.place_document(&editor, window, cx);
                editor
            }
        };
        self.active_editor = Some(editor.downgrade());
        editor.update(cx, |editor, cx| match line {
            Some(line) => editor.go_to_line(line, window, cx),
            None => window.focus(&editor.editor().focus_handle(cx), cx),
        });
        self.file_tree
            .update(cx, |tree, cx| tree.set_current(Some(path.clone()), cx));
        Some(editor)
    }

    /// The editor already open on `path`, if any.
    pub(crate) fn open_editor(&mut self, path: &Path, cx: &App) -> Option<Entity<EditorPanel>> {
        self.open_editors()
            .into_iter()
            .find(|editor| editor.read(cx).path() == path)
    }

    /// The editor on `path`, opened if it is not yet; it is not placed in
    /// the dock.
    pub(crate) fn editor_for(
        &mut self,
        path: &Path,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<EditorPanel>> {
        if let Some(editor) = self.open_editor(path, cx) {
            return Some(editor);
        }
        let project = self.project.clone()?;
        match EditorPanel::open(
            path.to_path_buf(),
            project,
            self.build_panel.clone(),
            window,
            cx,
        ) {
            Ok(editor) => {
                cx.subscribe_in(&editor, window, Self::on_editor_event)
                    .detach();
                self.editors.push(editor.downgrade());
                let weak = editor.downgrade();
                cx.on_focus_in(&editor.focus_handle(cx), window, move |this, _, _| {
                    this.active_editor = Some(weak.clone());
                })
                .detach();
                Some(editor)
            }
            Err(error) => {
                log::error!("{error:#}");
                let _ = window.prompt(
                    PromptLevel::Critical,
                    "Could not open the file",
                    Some(&format!("{error:#}")),
                    &["OK"],
                    cx,
                );
                None
            }
        }
    }

    fn on_editor_event(
        &mut self,
        editor: &Entity<EditorPanel>,
        event: &EditorPanelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            EditorPanelEvent::Saved => {
                if let Some(project) = &self.project {
                    project.update(cx, |project, _| project.mark_inputs_changed());
                }
            }
            EditorPanelEvent::SavedForBuild | EditorPanelEvent::DiskEdit => {
                self.run_build(BuildRequest::automatic(), window, cx);
            }
            EditorPanelEvent::Close => self.close_editor(editor, window, cx),
        }
    }

    /// Close an editor's tab, wherever it is, without asking: its file is
    /// gone.
    fn close_editor(
        &mut self,
        editor: &Entity<EditorPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_panel(PanelId::from(editor.entity_id()), window, cx);
        self.editors
            .retain(|open| open.upgrade().is_some_and(|open| open != *editor));
        if self
            .active_editor
            .as_ref()
            .is_some_and(|active| active.upgrade().as_ref() == Some(editor))
        {
            self.active_editor = None;
        }
        cx.notify();
    }

    pub(crate) fn open_folder(
        &mut self,
        _: &OpenFolder,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open LaTeX Project".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(root) = paths.into_iter().next() else {
                return;
            };
            this.update_in(cx, |this, window, cx| this.open_project(root, window, cx))
                .ok();
        })
        .detach();
    }

    fn open_editors(&mut self) -> Vec<Entity<EditorPanel>> {
        self.editors.retain(|editor| editor.upgrade().is_some());
        self.editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .collect()
    }

    /// Start saving each of `editors` that holds unsaved edits.
    fn save_dirty(
        editors: &[Entity<EditorPanel>],
        cx: &mut Context<Self>,
    ) -> Vec<Task<anyhow::Result<bool>>> {
        let dirty: Vec<_> = editors
            .iter()
            .filter(|editor| editor.read(cx).is_dirty(cx))
            .cloned()
            .collect();
        dirty
            .into_iter()
            .map(|editor| editor.update(cx, |editor, cx| editor.save(cx)))
            .collect()
    }

    fn save_in_background(&mut self, cx: &mut Context<Self>) {
        let editors = self.open_editors();
        for save in Self::save_dirty(&editors, cx) {
            cx.spawn(async move |_, _| {
                if let Err(error) = save.await {
                    log::error!("{error:#}");
                }
            })
            .detach();
        }
    }

    /// The editor the writer was last in, if it is still open.
    pub(crate) fn active_editor(&self) -> Option<Entity<EditorPanel>> {
        self.active_editor.as_ref().and_then(WeakEntity::upgrade)
    }

    /// ⌘S: save, then build, as the Tauri app's "Save and build" does; only
    /// a save when there is no document to build. A build under way queues
    /// the next one, which would save only once it starts, so the save is
    /// made now.
    fn save_all(&mut self, _: &Save, window: &mut Window, cx: &mut Context<Self>) {
        let build = self.has_document(cx);
        if !build || self.build_task.is_some() {
            self.save_in_background(cx);
        }
        if build {
            self.run_build(BuildRequest::requested(), window, cx);
        }
    }

    fn toggle_vim_mode(&mut self, _: &ToggleVimMode, _: &mut Window, cx: &mut Context<Self>) {
        self.vim_mode = !self.vim_mode;
        crate::app::set_vim_mode(self.vim_mode, cx);
        cx.notify();
    }

    /// Whether the build panel is anywhere in the dock area (it can be
    /// dragged out of the bottom dock).
    pub fn build_panel_shown(&self, cx: &App) -> bool {
        self.panel_shown(PanelId::from(self.build_panel.entity_id()), cx)
    }

    /// Show the build panel under the editors, or take it out of wherever it
    /// is. A closed bottom dock would keep a strip of its tabs on screen,
    /// which the Tauri app does not have, so a bottom dock is made for the
    /// panel and taken away once nothing is left in it.
    pub fn show_build_panel(&mut self, shown: bool, window: &mut Window, cx: &mut Context<Self>) {
        if shown == self.build_panel_shown(cx) {
            return;
        }
        if shown {
            self.show_view(layout::View::Build, window, cx);
        } else {
            self.hide_view(&layout::View::Build, window, cx);
        }
        cx.notify();
    }

    /// The workspace area's size, for arrangements laid out to the window.
    pub(crate) fn room(&self, window: &Window) -> layout::Room {
        let size = window.viewport_size();
        layout::Room::for_window(size.width, size.height)
    }
}

/// A new window's size: 1440×900, or `LATTICE_WINDOW_SIZE` (`1015x680`), which
/// lets a run lay the window out as a smaller screen would (GitHub's runners
/// shrink the window to about 1015px wide).
fn window_size() -> gpui::Size<gpui::Pixels> {
    std::env::var("LATTICE_WINDOW_SIZE")
        .ok()
        .and_then(|value| {
            let (width, height) = value.split_once('x')?;
            Some(size(
                px(width.trim().parse().ok()?),
                px(height.trim().parse().ok()?),
            ))
        })
        .unwrap_or_else(|| size(px(1440.), px(900.)))
}

/// The name of a project that is not open, as its tab shows it: the name in
/// its manifest, else the folder's.
pub fn project_display_name(root: &Path) -> SharedString {
    lattice_core::project::read_manifest(root)
        .ok()
        .map(|manifest| manifest.name)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
        .into()
}

#[cfg(target_os = "macos")]
fn titlebar_options() -> Option<gpui::TitlebarOptions> {
    // Lattice draws its own 40px titlebar with the traffic lights centred in
    // it, 20px from the top (src-tauri/src/traffic_lights.rs).
    Some(gpui::TitlebarOptions {
        title: None,
        appears_transparent: true,
        traffic_light_position: Some(gpui::point(px(14.), px(13.))),
    })
}

/// Elsewhere the system keeps its title bar, and Lattice's sits under it.
#[cfg(not(target_os = "macos"))]
fn titlebar_options() -> Option<gpui::TitlebarOptions> {
    None
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = cx.palette().clone();
        let shell = v_flex()
            .id("lattice-shell")
            .key_context("LatticeShell")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::open_folder))
            .on_action(cx.listener(Self::build))
            .on_action(cx.listener(Self::save_all))
            .on_action(cx.listener(Self::forward_sync))
            .on_action(cx.listener(Self::toggle_vim_mode));
        self.register_commands(shell, cx)
            .relative()
            .size_full()
            .bg(palette.window)
            .text_color(palette.text)
            .child(crate::titlebar::render(self, window, cx))
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .bg(palette.chrome)
                    .pt(px(WORKSPACE_TOP))
                    .px(px(WORKSPACE_SIDE))
                    .pb(px(WORKSPACE_SIDE))
                    .children(lattice_ui::parity::probe("workspace"))
                    .child(self.dock_area.clone())
                    .when(self.center_empty(cx), |this| {
                        this.child(arrange::empty_center(self, cx))
                    })
                    .children(self.floating.render(cx)),
            )
            .children(self.palette.clone())
            .children(self.shortcuts.clone())
            .child(self.notices.clone())
            .child(self.confirm.clone())
    }
}
