//! The window's commands in action: every command table action's handler
//! on the shell, and the tab and panel commands that act on the dock
//! directly (maximize, next and previous tab, close and reopen a tab).

use gpui::{App, Context, Focusable as _, InteractiveElement as _, Stateful, Window};
use gpui_kit::component::dock::{DockPlacement, PaneRef, PanelId};

use super::{
    Shell,
    commands::*,
    layout::{Preset, View},
    windows,
    workspaces::Workspaces,
};

impl Shell {
    pub(crate) fn toggle_maximize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let focused = self.focused_group(window, cx);
        self.dock_area.update(cx, |area, cx| {
            if area.is_zoomed() {
                area.set_zoomed_out(window, cx);
            } else if let Some(node) = focused {
                area.set_zoomed_in(node, window, cx);
            }
        });
        cx.notify();
    }

    fn focused_group(
        &self,
        window: &Window,
        cx: &App,
    ) -> Option<gpui_kit::component::dock::NodeId> {
        let area = self.dock_area.read(cx);
        let mut found = None;
        let mut first_document = None;
        for placement in [
            DockPlacement::Center,
            DockPlacement::Left,
            DockPlacement::Right,
            DockPlacement::Bottom,
        ] {
            let Some(tree) = area.layout(placement) else {
                continue;
            };
            tree.root().walk(&mut |node| {
                if let PaneRef::Tabs { panels, .. } = node.kind() {
                    for panel in panels.iter().filter_map(|id| area.panel(*id)) {
                        if panel.focus_handle(cx).contains_focused(window, cx) {
                            found = Some(node.id());
                        }
                        if placement == DockPlacement::Center {
                            first_document.get_or_insert(node.id());
                        }
                    }
                }
            });
        }
        found.or_else(|| self.document_group(cx)).or(first_document)
    }

    /// The tab beside the selected one in the focused group, `step` along.
    pub(crate) fn step_tab(&mut self, step: isize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(node) = self.focused_group(window, cx) else {
            return;
        };
        let target = {
            let area = self.dock_area.read(cx);
            let mut target = None;
            for placement in [
                DockPlacement::Center,
                DockPlacement::Left,
                DockPlacement::Right,
                DockPlacement::Bottom,
            ] {
                if let Some(found) = area.layout(placement).and_then(|tree| tree.find_node(node))
                    && let PaneRef::Tabs { panels, active_ix } = found.kind()
                    && !panels.is_empty()
                {
                    let count = panels.len() as isize;
                    let ix = (active_ix as isize + step).rem_euclid(count) as usize;
                    target = Some(panels[ix]);
                }
            }
            target
        };
        if let Some(panel) = target {
            self.dock_area
                .update(cx, |area, cx| area.select_panel(panel, window, cx));
            if let Some(view) = self.dock_area.read(cx).panel(panel).cloned() {
                window.focus(&view.focus_handle(cx), cx);
            }
        }
    }

    /// ⌘W: the focused editor, else the document in front, else any document
    /// on screen; the window when no document is open.
    pub(crate) fn close_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let editors = self.open_editors();
        let shown: Vec<PanelId> = editors
            .iter()
            .map(|editor| PanelId::from(editor.entity_id()))
            .filter(|panel| self.panel_shown(*panel, cx))
            .collect();
        let focused = editors
            .iter()
            .find(|editor| {
                editor
                    .read(cx)
                    .editor()
                    .focus_handle(cx)
                    .contains_focused(window, cx)
            })
            .map(|editor| PanelId::from(editor.entity_id()));
        let target = focused
            .or_else(|| {
                let path = self.root(cx)?.join(self.active_document(cx)?);
                editors
                    .iter()
                    .find(|editor| editor.read(cx).path() == path)
                    .map(|editor| PanelId::from(editor.entity_id()))
            })
            .or_else(|| shown.first().copied());
        match target {
            Some(panel) => {
                self.close_panel(panel, window, cx);
            }
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
            maximized: self.dock_area.read(cx).is_zoomed(),
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
                this.toggle_view(View::Project, window, cx)
            }))
            .on_action(cx.listener(|this, _: &TogglePapersPanel, window, cx| {
                this.toggle_view(View::Papers, window, cx)
            }))
            .on_action(cx.listener(|this, _: &ToggleAgentPanel, window, cx| {
                this.toggle_view(View::Agent, window, cx)
            }))
            .on_action(cx.listener(|this, _: &TogglePdfPanel, window, cx| {
                this.toggle_view(View::Pdf, window, cx)
            }))
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
            .on_action(cx.listener(|this, _: &NextTab, window, cx| this.step_tab(1, window, cx)))
            .on_action(
                cx.listener(|this, _: &PreviousTab, window, cx| this.step_tab(-1, window, cx)),
            )
            .on_action(
                cx.listener(|this, _: &ToggleMaximize, window, cx| {
                    this.toggle_maximize(window, cx)
                }),
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
