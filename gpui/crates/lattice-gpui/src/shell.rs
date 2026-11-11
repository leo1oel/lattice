//! The window: a toolbar over GPUI Kit's dock area, holding the file tree,
//! the editors, the PDF preview, and the build panel; and the flows that tie
//! them together (open a project, open a file, build).

use std::{path::PathBuf, rc::Rc};

use futures::{StreamExt as _, channel::mpsc};
use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, Entity, FocusHandle, Focusable,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, PathPromptOptions,
    Render, SharedString, Styled as _, Task, WeakEntity, Window, WindowBounds, WindowOptions,
    actions, div, px, size,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    dock::{DockArea, DockLayout, DockPlacement, DockSkin, PanelId, panel_handle},
    h_flex, v_flex,
};

use crate::{
    build_panel::{BuildPanel, OpenLocation},
    editor_panel::EditorPanel,
    file_tree::{FileTreePanel, OpenFile},
    pdf::PdfPanel,
};

actions!(lattice, [OpenFolder, Build, Save, ToggleVimMode]);

/// Open folder, build, save: on the platform's primary shortcut modifier.
#[cfg(target_os = "macos")]
const SHORTCUTS: [&str; 3] = ["cmd-o", "cmd-b", "cmd-s"];
#[cfg(not(target_os = "macos"))]
const SHORTCUTS: [&str; 3] = ["ctrl-o", "ctrl-b", "ctrl-s"];

pub fn bind_keys(cx: &mut App) {
    let [open, build, save] = SHORTCUTS;
    cx.bind_keys([
        KeyBinding::new(open, OpenFolder, None),
        KeyBinding::new(build, Build, None),
        KeyBinding::new(save, Save, None),
    ]);
}

pub struct Shell {
    root: Option<PathBuf>,
    focus_handle: FocusHandle,
    dock_area: Entity<DockArea>,
    _skin: Rc<DockSkin>,
    file_tree: Entity<FileTreePanel>,
    pdf: Entity<PdfPanel>,
    build_panel: Entity<BuildPanel>,
    editors: Vec<WeakEntity<EditorPanel>>,
    build_task: Option<Task<()>>,
    vim_mode: bool,
}

impl Shell {
    pub fn open_window(
        root: Option<PathBuf>,
        cx: &mut App,
    ) -> anyhow::Result<(AnyWindowHandle, Entity<Shell>)> {
        let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
        let mut options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(720.), px(480.))),
            ..Default::default()
        };
        // Lab measurements run in a window nobody looks at; draw it at full
        // rate like a frontmost one (see patches/gpui_macos/PATCH.md).
        if std::env::var_os("GPUI_LAB_IGNORE_OCCLUSION").is_some() {
            options.inactive_frame_interval = None;
        }
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
        let (dock_area, skin) = DockSkin::dock_area("lattice", Some(1), window, cx);
        let file_tree = cx.new(FileTreePanel::new);
        let pdf = cx.new(PdfPanel::new);
        let build_panel = cx.new(BuildPanel::new);

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
            area.set_dock_size(DockPlacement::Left, px(240.), window, cx);
            area.set_dock(
                DockPlacement::Right,
                DockLayout::v_split().child(
                    DockLayout::tabs().panel_view(panel_handle(pdf.clone()), cx),
                    None,
                ),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Right, px(560.), window, cx);
            area.set_dock(
                DockPlacement::Bottom,
                DockLayout::v_split().child(
                    DockLayout::tabs().panel_view(panel_handle(build_panel.clone()), cx),
                    None,
                ),
                window,
                cx,
            );
            area.set_dock_size(DockPlacement::Bottom, px(180.), window, cx);
            for placement in [
                DockPlacement::Left,
                DockPlacement::Right,
                DockPlacement::Bottom,
            ] {
                area.set_dock_collapsible(placement, true, window, cx);
            }
        });

        Self {
            root: None,
            focus_handle: cx.focus_handle(),
            dock_area,
            _skin: skin,
            file_tree,
            pdf,
            build_panel,
            editors: Vec::new(),
            build_task: None,
            vim_mode: crate::app::vim_mode_enabled(cx),
        }
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

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn dock_area(&self) -> &Entity<DockArea> {
        &self.dock_area
    }

    /// Open a project folder: show it in the tree, open its main document,
    /// and preview its PDF when one was already built.
    pub fn open_project(&mut self, root: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        let root = root.canonicalize().unwrap_or(root);
        self.root = Some(root.clone());
        self.file_tree
            .update(cx, |tree, cx| tree.set_root(root.clone(), cx));
        window.set_window_title(&format!(
            "{} — Lattice (GPUI prototype)",
            root.file_name().unwrap_or_default().to_string_lossy()
        ));
        if let Some(main) = tex::find_main_document(&root) {
            let pdf = main.with_extension("pdf");
            self.open_path(main, None, window, cx);
            if pdf.is_file() {
                self.pdf.update(cx, |panel, cx| panel.open(pdf, cx));
            }
        }
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
            self.pdf.update(cx, |panel, cx| panel.open(path, cx));
            return None;
        }
        let path = path.canonicalize().unwrap_or(path);
        self.editors.retain(|editor| editor.upgrade().is_some());
        let existing = self
            .editors
            .iter()
            .filter_map(WeakEntity::upgrade)
            .find(|editor| editor.read(cx).path() == path);
        let editor = match existing {
            Some(editor) => {
                let id = PanelId::from(editor.entity_id());
                self.dock_area
                    .update(cx, |area, cx| area.select_panel(id, window, cx));
                editor
            }
            None => match EditorPanel::open(path.clone(), window, cx) {
                Ok(editor) => {
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
                    self.build_panel
                        .update(cx, |panel, cx| panel.failed(format!("{error:#}"), cx));
                    return None;
                }
            },
        };
        editor.update(cx, |editor, cx| match line {
            Some(line) => editor.go_to_line(line, window, cx),
            None => window.focus(&editor.editor().focus_handle(cx), cx),
        });
        Some(editor)
    }

    fn open_folder(&mut self, _: &OpenFolder, window: &mut Window, cx: &mut Context<Self>) {
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

    fn save_all(&mut self, _: &Save, _: &mut Window, cx: &mut Context<Self>) {
        for editor in self.open_editors() {
            if editor.read(cx).is_dirty(cx) {
                let save = editor.update(cx, |editor, cx| editor.save(cx));
                cx.spawn(async move |_, _| {
                    if let Err(error) = save.await {
                        log::error!("{error:#}");
                    }
                })
                .detach();
            }
        }
    }

    /// Save every edited file, run latexmk on the main document in the
    /// background with its output streaming into the build panel, then show
    /// the diagnostics and reload the PDF.
    pub fn build(&mut self, _: &Build, window: &mut Window, cx: &mut Context<Self>) {
        if self.build_panel.read(cx).is_running() {
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
        let dirty: Vec<_> = self
            .open_editors()
            .into_iter()
            .filter(|editor| editor.read(cx).is_dirty(cx))
            .collect();
        let saves: Vec<_> = dirty
            .into_iter()
            .map(|editor| editor.update(cx, |editor, cx| editor.save(cx)))
            .collect();
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
                this.finish_build(outcome, window, cx)
            })
            .ok();
        }));
    }

    fn finish_build(
        &mut self,
        outcome: std::io::Result<tex::BuildOutcome>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match outcome {
            Ok(outcome) => {
                self.build_panel
                    .update(cx, |panel, cx| panel.finished(&outcome, cx));
                if let Some(pdf) = outcome.pdf.clone() {
                    self.pdf.update(cx, |panel, cx| panel.open(pdf, cx));
                }
                if outcome.error_count() > 0 {
                    self.dock_area.update(cx, |area, cx| {
                        if !area.is_dock_open(DockPlacement::Bottom) {
                            area.toggle_dock(DockPlacement::Bottom, window, cx);
                        }
                    });
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
    }

    fn toggle_vim_mode(&mut self, _: &ToggleVimMode, _: &mut Window, cx: &mut Context<Self>) {
        self.vim_mode = !self.vim_mode;
        crate::app::set_vim_mode(self.vim_mode, cx);
        cx.notify();
    }

    fn toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let project: SharedString = self
            .root
            .as_ref()
            .and_then(|root| root.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "No project".into())
            .into();
        let building = self.build_panel.read(cx).is_running();
        h_flex()
            .h(px(36.))
            .px_2()
            .gap_2()
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.title_bar)
            .child(
                Button::new("open-folder")
                    .icon(IconName::FolderOpen)
                    .label("Open Folder")
                    .ghost()
                    .small()
                    .tooltip_with_action("Open a LaTeX project folder", &OpenFolder, None)
                    .on_click(
                        cx.listener(|this, _, window, cx| {
                            this.open_folder(&OpenFolder, window, cx)
                        }),
                    ),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(project),
            )
            .child(div().flex_1())
            .child(
                Button::new("vim-mode")
                    .label(if self.vim_mode { "Vim: on" } else { "Vim: off" })
                    .ghost()
                    .small()
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.toggle_vim_mode(&ToggleVimMode, window, cx)
                    })),
            )
            .child(
                Button::new("build")
                    .icon(IconName::Play)
                    .label(if building { "Building…" } else { "Build" })
                    .primary()
                    .small()
                    .loading(building)
                    .disabled(self.root.is_none())
                    .tooltip_with_action("Build with latexmk", &Build, None)
                    .on_click(cx.listener(|this, _, window, cx| this.build(&Build, window, cx))),
            )
    }
}

impl Focusable for Shell {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        v_flex()
            .id("lattice-shell")
            .key_context("LatticeShell")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::open_folder))
            .on_action(cx.listener(Self::build))
            .on_action(cx.listener(Self::save_all))
            .on_action(cx.listener(Self::toggle_vim_mode))
            .size_full()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground)
            .child(self.toolbar(cx))
            .child(div().flex_1().min_h_0().child(self.dock_area.clone()))
    }
}
