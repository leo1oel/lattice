//! The window: Lattice's titlebar over GPUI Kit's dock area in Lattice's
//! look, holding the file tree, the editors, the PDF preview and the build
//! panel; and the flows that tie them together on lattice-core: open a
//! project, open a file, build, jump between the source and the PDF
//! (SyncTeX), and the file tree's create, rename, move and delete.

use std::path::{Path, PathBuf};

use futures::channel::oneshot;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, PathPromptOptions,
    PromptLevel, Render, SharedString, Styled as _, Task, WeakEntity, Window, WindowBounds,
    WindowOptions, actions, div, px, size,
};
use gpui_kit::component::{
    dock::{DockArea, DockLayout, DockPlacement, PanelId, panel_handle},
    v_flex,
};
use lattice_ui::{ActiveLattice as _, Appearance, LatticeTheme, dock::LatticeDock};

mod build;
mod entries;
mod synctex;

use build::BuildRequest;

use crate::{
    build_panel::{BuildPanel, OpenLocation},
    confirm::{self, ConfirmHost},
    editor_panel::{EditorPanel, EditorPanelEvent},
    file_tree::FileTreePanel,
    notices::{self, NoticeStack},
    pdf::{PdfEvent, PdfPanel},
    project::Project,
    titlebar::TitlebarDrag,
};

actions!(
    lattice,
    [
        OpenFolder,
        Build,
        Save,
        ForwardSync,
        ToggleVimMode,
        ToggleProjectPanel,
        TogglePdfPanel,
        ToggleBuildPanel
    ]
);

/// The docks' widths as the running app lays out the Main window at
/// 1440×900: a 329px Project card and a 485px PDF card, each with the 3px
/// half-gutter its group pads itself by on either side.
const LEFT_DOCK: f32 = 329. + 6.;
const RIGHT_DOCK: f32 = 485. + 6.;
/// The chrome around the cards: 12px from the window's sides and bottom and
/// 6px under the titlebar, less the groups' own half-gutter.
const WORKSPACE_SIDE: f32 = 12. - 3.;
const WORKSPACE_TOP: f32 = 6. - 3.;
/// The build panel's height when it is shown under the editors.
const BUILD_DOCK: f32 = 180. + 6.;

/// Open folder, build, save and the jump to the PDF, on the platform's
/// primary shortcut modifier; the jump is the Tauri app's ⌘⇧J.
#[cfg(target_os = "macos")]
const SHORTCUTS: [&str; 4] = ["cmd-o", "cmd-b", "cmd-s", "cmd-shift-j"];
#[cfg(not(target_os = "macos"))]
const SHORTCUTS: [&str; 4] = ["ctrl-o", "ctrl-b", "ctrl-s", "ctrl-shift-j"];

#[cfg(target_os = "macos")]
pub const BUILD_SHORTCUT_LABEL: &str = "⌘B";
#[cfg(not(target_os = "macos"))]
pub const BUILD_SHORTCUT_LABEL: &str = "Ctrl+B";

pub fn bind_keys(cx: &mut App) {
    let [open, build, save, forward] = SHORTCUTS;
    cx.bind_keys([
        KeyBinding::new(open, OpenFolder, None),
        KeyBinding::new(build, Build, None),
        KeyBinding::new(save, Save, None),
        KeyBinding::new(forward, ForwardSync, None),
    ]);
}

pub struct Shell {
    project: Option<Entity<Project>>,
    focus_handle: FocusHandle,
    dock_area: Entity<DockArea>,
    titlebar_drag: TitlebarDrag,
    file_tree: Entity<FileTreePanel>,
    pdf: Entity<PdfPanel>,
    build_panel: Entity<BuildPanel>,
    notices: Entity<NoticeStack>,
    confirm: Entity<ConfirmHost>,
    editors: Vec<WeakEntity<EditorPanel>>,
    /// The editor the writer was last in, which a build compiles from and a
    /// jump to the PDF starts from.
    active_editor: Option<WeakEntity<EditorPanel>>,
    build_task: Option<Task<()>>,
    /// The build to run once the one under way ends.
    queued_build: Option<BuildRequest>,
    /// Told when the builds under way, queued ones included, are over.
    build_waiters: Vec<oneshot::Sender<()>>,
    _open_task: Option<Task<()>>,
    vim_mode: bool,
}

impl Shell {
    pub fn open_window(
        root: Option<PathBuf>,
        cx: &mut App,
    ) -> anyhow::Result<(AnyWindowHandle, Entity<Shell>)> {
        let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(720.), px(480.))),
            titlebar: titlebar_options(),
            ..Default::default()
        };
        let (window, shell) = gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| Shell::new(window, cx))
        })?;
        if let Some(root) = root {
            window.update(cx, |_, window, cx| {
                shell.update(cx, |shell, cx| shell.open_project(root, window, cx));
            })?;
        }
        Ok((window, shell))
    }

    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::panels::present_tabs(cx);
        let dock_area = LatticeDock::dock_area("lattice", Some(1), window, cx);
        let file_tree = cx.new(FileTreePanel::new);
        let pdf = cx.new(PdfPanel::new);
        let build_panel = cx.new(BuildPanel::new);
        let notices = notices::install(cx);
        let confirm = confirm::install(cx);

        // The system's appearance, unless the run fixed one.
        if crate::app::appearance_override().is_none() {
            cx.observe_window_appearance(window, |_, window, cx| {
                LatticeTheme::set_appearance(Appearance::from(window.appearance()), cx);
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

        dock_area.update(cx, |area, cx| {
            area.set_center(DockLayout::v_split(), window, cx);
            area.set_dock(
                DockPlacement::Left,
                DockLayout::v_split().child(
                    DockLayout::tabs().panel_view(panel_handle(file_tree.clone()), cx),
                    None,
                ),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Left, px(LEFT_DOCK), window, cx);
            area.set_dock(
                DockPlacement::Right,
                DockLayout::v_split().child(
                    DockLayout::tabs().panel_view(panel_handle(pdf.clone()), cx),
                    None,
                ),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Right, px(RIGHT_DOCK), window, cx);
            for placement in [DockPlacement::Left, DockPlacement::Right] {
                area.set_dock_collapsible(placement, true, window, cx);
            }
        });
        // The Main window has no bottom panel: the build panel is added when a
        // build reports errors, or from the Panels menu (`show_build_panel`).

        Self {
            project: None,
            focus_handle: cx.focus_handle(),
            dock_area,
            titlebar_drag: TitlebarDrag::default(),
            file_tree,
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
        }
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
    /// title in its `project.toml`, else the folder's name.
    pub fn project_name(&self, cx: &App) -> SharedString {
        let Some(root) = self.root(cx) else {
            return "Open a project".into();
        };
        project_title(&root)
            .or_else(|| {
                root.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_default()
            .into()
    }

    /// Open a project folder with lattice-core, as the Tauri app opens it:
    /// show it in the tree, open its main document, and preview its PDF when
    /// one was already built. The files of the project open before are saved
    /// and their tabs closed.
    pub fn open_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let saves = self.close_editors(window, cx);
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
        self.project = Some(project.clone());
        self.queued_build = None;
        self.file_tree
            .update(cx, |tree, cx| tree.set_project(project, cx));
        window.set_window_title(&format!(
            "{} — Lattice (GPUI preview)",
            root.file_name().unwrap_or_default().to_string_lossy()
        ));
        if let Some(main) = main {
            self.open_path(main, None, window, cx);
        }
        self.pdf.update(cx, |panel, cx| match pdf {
            Some(pdf) => panel.open(pdf, window, cx),
            None => panel.close(window, cx),
        });
        cx.notify();
    }

    /// Save every open file and close its tab, before another project opens.
    fn close_editors(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Task<anyhow::Result<bool>>> {
        let editors = self.open_editors();
        let saves = Self::save_dirty(&editors, cx);
        for editor in editors {
            self.dock_area
                .update(cx, |area, cx| area.remove_panel(editor, window, cx));
        }
        self.editors.clear();
        self.active_editor = None;
        saves
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
            return None;
        }
        let project = self.project.clone()?;
        let path = path.canonicalize().unwrap_or(path);
        let existing = self
            .open_editors()
            .into_iter()
            .find(|editor| editor.read(cx).path() == path);
        let editor = match existing {
            Some(editor) => {
                let id = PanelId::from(editor.entity_id());
                self.dock_area
                    .update(cx, |area, cx| area.select_panel(id, window, cx));
                editor
            }
            None => {
                match EditorPanel::open(path.clone(), project, self.build_panel.clone(), window, cx)
                {
                    Ok(editor) => {
                        cx.subscribe_in(&editor, window, Self::on_editor_event)
                            .detach();
                        self.dock_area.update(cx, |area, cx| {
                            area.add_panel_view(
                                panel_handle(editor.clone()),
                                DockPlacement::Center,
                                None,
                                window,
                                cx,
                            );
                        });
                        self.editors.push(editor.downgrade());
                        editor
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
                        return None;
                    }
                }
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
            EditorPanelEvent::SavedForBuild => {
                self.run_build(BuildRequest::automatic(), window, cx);
            }
            EditorPanelEvent::DiskEdit => {
                if crate::app::auto_build(cx) {
                    self.run_build(BuildRequest::automatic(), window, cx);
                }
            }
            EditorPanelEvent::Close => self.close_editor(editor, window, cx),
        }
    }

    fn close_editor(
        &mut self,
        editor: &Entity<EditorPanel>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dock_area
            .update(cx, |area, cx| area.remove_panel(editor.clone(), window, cx));
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

    /// The editor the writer was last in, if it is still open.
    pub(crate) fn active_editor(&self) -> Option<Entity<EditorPanel>> {
        self.active_editor.as_ref().and_then(WeakEntity::upgrade)
    }

    fn save_all(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
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

    fn toggle_vim_mode(&mut self, _: &ToggleVimMode, _: &mut Window, cx: &mut Context<Self>) {
        self.vim_mode = !self.vim_mode;
        crate::app::set_vim_mode(self.vim_mode, cx);
        cx.notify();
    }

    /// Whether the build panel is anywhere in the dock area (it can be
    /// dragged out of the bottom dock).
    pub fn build_panel_shown(&self, cx: &App) -> bool {
        self.dock_area
            .read(cx)
            .panel(PanelId::from(self.build_panel.entity_id()))
            .is_some()
    }

    /// Add the build panel to the bottom dock, or take it out of wherever it
    /// is. Only the build panel moves: anything else dragged into the bottom
    /// dock stays. A closed bottom dock would keep a strip of its tabs on
    /// screen, which the Tauri app does not have, so a bottom dock is made
    /// for the panel and taken away once nothing is left in it.
    pub fn show_build_panel(&mut self, shown: bool, window: &mut Window, cx: &mut Context<Self>) {
        if shown == self.build_panel_shown(cx) {
            return;
        }
        let build = self.build_panel.clone();
        self.dock_area.update(cx, |area, cx| {
            if !shown {
                area.remove_panel(build, window, cx);
                if area
                    .layout(DockPlacement::Bottom)
                    .is_some_and(|tree| tree.panels().next().is_none())
                {
                    area.remove_dock(DockPlacement::Bottom, window, cx);
                }
            } else if area.has_dock(DockPlacement::Bottom) {
                area.add_panel_view(panel_handle(build), DockPlacement::Bottom, None, window, cx);
            } else {
                area.set_dock(
                    DockPlacement::Bottom,
                    DockLayout::v_split()
                        .child(DockLayout::tabs().panel_view(panel_handle(build), cx), None),
                    window,
                    cx,
                );
                area.set_dock_size(DockPlacement::Bottom, px(BUILD_DOCK), window, cx);
            }
        });
        cx.notify();
    }

    fn toggle_dock(
        &mut self,
        placement: DockPlacement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.dock_area
            .update(cx, |area, cx| area.toggle_dock(placement, window, cx));
        cx.notify();
    }
}

/// `title` in the `[project]` table of a Lattice project's `project.toml`.
/// A line scan, not a TOML parser: the manifest is the app's own.
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
        v_flex()
            .id("lattice-shell")
            .key_context("LatticeShell")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::open_folder))
            .on_action(cx.listener(Self::build))
            .on_action(cx.listener(Self::save_all))
            .on_action(cx.listener(Self::forward_sync))
            .on_action(cx.listener(Self::toggle_vim_mode))
            .on_action(cx.listener(|this, _: &ToggleProjectPanel, window, cx| {
                this.toggle_dock(DockPlacement::Left, window, cx)
            }))
            .on_action(cx.listener(|this, _: &TogglePdfPanel, window, cx| {
                this.toggle_dock(DockPlacement::Right, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ToggleBuildPanel, window, cx| {
                let shown = this.build_panel_shown(cx);
                this.show_build_panel(!shown, window, cx)
            }))
            .relative()
            .size_full()
            .bg(palette.window)
            .text_color(palette.text)
            .child(crate::titlebar::render(self, window, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .bg(palette.chrome)
                    .pt(px(WORKSPACE_TOP))
                    .px(px(WORKSPACE_SIDE))
                    .pb(px(WORKSPACE_SIDE))
                    .children(lattice_ui::parity::probe("workspace"))
                    .child(self.dock_area.clone()),
            )
            .child(self.notices.clone())
            .child(self.confirm.clone())
    }
}
