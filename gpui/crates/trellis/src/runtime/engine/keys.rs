// Ported from DanFessler/trellis 0.2.0, Copyright (c) Dan Fessler, Trellis Public License v1.0 Non-Commercial
// (packages/core/src/runtime/workspace.ts: keyboard, run, toggleFrame).

//! The workspace's commands and keys.

use crate::model::{panels_of, select_view};
use crate::runtime::keymap::{Command, KeyPress, matches};

use super::Engine;

/// What a key on a focused tab asks of the host.
#[derive(Clone, Debug, PartialEq)]
pub enum TabKeyOutcome {
    /// Nothing for this key.
    Ignored,
    /// Handled: move the keyboard to this view's tab.
    FocusTab(String),
    /// Give the keyboard to the selected view's content.
    FocusContent(String),
    /// Close this view (through its close guard).
    Close(String),
    /// Open the panel menu from its button.
    OpenMenu(String),
}

impl Engine {
    /// A key pressed with the keyboard in the workspace (not consumed by a
    /// view first). `typing`: the keyboard is in a text field, where
    /// shortcuts without Ctrl, ⌘ or Alt never fire. `in_content`: inside a
    /// view's content, where Escape belongs to the content. Returns whether
    /// the key was the workspace's.
    pub fn key_down(&mut self, press: &KeyPress, typing: bool, in_content: bool) -> Option<KeyOutcome> {
        if self.drag_active() {
            if press.key == "Escape" {
                self.drag_end(false);
                return Some(KeyOutcome::Handled);
            }
            return None;
        }
        if (self.nav.marquee.is_some() || self.nav.drag_zoom.is_some()) && press.key == "Escape" {
            self.nav_cancel_gestures();
            return Some(KeyOutcome::Handled);
        }
        let keymap = self.options.keymap.clone();
        for (command, combo) in &keymap {
            let Some(combo) = combo else { continue };
            if typing && !press.ctrl && !press.meta && !press.alt {
                continue;
            }
            if matches(press, combo, self.options.mac) {
                return Some(self.run(*command));
            }
        }
        // Escape outside content steps out one level.
        if press.key == "Escape" && self.nav.framed.is_some() && !in_content {
            self.nav_step_out();
            return Some(KeyOutcome::Handled);
        }
        None
    }

    /// Run a command on the focused panel.
    pub fn run(&mut self, command: Command) -> KeyOutcome {
        let panel_id = self.focused_panel.clone();
        let panel = panel_id.as_ref().and_then(|id| self.find_panel(id));
        match command {
            Command::FrameToggle => {
                if let Some(id) = &panel_id {
                    self.toggle_frame(id);
                }
            }
            Command::NavigationBack => self.nav_history_go(-1),
            Command::NavigationForward => self.nav_history_go(1),
            Command::NavigationOverview => self.nav_toggle_overview(),
            Command::PanelNext | Command::PanelPrevious => {
                let mut order: Vec<_> = panels_of(self.doc.root.as_ref())
                    .into_iter()
                    .cloned()
                    .collect();
                order.extend(self.doc.floating.iter().map(|f| f.panel.clone()));
                if order.is_empty() {
                    return KeyOutcome::Handled;
                }
                let i = order
                    .iter()
                    .position(|p| Some(&p.id) == panel_id.as_ref())
                    .map_or(-1, |i| i as isize);
                let step = if command == Command::PanelNext { 1 } else { -1 };
                let n = order.len() as isize;
                let next = order[((i + step + n) % n) as usize].clone();
                self.focus_view(&next.selected);
                self.ensure_framed_visible(&next.selected);
                return KeyOutcome::FocusTab(next.selected);
            }
            Command::TabNext | Command::TabPrevious => {
                let Some(panel) = panel else {
                    return KeyOutcome::Handled;
                };
                let n = panel.views.len() as isize;
                let i = panel
                    .views
                    .iter()
                    .position(|v| *v == panel.selected)
                    .unwrap_or(0) as isize;
                let step = if command == Command::TabNext { 1 } else { -1 };
                let view = panel.views[((i + step + n) % n) as usize].clone();
                self.select_and_focus(&view);
                return KeyOutcome::FocusContent(view);
            }
            Command::ViewClose => {
                if let Some(view) = self.focused_view.clone()
                    && self.closable(&view)
                {
                    return KeyOutcome::Close(view);
                }
            }
            Command::PanelFloat => {
                if let Some(id) = &panel_id {
                    self.float(id, None);
                }
            }
            Command::PanelHide => {
                if let Some(id) = &panel_id {
                    self.hide(id, None);
                }
            }
        }
        KeyOutcome::Handled
    }

    /// A key on a focused tab: arrows, Home and End move between tabs,
    /// Delete closes, Enter and Space go into the content, Shift+F10 and the
    /// context menu key open the panel menu.
    pub fn tab_key(&mut self, panel_id: &str, press: &KeyPress) -> TabKeyOutcome {
        let Some(panel) = self.find_panel(panel_id) else {
            return TabKeyOutcome::Ignored;
        };
        let n = panel.views.len() as isize;
        let index = panel
            .views
            .iter()
            .position(|v| *v == panel.selected)
            .unwrap_or(0) as isize;
        let go = |engine: &mut Engine, i: isize| {
            let view = panel.views[((i + n) % n) as usize].clone();
            let next = select_view(&engine.doc, &view);
            engine.commit(next, false, None);
            engine.set_focus(Some(&view), true);
            TabKeyOutcome::FocusTab(view)
        };
        match press.key.as_str() {
            "ArrowRight" => go(self, index + 1),
            "ArrowLeft" => go(self, index - 1),
            "Home" => go(self, 0),
            "End" => go(self, n - 1),
            "Delete" if self.closable(&panel.selected) => TabKeyOutcome::Close(panel.selected),
            "Enter" | " " | "Space" => {
                self.focus_view(&panel.selected);
                TabKeyOutcome::FocusContent(panel.selected)
            }
            "ContextMenu" => TabKeyOutcome::OpenMenu(panel_id.to_string()),
            "F10" if press.shift => TabKeyOutcome::OpenMenu(panel_id.to_string()),
            _ => TabKeyOutcome::Ignored,
        }
    }

    /// Double-clicking a tab bar maximizes; a floating window frames its
    /// desktop.
    pub fn toggle_frame(&mut self, panel_id: &str) -> bool {
        if let Some(float) = self.doc.floating.iter().find(|f| f.panel.id == panel_id) {
            // A window floating on the desktop frames its desktop; overlay
            // floats have none.
            if float.layer != crate::model::FloatingLayer::Stage {
                return false;
            }
            self.nav_frame_stage();
            return true;
        }
        self.nav_toggle(panel_id)
    }
}

/// What running a command asks of the host.
#[derive(Clone, Debug, PartialEq)]
pub enum KeyOutcome {
    Handled,
    /// Move the keyboard to this view's tab.
    FocusTab(String),
    /// Give the keyboard to this view's content.
    FocusContent(String),
    /// Close this view (through its close guard).
    Close(String),
}
