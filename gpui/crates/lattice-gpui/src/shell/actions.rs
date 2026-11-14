//! The window's commands in action: every command table action's handler
//! on the shell, and the tab and panel commands that act on the dock
//! directly (maximize, next and previous tab, close and reopen a tab).

use gpui::{App, Context, InteractiveElement as _, Stateful, Window};
use trellis::runtime::engine::ViewPlacement;
use trellis::runtime::keymap::Command as Trellis;

use super::help_flow::{ReportProblem, WhatsNew};
use super::history_flow::{OpenHistory, ResolveConflicts};
use super::overleaf_flow::{OpenOnOverleaf, OpenOverleafProject, SyncOverleaf};
use super::tools_flow::{ExportArxiv, OpenChecklist, OpenTodos};
use super::{Shell, commands::*, trellis_layout::Preset, windows, workspaces::Workspaces};

impl Shell {
    /// One of the workspace's own commands, on the focused panel.
    pub(crate) fn run_trellis(&mut self, command: Trellis, cx: &mut Context<Self>) {
        if self.workspace.read(cx).engine().focused_panel().is_none()
            && let Some(view) = self
                .active_document(cx)
                .and_then(|key| self.view_of_document(&key, cx))
        {
            self.engine_do(cx, |engine| engine.focus_view(&view));
        }
        self.workspace
            .update(cx, |workspace, cx| workspace.run(command, cx));
        cx.notify();
    }

    /// ⌘W, as an editor's or a browser's (`closeDocumentTab`): close the
    /// focused document tab, else the active one, else any on screen, as
    /// the tab's own X does; the window when no document is open.
    pub(crate) fn close_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let doc = self.document(cx);
        let engine = self.workspace.read(cx).engine();
        let files: Vec<String> = doc
            .views
            .iter()
            .filter(|(id, view)| {
                view.kind == "file" && engine.placement_of(id) != ViewPlacement::Hidden
            })
            .map(|(id, _)| id.clone())
            .collect();
        let focused = engine.focused_view().map(str::to_string);
        let active = self
            .active_document(cx)
            .and_then(|key| self.view_of_document(&key, cx));
        let target = focused
            .filter(|view| files.contains(view))
            .or(active.filter(|view| files.contains(view)))
            .or_else(|| files.first().cloned());
        match target {
            Some(view) => self
                .workspace
                .update(cx, |workspace, cx| workspace.close(&[view], cx)),
            None => self.close_window(window, cx),
        }
    }

    /// ⌘⇧T: the last document closed in this window, open again.
    pub(crate) fn reopen_closed_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        while let Some(path) = self.closed_tabs.pop() {
            if path.is_file() {
                self.open_path(path, None, window, cx);
                return;
            }
        }
    }

    /// What the command table needs to know about this window.
    pub(crate) fn command_context(&self, cx: &App) -> CommandContext {
        CommandContext {
            in_project: self.project.is_some(),
            maximized: self.workspace.read(cx).engine().framed().is_some(),
            focus_mode: self.layout.focus.is_some(),
            dirty: self.layout.dirty,
            building: self.build_task.is_some(),
            preset: self.layout.preset.as_ref().map(|active| active.preset),
            recent: crate::recents::RecentProjects::list(cx)
                .iter()
                .filter(|recent| Some(&recent.path) != self.root(cx).as_ref())
                .take(5)
                .map(|recent| (recent.name.clone().into(), recent.path.clone()))
                .collect(),
            workspaces: Workspaces::global(cx)
                .list()
                .iter()
                .map(|entry| {
                    (
                        entry.id.clone(),
                        super::workspaces::shown_name(&entry.name).into(),
                    )
                })
                .collect(),
            projects: self.projects.len(),
            overleaf_linked: self.overleaf.read(cx).link().is_some(),
            overleaf_syncing: self.overleaf.read(cx).syncing(),
        }
    }

    /// Every command's handler on the shell's root element.
    pub(super) fn register_commands(
        &self,
        element: Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> Stateful<gpui::Div> {
        let element = element
            .on_action(cx.listener(|this, _: &ToggleProjectPanel, window, cx| {
                this.toggle_view("project", window, cx)
            }))
            .on_action(cx.listener(|this, _: &TogglePapersPanel, window, cx| {
                this.toggle_view("papers", window, cx)
            }))
            .on_action(cx.listener(|this, _: &ToggleAgentPanel, window, cx| {
                this.toggle_view("agent", window, cx)
            }))
            .on_action(cx.listener(|this, _: &TogglePdfPanel, window, cx| {
                this.toggle_view("pdf", window, cx)
            }))
            .on_action(cx.listener(
                |this, _: &crate::terminal::ToggleTerminalPanel, window, cx| {
                    this.toggle_terminal(window, cx)
                },
            ))
            .on_action(
                cx.listener(|this, _: &crate::terminal::NewTerminal, window, cx| {
                    this.new_terminal(window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &OpenHistory, window, cx| this.open_history(window, cx)),
            )
            .on_action(cx.listener(|this, _: &OpenTodos, window, cx| this.open_todos(window, cx)))
            .on_action(
                cx.listener(|this, _: &OpenChecklist, window, cx| this.open_checklist(window, cx)),
            )
            .on_action(cx.listener(Self::find_references))
            .on_action(cx.listener(Self::rename_symbol))
            .on_action(
                cx.listener(|this, _: &ExportArxiv, window, cx| this.open_arxiv_export(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &WhatsNew, window, cx| this.open_whats_new(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &ReportProblem, window, cx| this.report_problem(window, cx)),
            )
            .on_action(cx.listener(|this, _: &ResolveConflicts, window, cx| {
                this.resolve_conflicts(window, cx)
            }))
            .on_action(cx.listener(|this, _: &OpenOverleafProject, window, cx| {
                this.open_overleaf_picker(window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &SyncOverleaf, window, cx| this.sync_overleaf(window, cx)),
            )
            .on_action(cx.listener(|this, _: &OpenOnOverleaf, _, cx| this.open_on_overleaf(cx)))
            .on_action(cx.listener(|this, _: &ToggleBuildPanel, window, cx| {
                let shown = this.build_panel_shown(cx);
                this.show_build_panel(!shown, window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &CommandPalette, window, cx| this.open_palette(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &ShowShortcuts, window, cx| this.open_shortcuts(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &QuickOpen, window, cx| this.toggle_quick_open(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &FindInProject, window, cx| this.toggle_find(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &ReplaceInProject, window, cx| {
                    this.toggle_replace(window, cx)
                }),
            )
            .on_action(
                cx.listener(|this, _: &NewProject, window, cx| this.open_new_project(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &GoBack, window, cx| this.go_back_or_forward(-1, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &OpenFolder, window, cx| this.open_folder(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &OpenFolderHere, window, cx| {
                this.open_folder(true, window, cx)
            }))
            .on_action(cx.listener(|this, action: &OpenRecentProject, window, cx| {
                this.reveal_project(action.path.clone(), action.here, window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &CloneRepository, window, cx| this.open_clone(window, cx)),
            )
            .on_action(cx.listener(|this, _: &ImportZip, window, cx| this.import_zip(window, cx)))
            .on_action(
                cx.listener(|this, _: &GoForward, window, cx| {
                    this.go_back_or_forward(1, window, cx)
                }),
            )
            .on_action(cx.listener(|this, _: &OpenSettings, window, cx| {
                this.open_settings(None, window, cx)
            }))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| this.close_tab(window, cx)))
            .on_action(cx.listener(|this, _: &ReopenClosedTab, window, cx| {
                this.reopen_closed_tab(window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &NextTab, _, cx| this.run_trellis(Trellis::TabNext, cx)),
            )
            .on_action(cx.listener(|this, _: &PreviousTab, _, cx| {
                this.run_trellis(Trellis::TabPrevious, cx)
            }))
            .on_action(cx.listener(|this, _: &ToggleMaximize, _, cx| {
                this.run_trellis(Trellis::FrameToggle, cx)
            }))
            .on_action(
                cx.listener(|this, _: &NextPanel, _, cx| this.run_trellis(Trellis::PanelNext, cx)),
            )
            .on_action(cx.listener(|this, _: &PreviousPanel, _, cx| {
                this.run_trellis(Trellis::PanelPrevious, cx)
            }))
            .on_action(cx.listener(|this, _: &NavigateBack, _, cx| {
                this.run_trellis(Trellis::NavigationBack, cx)
            }))
            .on_action(cx.listener(|this, _: &NavigateForward, _, cx| {
                this.run_trellis(Trellis::NavigationForward, cx)
            }))
            .on_action(
                cx.listener(|this, _: &CloseView, _, cx| this.run_trellis(Trellis::ViewClose, cx)),
            )
            .on_action(cx.listener(|this, _: &ToggleFocusMode, window, cx| {
                let on = this.layout.focus.is_none();
                this.set_focus_mode(on, window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &ResetLayout, window, cx| this.reset_layout(window, cx)),
            )
            .on_action(cx.listener(|this, _: &NewWorkspace, window, cx| {
                this.new_workspace(window, cx);
            }))
            .on_action(
                cx.listener(|this, _: &SaveWorkspace, window, cx| this.save_workspace(window, cx)),
            )
            .on_action(cx.listener(|this, _: &RevertWorkspace, window, cx| {
                this.revert_workspace(window, cx)
            }))
            .on_action(cx.listener(|this, _: &WritingPreset, window, cx| {
                this.set_preset(Preset::Writing, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ReadingPreset, window, cx| {
                this.set_preset(Preset::Reading, window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &ReturnToWorkspace, window, cx| {
                    this.leave_preset(window, cx)
                }),
            )
            .on_action(cx.listener(|_, _: &NewWindow, window, cx| {
                windows::new_window(None, Some(window.bounds()), cx)
            }))
            .on_action(cx.listener(|this, _: &OpenInNewWindow, window, cx| {
                this.open_in_new_window(window, cx)
            }))
            .on_action(
                cx.listener(|this, _: &CloseWindow, window, cx| this.close_window(window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &NextProject, window, cx| this.step_project(1, window, cx)),
            )
            .on_action(cx.listener(|this, _: &PreviousProject, window, cx| {
                this.step_project(-1, window, cx)
            }))
            .on_action(cx.listener(|this, _: &CloseProject, window, cx| {
                if let Some(root) = this.root(cx) {
                    this.close_project(&root, window, cx);
                }
            }))
            // The palette's appearance commands are Settings › Appearance ›
            // Color theme, kept with every other setting.
            .on_action(cx.listener(|_, _: &ThemeLight, _, cx| {
                crate::settings::update(cx, |settings| {
                    settings.theme_preference = lattice_settings::ThemePreference::Light
                })
            }))
            .on_action(cx.listener(|_, _: &ThemeDark, _, cx| {
                crate::settings::update(cx, |settings| {
                    settings.theme_preference = lattice_settings::ThemePreference::Dark
                })
            }))
            .on_action(cx.listener(|_, _: &ThemeSystem, _, cx| {
                crate::settings::update(cx, |settings| {
                    settings.theme_preference = lattice_settings::ThemePreference::System
                })
            }))
            // The interface size: every window takes it, and this one raises
            // its size pill.
            .on_action(cx.listener(|this, _: &LargerInterface, _, cx| {
                this.zoom_interface(crate::interface_zoom::Change::In, cx)
            }))
            .on_action(cx.listener(|this, _: &SmallerInterface, _, cx| {
                this.zoom_interface(crate::interface_zoom::Change::Out, cx)
            }))
            .on_action(cx.listener(|this, _: &ResetInterfaceSize, _, cx| {
                this.zoom_interface(crate::interface_zoom::Change::Reset, cx)
            }))
            .on_action(cx.listener(|this, action: &SwitchWorkspace, window, cx| {
                this.switch_workspace(&action.id, window, cx)
            }))
            .on_action(cx.listener(|_, _: &Minimize, window, _| window.minimize_window()))
            .on_action(cx.listener(|_, _: &Zoom, window, _| window.zoom_window()));
        macro_rules! switches {
            ($element:expr, $($action:ident => $index:expr),*) => {
                $element$(.on_action(cx.listener(|this, _: &$action, window, cx| {
                    this.switch_workspace_at($index, window, cx)
                })))*
            };
        }
        switches!(
            element,
            SwitchWorkspace1 => 0,
            SwitchWorkspace2 => 1,
            SwitchWorkspace3 => 2,
            SwitchWorkspace4 => 3,
            SwitchWorkspace5 => 4,
            SwitchWorkspace6 => 5,
            SwitchWorkspace7 => 6,
            SwitchWorkspace8 => 7,
            SwitchWorkspace9 => 8
        )
    }
}
