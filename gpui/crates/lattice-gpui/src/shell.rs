//! The window: Lattice's titlebar over GPUI Kit's dock area in Lattice's
//! look, holding the file tree, Papers and the Agent, the editors, the PDF
//! preview and the build panel; and the flows that tie them together (open a
//! project, open a file, build).
//!
//! The shell's own parts live beside it: the arrangement of panels and the
//! named workspaces (`layout`, `workspaces`, `arrange`, `workspace_flow`),
//! the command table, keymap and palette (`commands`, `actions`, `palette`),
//! the menu bar (`menus`),
//! windows and project tabs (`windows`), and floating panels (`floating`).

mod actions;
mod arrange;
pub mod commands;
mod floating;
pub mod layout;
pub(crate) mod menus;
mod palette;
pub mod windows;
mod workspace_flow;
pub mod workspaces;

use std::path::{Path, PathBuf};

use futures::{StreamExt as _, channel::mpsc};
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

pub use commands::{Build, OpenFolder, Save, ToggleVimMode};

use crate::{
    build_panel::{BuildPanel, OpenLocation},
    editor_panel::EditorPanel,
    file_tree::{FileTreePanel, OpenFile},
    pdf::PdfPanel,
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
    root: Option<PathBuf>,
    pub(crate) focus_handle: FocusHandle,
    dock_area: Entity<DockArea>,
    titlebar_drag: TitlebarDrag,
    file_tree: Entity<FileTreePanel>,
    papers: Entity<StandInPanel>,
    agent: Entity<StandInPanel>,
    pdf: Entity<PdfPanel>,
    build_panel: Entity<BuildPanel>,
    editors: Vec<WeakEntity<EditorPanel>>,
    build_task: Option<Task<()>>,
    vim_mode: bool,
    pub(crate) layout: LayoutState,
    pub(crate) floating: floating::FloatingLayer,
    palette: Option<Entity<palette::CommandPaletteView>>,
    shortcuts: Option<Entity<palette::ShortcutSheet>>,
    /// The projects open in this window, in tab order; the open one is
    /// `root`.
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

        // The system's appearance, unless the run or the writer fixed one.
        if crate::app::appearance_override().is_none() {
            cx.observe_window_appearance(window, |_, window, cx| {
                if !crate::app::appearance_chosen(cx) {
                    LatticeTheme::set_appearance(Appearance::from(window.appearance()), cx);
                }
            })
            .detach();
        }

        cx.subscribe_in(&file_tree, window, |this, _, OpenFile(path), window, cx| {
            this.open_path(path.clone(), None, window, cx);
        })
        .detach();
        cx.subscribe_in(
            &build_panel,
            window,
            |this, _, location: &OpenLocation, window, cx| {
                this.open_path(location.path.clone(), location.line, window, cx);
            },
        )
        .detach();
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
            root: None,
            focus_handle: cx.focus_handle(),
            dock_area,
            titlebar_drag: TitlebarDrag::default(),
            file_tree,
            papers,
            agent,
            pdf,
            build_panel,
            editors: Vec::new(),
            build_task: None,
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn root(&self) -> Option<&PathBuf> {
        self.root.as_ref()
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn pdf(&self) -> &Entity<PdfPanel> {
        &self.pdf
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn build_panel(&self) -> &Entity<BuildPanel> {
        &self.build_panel
    }

    pub fn dock_area(&self) -> &Entity<DockArea> {
        &self.dock_area
    }

    pub(crate) fn titlebar_drag(&self) -> &TitlebarDrag {
        &self.titlebar_drag
    }

    /// The open project's name, as the titlebar's switcher shows it: the
    /// title in its `project.toml`, else the folder's name.
    pub fn project_name(&self) -> SharedString {
        match &self.root {
            Some(root) => project_display_name(root),
            None => "Open a project".into(),
        }
    }

    /// Open a project folder: show it in the tree, lay the window out as the
    /// project was left (its documents, its workspace), and preview its PDF
    /// when one was already built.
    pub fn open_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let root = root.canonicalize().unwrap_or(root);
        self.dock_floating(window, cx);
        self.save_layout(cx);
        self.save_in_background(cx);
        if !self.projects.contains(&root) {
            match self
                .root
                .as_ref()
                .and_then(|current| self.projects.iter().position(|p| p == current))
            {
                Some(ix) => self.projects.insert(ix + 1, root.clone()),
                None => self.projects.push(root.clone()),
            }
        }
        self.root = Some(root.clone());
        self.closed_tabs.clear();
        self.file_tree
            .update(cx, |tree, cx| tree.set_root(root.clone(), cx));
        window.set_window_title(&format!(
            "{} — Lattice (GPUI preview)",
            root.file_name().unwrap_or_default().to_string_lossy()
        ));
        let main = tex::find_main_document(&root);
        let pdf = main
            .as_ref()
            .map(|main| main.with_extension("pdf"))
            .filter(|pdf| pdf.is_file());
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
        self.editors.retain(|editor| editor.upgrade().is_some());
        self.editors
            .iter()
            .filter_map(WeakEntity::upgrade)
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
        match EditorPanel::open(path.to_path_buf(), self.build_panel.clone(), window, cx) {
            Ok(editor) => {
                self.editors.push(editor.downgrade());
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

    fn open_editors(&self) -> Vec<Entity<EditorPanel>> {
        self.editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .collect()
    }

    /// Start writing every edited file.
    pub(crate) fn save_edited(&self, cx: &mut Context<Self>) -> Vec<Task<anyhow::Result<()>>> {
        let dirty: Vec<_> = self
            .open_editors()
            .into_iter()
            .filter(|editor| editor.read(cx).is_dirty(cx))
            .collect();
        dirty
            .into_iter()
            .map(|editor| editor.update(cx, |editor, cx| editor.save(cx)))
            .collect()
    }

    fn save_in_background(&self, cx: &mut Context<Self>) {
        for save in self.save_edited(cx) {
            cx.spawn(async move |_, _| {
                if let Err(error) = save.await {
                    log::error!("{error:#}");
                }
            })
            .detach();
        }
    }

    /// ⌘S: save and build, as the Tauri app does; a plain save while a build
    /// runs or when there is nothing to build.
    fn save_all(&mut self, _: &Save, window: &mut Window, cx: &mut Context<Self>) {
        let buildable = self.build_task.is_none()
            && self
                .root
                .as_deref()
                .is_some_and(|root| tex::find_main_document(root).is_some());
        if buildable {
            self.build(&Build, window, cx);
        } else {
            self.save_in_background(cx);
        }
    }

    /// Save every edited file, run latexmk on the main document in the
    /// background with its output streaming into the build panel, then show
    /// the diagnostics and reload the PDF.
    pub fn build(&mut self, _: &Build, window: &mut Window, cx: &mut Context<Self>) {
        if self.build_task.is_some() {
            return;
        }
        let Some(root) = self.root.clone() else {
            return;
        };
        let Some(document) = tex::find_main_document(&root) else {
            self.build_panel.update(cx, |panel, cx| {
                panel.failed(
                    "No main.tex or other top-level .tex file with \\documentclass in this folder."
                        .into(),
                    cx,
                )
            });
            return;
        };
        let saves = self.save_edited(cx);
        self.build_panel
            .update(cx, |panel, cx| panel.started(&document, cx));

        let build_panel = self.build_panel.clone();
        self.build_task = Some(cx.spawn_in(window, async move |this, cx| {
            for save in saves {
                if let Err(error) = save.await {
                    log::error!("{error:#}");
                }
            }
            let (lines, mut received) = mpsc::unbounded::<String>();
            let build = cx.background_spawn(async move {
                tex::build(&document, |line| {
                    lines.unbounded_send(line.to_string()).ok();
                })
            });
            while let Some(line) = received.next().await {
                let mut batch = vec![line];
                while let Ok(line) = received.try_recv() {
                    batch.push(line);
                }
                build_panel.update(cx, |panel, cx| panel.push_lines(batch, cx));
            }
            let outcome = build.await;
            this.update_in(cx, |this, window, cx| {
                this.finish_build(&root, outcome, window, cx)
            })
            .ok();
        }));
        cx.notify();
    }

    fn finish_build(
        &mut self,
        root: &Path,
        outcome: std::io::Result<tex::BuildOutcome>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.build_task = None;
        let current = self.root.as_deref() == Some(root);
        match outcome {
            Ok(outcome) => {
                self.build_panel
                    .update(cx, |panel, cx| panel.finished(&outcome, cx));
                if current && let Some(pdf) = outcome.pdf.clone() {
                    self.pdf.update(cx, |panel, cx| panel.open(pdf, window, cx));
                }
                if current && outcome.error_count() > 0 {
                    self.show_build_panel(true, window, cx);
                }
            }
            Err(error) => {
                let message = if error.kind() == std::io::ErrorKind::NotFound {
                    "latexmk was not found. Install MacTeX, MiKTeX or TeX Live.".to_string()
                } else {
                    format!("Could not run latexmk: {error}")
                };
                self.build_panel
                    .update(cx, |panel, cx| panel.failed(message, cx));
            }
        }
        self.file_tree.update(cx, |tree, cx| tree.refresh(cx));
        cx.notify();
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
            let mut arrangement = self.current_arrangement(cx);
            match &mut arrangement.bottom {
                Some(dock) => {
                    match &mut dock.node {
                        layout::Node::Tabs { views, active } => {
                            views.push(layout::View::Build);
                            *active = views.len() - 1;
                        }
                        node @ layout::Node::Split { .. } => {
                            let existing = std::mem::take(node);
                            *node = layout::Node::Split {
                                axis: layout::SplitAxis::Row,
                                children: vec![existing, layout::Node::tabs([layout::View::Build])],
                                sizes: vec![None, None],
                            };
                        }
                    }
                    dock.open = true;
                }
                None => {
                    arrangement.bottom = Some(layout::Dock {
                        node: layout::Node::tabs([layout::View::Build]),
                        size: BUILD_DOCK,
                        open: true,
                    })
                }
            }
            self.install(&arrangement, window, cx);
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

/// A project's name, as its switcher and its tab show it: the title in its
/// `project.toml`, else the folder's name.
pub fn project_display_name(root: &Path) -> SharedString {
    project_title(root)
        .or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default()
        .into()
}

/// `title` in the `[project]` table of a Lattice project's `project.toml`.
/// A line scan, not a TOML parser: the manifest is the app's own, and the
/// shared backend crate will read it properly.
fn project_title(root: &Path) -> Option<String> {
    let manifest = std::fs::read_to_string(root.join("project.toml")).ok()?;
    let mut in_project = false;
    for line in manifest.lines().map(str::trim) {
        if line.starts_with('[') {
            in_project = line == "[project]";
        } else if in_project && let Some(value) = line.strip_prefix("title") {
            let value = value.trim_start().strip_prefix('=')?.trim();
            return Some(value.trim_matches('"').to_string()).filter(|title| !title.is_empty());
        }
    }
    None
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
    }
}
