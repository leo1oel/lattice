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
//! panels (`floating`), builds (`build`, `build_tools`), the tree's operations (`entries`),
//! the PDFs (`pdfs`) and SyncTeX (`synctex`).

mod actions;
mod arrange;
mod build;
mod build_tools;
pub mod commands;
mod documents;
mod entries;
mod floating;
mod ground;
mod imports;
pub mod layout;
pub(crate) mod menus;
mod palette;
mod papers;
mod pdfs;
mod render;
mod saving;
mod synctex;
mod welcome_flow;
pub mod windows;
mod workspace_flow;
pub mod workspaces;

use std::path::{Path, PathBuf};

use futures::channel::oneshot;
use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, ParentElement as _, PromptLevel, Render, SharedString,
    Styled as _, Subscription, Task, WeakEntity, Window, WindowBounds, WindowOptions,
    prelude::FluentBuilder as _, px, size,
};
use gpui_kit::component::{
    dock::{DockArea, DockEvent, PanelId},
    v_flex,
};
use lattice_i18n::{t, tc};
use lattice_ui::{ActiveLattice as _, Appearance, LatticeTheme, dock::LatticeDock};

use build::BuildRequest;
pub use commands::{
    Build, CleanBuildFiles, CleanRebuild, ForwardSync, InstallLatexTools, NextProblem,
    OpenTexDoctor, PreviousProblem, Save, StopBuild, ToggleVimMode,
};

use crate::{
    build::{
        tex_setup::center::{self as tex_setup, TexSetupCenter, TexSetupEvent},
        word_count::{self, ManuscriptWords},
    },
    build_panel::{BuildAction, BuildPanel, DiagnosticsCard, OpenLocation},
    confirm::{self, ConfirmHost},
    editor_panel::{EditorPanel, EditorPanelEvent},
    file_tree::FileTreePanel,
    notices::{self, NoticeStack},
    papers::PapersPanel,
    pdf::{PdfPanel, PdfPanelKind},
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
    /// Where each document stood in each workspace, by workspace id.
    pub places: std::collections::BTreeMap<String, std::collections::BTreeMap<String, u64>>,
}

/// A project open in a window, with the name its tab shows.
pub(crate) struct OpenProject {
    pub root: PathBuf,
    pub name: SharedString,
}

pub struct Shell {
    project: Option<Entity<Project>>,
    pub(crate) focus_handle: FocusHandle,
    dock_area: Entity<DockArea>,
    titlebar_drag: TitlebarDrag,
    file_tree: Entity<FileTreePanel>,
    papers: Entity<PapersPanel>,
    agent: Entity<StandInPanel>,
    pdf: Entity<PdfPanel>,
    build_panel: Entity<BuildPanel>,
    /// The TeX doctor, setup and package installs (one for the app).
    tex_setup: Entity<TexSetupCenter>,
    /// The open project's manuscript word count (one for the app).
    words: Entity<ManuscriptWords>,
    /// The auxiliary files are being deleted.
    cleaning: bool,
    /// A setup dialog or the TeX doctor is up.
    setup_dialog_open: bool,
    /// Says a build has run for minutes, and offers to stop it.
    slow_build: Option<Task<()>>,
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
    /// The root document the next build compiles, asked for from its PDF
    /// tab; otherwise the editor's or the project's.
    build_target: Option<String>,
    /// The root document whose PDF the live panel shows.
    live_document: Option<String>,
    /// The other root documents' tabs, each with its last PDF.
    root_pdfs: Vec<(String, Entity<PdfPanel>)>,
    /// The project's PDFs opened from the tree.
    file_pdfs: Vec<Entity<PdfPanel>>,
    /// The live document's outline.
    outline: std::rc::Rc<[crate::outline::Heading]>,
    _outline_task: Option<Task<()>>,
    _open_task: Option<Task<()>>,
    pub(crate) layout: LayoutState,
    pub(crate) floating: floating::FloatingLayer,
    /// Each of the dock's groups' own id (`layout::Node::Tabs`'s `slot`),
    /// which Kit's node ids, new at every rebuild, do not keep.
    slots: std::collections::HashMap<gpui_kit::component::dock::NodeId, u64>,
    palette: Option<Entity<palette::CommandPaletteView>>,
    shortcuts: Option<Entity<palette::ShortcutSheet>>,
    /// Quick open, Find and Replace in project, and the files visited.
    documents: documents::Documents,
    /// The welcome screen and New project, without a project or over one.
    lobby: welcome_flow::Lobby,
    /// Settings, while it is open in this window.
    pub(crate) settings: Option<Entity<crate::settings::SettingsDialog>>,
    /// The projects open in this window, in tab order; the open one is
    /// `project`'s.
    pub(crate) projects: Vec<OpenProject>,
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
        let bounds = bounds.unwrap_or_else(|| Bounds::centered(None, windows::window_size(), cx));
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(720.), px(480.))),
            titlebar: windows::titlebar_options(),
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
        window.update(cx, |_, window, cx| {
            shell.update(cx, |shell, cx| match root {
                Some(root) => shell.open_project(root, window, cx),
                None => shell.show_welcome(None, window, cx),
            });
        })?;
        Ok((window, shell))
    }

    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::panels::present_tabs(cx);
        arrange::install_dock_hooks(cx);
        let dock_area = LatticeDock::dock_area("lattice", Some(1), window, cx);
        let file_tree = cx.new(FileTreePanel::new);
        let papers = cx.new(|cx| PapersPanel::new(window, cx));
        let agent = cx.new(|cx| StandInPanel::new(StandIn::Agent, cx));
        let pdf = cx.new(|cx| PdfPanel::new(PdfPanelKind::Live, window, cx));
        let build_panel = cx.new(BuildPanel::new);
        let card = cx.new(|cx| DiagnosticsCard::new(build_panel.clone(), cx));
        pdf.update(cx, |pdf, cx| pdf.set_build_output(card.into(), cx));
        let tex_setup = tex_setup::install(cx);
        tex_setup.update(cx, |center, cx| center.check_at_launch(cx));
        let words = word_count::manuscript_words(cx);
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

        cx.observe_window_activation(window, |_, window, cx| {
            if window.is_window_active() {
                menus::refresh(cx);
            }
        })
        .detach();
        cx.subscribe_in(&file_tree, window, Self::on_tree_event)
            .detach();
        cx.subscribe_in(&papers, window, Self::on_papers_event)
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
            &build_panel,
            window,
            |this, _, action: &BuildAction, window, cx| this.on_build_action(action, window, cx),
        )
        .detach();
        cx.subscribe_in(
            &tex_setup,
            window,
            |this, _, event: &TexSetupEvent, window, cx| match event {
                TexSetupEvent::Rebuild => this.run_build(BuildRequest::requested(), window, cx),
            },
        )
        .detach();
        cx.observe_in(&tex_setup, window, |this, center, window, cx| {
            this.setup_dialog_closed(center.read(cx).dialog_open(), window, cx);
            cx.notify();
        })
        .detach();
        // The status bars read the manuscript count: redraw them when it lands.
        cx.observe(&words, |this, _, cx| {
            for editor in this.open_editors() {
                editor.update(cx, |_, cx| cx.notify());
            }
        })
        .detach();
        cx.subscribe_in(&pdf, window, Self::on_pdf_event).detach();
        cx.observe(&notices, |_, _, cx| cx.notify()).detach();
        cx.observe(&confirm, |_, _, cx| cx.notify()).detach();
        let dock_events = cx.subscribe_in(&dock_area, window, |this, _, event, window, cx| {
            if let DockEvent::LayoutChanged = event {
                this.forget_closed_pdfs(cx);
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
            tex_setup,
            words,
            cleaning: false,
            setup_dialog_open: false,
            slow_build: None,
            notices,
            confirm,
            editors: Vec::new(),
            active_editor: None,
            build_task: None,
            queued_build: None,
            build_waiters: Vec::new(),
            build_target: None,
            live_document: None,
            root_pdfs: Vec::new(),
            file_pdfs: Vec::new(),
            outline: std::rc::Rc::from([]),
            _outline_task: None,
            _open_task: None,
            layout: LayoutState::default(),
            floating: floating::FloatingLayer::default(),
            slots: Default::default(),
            palette: None,
            shortcuts: None,
            documents: Default::default(),
            lobby: Default::default(),
            settings: None,
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
    pub fn papers(&self) -> &Entity<PapersPanel> {
        &self.papers
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

    /// Whether Clean is still deleting the auxiliary files, which turns a
    /// clean rebuild away until it is done.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn cleaning(&self) -> bool {
        self.cleaning
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
            None => t!("Open a project").into(),
        }
    }

    /// The window's title, in the interface language: the project's folder.
    pub(crate) fn set_window_title(&self, window: &mut Window, cx: &App) {
        if let Some(root) = self.root(cx) {
            window.set_window_title(&t!(
                "{0} — Lattice (GPUI preview)",
                root.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }

    /// Open a project folder with lattice-core, as the Tauri app opens it,
    /// laid out as the project was left (its documents, its workspace). The
    /// project open before keeps its tab in the window: its layout is
    /// recorded and its edited files saved first.
    pub fn open_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        self.leave_for(root, None, window, cx);
    }

    /// Open `root` in place of the project shown, once the shown project's
    /// edits are saved, taking the `closing` project's tab out with it. A
    /// save that fails or is held keeps the shown project, its editors and
    /// the save's notice, as closing the window does.
    fn leave_for(
        &mut self,
        root: PathBuf,
        closing: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.save_layout(cx);
        let saved = self.save_before_leaving(cx);
        self._open_task = Some(cx.spawn_in(window, async move |this, cx| {
            if let Some(saved) = saved
                && !saved.await
            {
                return;
            }
            match crate::project::open(root.clone(), cx).await {
                Ok(project) => {
                    this.update_in(cx, |this, window, cx| {
                        this.set_project(project, window, cx);
                        if let Some(closing) = closing {
                            this.projects.retain(|p| p.root != closing);
                        }
                    })
                    .ok();
                }
                Err(error) => {
                    log::error!("could not open {}: {error}", root.display());
                    cx.update(|_, cx| notices::error(t!("Could not open the project"), error, cx))
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
        if !self.projects.iter().any(|p| p.root == root) {
            let open = OpenProject {
                name: windows::project_display_name(&root),
                root: root.clone(),
            };
            match self
                .root(cx)
                .and_then(|current| self.projects.iter().position(|p| p.root == current))
            {
                Some(ix) => self.projects.insert(ix + 1, open),
                None => self.projects.push(open),
            }
        }
        self.project = Some(project.clone());
        // The editors of the project open before go with its arrangement.
        self.editors.clear();
        self.active_editor = None;
        self.queued_build = None;
        self.closed_tabs.clear();
        self.forget_visits();
        self.entered_project(&windows::project_display_name(&root), cx);
        self.tex_setup
            .update(cx, |center, _| center.set_root(Some(root.clone())));
        self.refresh_words(cx);
        self.build_target = None;
        self.close_root_pdfs(window, cx);
        self.live_document = project.read(cx).main_document().map(str::to_string);
        self.refresh_outline(window, cx);
        self.papers
            .update(cx, |papers, cx| papers.set_project(project.clone(), cx));
        self.file_tree
            .update(cx, |tree, cx| tree.set_project(project, cx));
        self.set_window_title(window, cx);
        let restored = self.restore_layout(&root, main.as_deref(), window, cx);
        if let Some(main) = main.filter(|_| !restored) {
            self.open_path(main, None, window, cx);
        }
        self.label_pdfs(cx);
        self.pdf
            .update(cx, |panel, cx| panel.show_project(root, pdf, window, cx));
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
        if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
        {
            self.open_file_pdf(path, window, cx);
            return None;
        }
        let path = path.canonicalize().unwrap_or(path);
        let in_front = self
            .active_editor()
            .is_some_and(|editor| editor.read(cx).path() == path);
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
        self.record_visit(&path, line, in_front, cx);
        self.refresh_outline(window, cx);
        self.mark_paper(&path, cx);
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
                let papers = self.papers.clone();
                editor.update(cx, |editor, cx| editor.set_papers(papers, cx));
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
                    t!("Could not open the file"),
                    Some(&format!("{error:#}")),
                    &[tc!("dialog button", "OK")],
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
                self.refresh_words(cx);
                self.refresh_outline(window, cx);
            }
            // Settings › Editor & builds › Automatic build: "Manual only"
            // leaves every build to the Build button and ⌘B.
            EditorPanelEvent::SavedForBuild | EditorPanelEvent::DiskEdit => {
                if crate::settings::builds_automatically(cx) {
                    self.run_build(BuildRequest::automatic(), window, cx);
                }
            }
            EditorPanelEvent::Close => self.close_editor(editor, window, cx),
            EditorPanelEvent::OpenLocation { path, line } => {
                if let Some(root) = self.root(cx) {
                    self.open_path(root.join(path), Some(*line), window, cx);
                }
            }
            EditorPanelEvent::Focused => {
                self.active_editor = Some(editor.downgrade());
                let path = editor.read(cx).path().to_path_buf();
                self.mark_paper(&path, cx);
                self.file_tree
                    .update(cx, |tree, cx| tree.set_current(Some(path), cx));
                self.show_outline(cx);
            }
            EditorPanelEvent::CaretLine => {
                if self.active_editor().as_ref() == Some(editor) {
                    self.show_outline(cx);
                }
            }
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
            self.show_outline(cx);
        }
        cx.notify();
    }

    pub(super) fn open_editors(&mut self) -> Vec<Entity<EditorPanel>> {
        self.editors.retain(|editor| editor.upgrade().is_some());
        self.editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .collect()
    }

    /// The editor the writer was last in, if it is still open.
    pub(crate) fn active_editor(&self) -> Option<Entity<EditorPanel>> {
        self.active_editor.as_ref().and_then(WeakEntity::upgrade)
    }

    /// Count the manuscript's words again, and redraw the status bars that
    /// show the count once it lands.
    fn refresh_words(&mut self, cx: &mut Context<Self>) {
        let root = self.root(cx);
        self.words.update(cx, |words, cx| words.refresh(root, cx));
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn tex_setup(&self) -> &Entity<TexSetupCenter> {
        &self.tex_setup
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn words(&self) -> &Entity<ManuscriptWords> {
        &self.words
    }

    fn toggle_vim_mode(&mut self, _: &ToggleVimMode, _: &mut Window, cx: &mut Context<Self>) {
        crate::app::set_vim_mode(!crate::settings::vim_mode(cx), cx);
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

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
