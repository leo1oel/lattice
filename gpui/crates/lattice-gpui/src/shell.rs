//! The window: Lattice's titlebar over the Trellis workspace in Lattice's
//! look (`trellis` and `skin`), holding the file tree, Papers and the Agent, the editors, the PDF
//! preview and the build panel; and the flows that tie them together on
//! lattice-core: open a project, open a file, build, jump between the source
//! and the PDF (SyncTeX), and the file tree's create, rename, move and
//! delete.
//!
//! The shell's own parts live beside it: the layouts and the named
//! workspaces (`trellis_layout`, `workspaces`, `views`, `skin`, `arrange`,
//! `workspace_flow`),
//! the command table, keymap and palette (`commands`, `actions`, `palette`),
//! the menu bar (`menus`), windows and project tabs (`windows`), builds (`build`, `build_tools`), the tree's operations (`entries`),
//! the PDFs (`pdfs`) and SyncTeX (`synctex`).

mod actions;
mod arrange;
mod build;
mod build_tools;
pub mod commands;
mod documents;
mod editor_events;
mod entries;
mod ground;
mod history_flow;
mod imports;
mod layers;
pub(crate) mod menus;
mod palette;
mod pdfs;
mod references_flow;
mod render;
mod saving;
mod skin;
mod synctex;
mod tools_flow;
pub mod trellis_layout;
pub mod views;
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
use gpui_kit::component::v_flex;
use lattice_i18n::{t, tc};
use lattice_ui::{ActiveLattice as _, Appearance, LatticeTheme};
use trellis::{TrellisWorkspace, model::LayoutDocument};

use build::BuildRequest;
pub use commands::{
    Build, CleanBuildFiles, CleanRebuild, ForwardSync, InstallLatexTools, NextProblem,
    OpenTexDoctor, PreviousProblem, Save, StopBuild, ToggleVimMode,
};
pub use references_flow::{FindReferences, RenameSymbol};
pub use tools_flow::{ExportArxiv, OpenChecklist, OpenTodos};

use crate::{
    build::{
        tex_setup::center::{self as tex_setup, TexSetupCenter, TexSetupEvent},
        word_count::{self, ManuscriptWords},
    },
    build_panel::{BuildAction, BuildPanel, DiagnosticsCard, OpenLocation},
    confirm::{self, ConfirmHost},
    editor_panel::EditorPanel,
    file_tree::FileTreePanel,
    notices::{self, NoticeStack},
    pdf::{PdfPanel, PdfPanelKind},
    project::Project,
    stand_in_panels::{StandIn, StandInPanel},
    titlebar::TitlebarDrag,
};

/// The workspace's padding (`main.workspace`: 0 6px 6px), to which the
/// workspace adds its own 6px edge: panels sit 12px from the window's sides
/// and bottom and 6px under the titlebar.
const WORKSPACE_SIDE: f32 = 6.;

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
    pub preset: Option<trellis_layout::ActivePreset>,
    /// Focus mode, and the layout it returns to.
    pub focus: Option<trellis_layout::ActiveFocus>,
    pub dirty: bool,
    /// The workspace whose name is being edited in place.
    pub renaming: Option<String>,
    /// Where each document sat in each workspace, by workspace id.
    pub places: std::collections::BTreeMap<String, trellis_layout::DocumentPlaces>,
}

/// A project open in a window, with the name its tab shows.
pub(crate) struct OpenProject {
    pub root: PathBuf,
    pub name: SharedString,
}

pub struct Shell {
    project: Option<Entity<Project>>,
    pub(crate) focus_handle: FocusHandle,
    workspace: Entity<TrellisWorkspace>,
    /// The panel behind each of the workspace's views.
    views: views::Registry,
    /// The document as of the last committed change, for a close to keep
    /// its document panel.
    last_document: LayoutDocument,
    reset_undo: Option<workspace_flow::ResetUndo>,
    /// Each view's panel taking the keyboard focuses its view.
    view_focus: std::collections::HashMap<String, Subscription>,
    /// The panels shown as their panel's selected tab, last told so
    /// ([`Shell::sync_shown`]).
    shown_panels: std::collections::HashSet<gpui::EntityId>,
    titlebar_drag: TitlebarDrag,
    /// A panel is being dragged: the webview islands stand aside.
    panel_dragging: bool,
    file_tree: Entity<FileTreePanel>,
    papers: Entity<StandInPanel>,
    agent: Entity<StandInPanel>,
    pdf: Entity<PdfPanel>,
    build_panel: Entity<BuildPanel>,
    /// The History tool panel (`crate::history`), one for the window.
    pub(crate) history: Entity<crate::history::HistoryPanel>,
    /// The submission checklist tool panel (`crate::submission::checklist`).
    pub(crate) checklist: Entity<crate::submission::checklist::ChecklistPanel>,
    /// The manuscript's TODOs tool panel (`crate::submission::todos`).
    pub(crate) todos: Entity<crate::submission::todos::TodosPanel>,
    /// A symbol's occurrences bar and rename dialog (`references_flow`).
    pub(crate) references: references_flow::References,
    /// The arXiv export sheet, while it is open.
    pub(crate) arxiv: Option<(
        Entity<crate::submission::arxiv::ArxivExportSheet>,
        Subscription,
    )>,
    /// The conflict resolver, while it is open.
    pub(crate) conflict: Option<(Entity<crate::history::ConflictResolver>, Subscription)>,
    /// The files Git named as conflicts when last told (`history_flow`).
    pub(crate) conflicts_noticed: std::collections::BTreeSet<String>,
    /// Watches the open project for Git's conflicts.
    _project_git: Option<Subscription>,
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
    /// The interface size pill (`interface_zoom::ZoomHud`).
    zoom_hud: Entity<crate::interface_zoom::ZoomHud>,
    confirm: Entity<ConfirmHost>,
    editors: Vec<WeakEntity<EditorPanel>>,
    /// The editor the writer was last in (opened, or holding the keyboard),
    /// which a build compiles from and a jump to the PDF starts from. An
    /// overlay (the palette, a menu) taking focus does not change it.
    active_editor: Option<WeakEntity<EditorPanel>>,
    build_task: Option<Task<()>>,
    /// The build to run once the one under way ends.
    queued_build: Option<BuildRequest>,
    /// A build the writer asked for is under way or queued: when the last
    /// pass ends, its outcome is heard (`crate::sounds`).
    build_sound: bool,
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
        let views = views::Registry::default();
        let skin = std::rc::Rc::new(skin::LatticeSkin::new(views.clone()));
        let workspace = cx.new(|cx| {
            TrellisWorkspace::new(views::engine_options(), LayoutDocument::default(), skin, cx)
        });
        let file_tree = cx.new(FileTreePanel::new);
        let papers = cx.new(|cx| StandInPanel::new(StandIn::Papers, cx));
        let agent = cx.new(|cx| StandInPanel::new(StandIn::Agent, cx));
        let pdf = cx.new(|cx| PdfPanel::new(PdfPanelKind::Live, window, cx));
        let build_panel = cx.new(BuildPanel::new);
        let card = cx.new(|cx| DiagnosticsCard::new(build_panel.clone(), cx));
        let history = cx.new(|cx| crate::history::HistoryPanel::new(window, cx));
        let shown_in = workspace.downgrade();
        history.update(cx, |history, _| {
            history.watch_screen(move |cx| {
                shown_in
                    .upgrade()
                    .is_some_and(|workspace| arrange::on_screen(workspace.read(cx), "history"))
            })
        });
        let (todos, checklist) = Self::tool_panels(&build_panel, &pdf, window, cx);
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
                // Reduce transparency is only reported when asked.
                crate::window_material::apply(window, cx);
                crate::interface_zoom::apply(window, cx);
                crate::interface_zoom::align_traffic_lights(window, cx);
            }
        })
        .detach();
        crate::window_material::apply(window, cx);
        // The stored size from the first frame, as the PDF window takes it:
        // a window that opens without becoming key (behind another, or on a
        // locked screen) would otherwise lay out at 100% until activated.
        crate::interface_zoom::apply(window, cx);
        crate::interface_zoom::align_traffic_lights(window, cx);
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
        cx.subscribe_in(&history, window, |this, _, event, window, cx| {
            this.on_history_event(event, window, cx)
        })
        .detach();
        cx.observe(&notices, |_, _, cx| cx.notify()).detach();
        cx.observe(&confirm, |_, _, cx| cx.notify()).detach();
        let workspace_events = cx.subscribe_in(&workspace, window, Self::on_workspace_event);
        // While a panel is dragged, webview islands step aside: a page would
        // hide the drop targets under it and swallow the drag.
        let workspace_drags = cx.observe_in(&workspace, window, |this, workspace, window, cx| {
            let dragging = workspace.read(cx).engine().dragging();
            if dragging != this.panel_dragging {
                this.panel_dragging = dragging;
                window.defer(cx, move |_, cx| {
                    lattice_webview::set_dock_dragging(dragging, cx)
                });
            }
        });
        let library = cx.observe_global::<workspaces::Workspaces>(|this, cx| {
            this.refresh_dirty(cx);
            cx.notify();
        });
        cx.on_release(|this, cx| {
            this.flush_layout(cx);
            this.drop_conflict_notice(cx);
        })
        .detach();
        cx.on_app_quit(|this, cx| {
            this.flush_layout(cx);
            async {}
        })
        .detach();

        let mut shell = Self {
            project: None,
            focus_handle: cx.focus_handle(),
            workspace,
            views,
            last_document: LayoutDocument::default(),
            reset_undo: None,
            view_focus: Default::default(),
            shown_panels: Default::default(),
            titlebar_drag: TitlebarDrag::default(),
            panel_dragging: false,
            file_tree,
            papers,
            agent,
            pdf,
            build_panel,
            history,
            todos,
            checklist,
            arxiv: None,
            references: Default::default(),
            conflict: None,
            conflicts_noticed: Default::default(),
            _project_git: None,
            tex_setup,
            words,
            cleaning: false,
            setup_dialog_open: false,
            slow_build: None,
            notices,
            zoom_hud: crate::interface_zoom::new_hud(cx),
            confirm,
            editors: Vec::new(),
            active_editor: None,
            build_task: None,
            queued_build: None,
            build_sound: false,
            build_waiters: Vec::new(),
            build_target: None,
            live_document: None,
            root_pdfs: Vec::new(),
            file_pdfs: Vec::new(),
            outline: std::rc::Rc::from([]),
            _outline_task: None,
            _open_task: None,
            layout: LayoutState::default(),
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
            _subscriptions: vec![workspace_events, workspace_drags, library],
        };
        // The Main window before a project opens: the default layout, its
        // document slot empty.
        let empty = trellis_layout::arrangement_of(&trellis_layout::default_layout());
        shell.install(empty, false, window, cx);
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

    /// Whether Clean is still deleting the auxiliary files, which turns a
    /// clean rebuild away until it is done.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn cleaning(&self) -> bool {
        self.cleaning
    }

    /// The Trellis workspace the panels are laid out in.
    pub fn workspace(&self) -> &Entity<TrellisWorkspace> {
        &self.workspace
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
        self.drop_conflict_notice(cx);
        self.references = Default::default();
        self.arxiv = None;
        self.conflict = None;
        self.project = Some(project.clone());
        // The editors of the project open before go with its arrangement.
        self.editors.clear();
        self.active_editor = None;
        self.queued_build = None;
        self.build_sound = false;
        self.closed_tabs.clear();
        self.forget_visits();
        self.entered_project(&windows::project_display_name(&root), cx);
        self.tex_setup
            .update(cx, |center, _| center.set_root(Some(root.clone())));
        self.refresh_words(cx);
        self.build_target = None;
        self.close_root_pdfs(window, cx);
        // The documents' panels go with the project they were of.
        let gone: Vec<_> = self
            .views
            .borrow()
            .iter()
            .filter(|(id, _)| !views::SINGLETONS.contains(&id.as_str()))
            .map(|(_, panel)| panel.clone())
            .collect();
        self.views
            .borrow_mut()
            .retain(|id, _| views::SINGLETONS.contains(&id.as_str()));
        self.view_focus
            .retain(|id, _| views::SINGLETONS.contains(&id.as_str()));
        for panel in gone {
            panel.on_removed(window, cx);
        }
        self.reset_undo = None;
        self.live_document = project.read(cx).main_document().map(str::to_string);
        self.refresh_outline(window, cx);
        self.history
            .update(cx, |history, cx| history.set_project(project.clone(), cx));
        self.tools_project_opened(&project, &root, window, cx);
        self._project_git = Some(cx.subscribe(&project, |this, _, event, cx| {
            if matches!(event, crate::project::ProjectEvent::GitChanged) {
                this.notice_conflicts(cx);
            }
        }));
        self.notice_conflicts(cx);
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
        let root = self.root(cx)?;
        let editor = self.editor_for(&path, window, cx)?;
        self.place_document(&views::document_key(&root, &path), false, cx);
        self.sync_views(window, cx);
        self.active_editor = Some(editor.downgrade());
        editor.update(cx, |editor, cx| match line {
            Some(line) => editor.go_to_line(line, window, cx),
            // The panel's own: a structured document's page, or a Markdown or
            // HTML file's preview while it shows only that.
            None => window.focus(&gpui::Focusable::focus_handle(editor, cx), cx),
        });
        self.record_visit(&path, line, in_front, cx);
        self.refresh_outline(window, cx);
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
                self.adopt_editor(&editor, window, cx);
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

    pub(crate) fn open_editors(&mut self) -> Vec<Entity<EditorPanel>> {
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

    /// Whether the build log is on screen.
    pub fn build_panel_shown(&self, cx: &App) -> bool {
        self.view_on_screen("build", cx)
    }

    /// Show the build log under the documents, or put it away.
    pub fn show_build_panel(&mut self, shown: bool, window: &mut Window, cx: &mut Context<Self>) {
        if shown == self.build_panel_shown(cx) {
            return;
        }
        if shown {
            self.show_view("build", true, window, cx);
        } else {
            self.hide_view("build", cx);
        }
        cx.notify();
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
