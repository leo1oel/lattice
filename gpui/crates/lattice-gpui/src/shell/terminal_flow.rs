//! The Terminal panel in the window (`terminal-window.ts`,
//! `close-focused-terminal.ts`): ⌃` and the Panels menu show or hide it, New
//! terminal opens another, closing the panel ends its shells (asking first
//! while a command runs), and the last shell exiting by itself closes it.
//! Hiding the panel, a layout reset or a workspace without it keeps the
//! shells for its return.

use std::path::PathBuf;

use gpui::{AppContext as _, Context, Entity, Window};
use lattice_i18n::{join_list, t};

use super::Shell;
use crate::terminal::{TerminalPanel, TerminalPanelEvent};

impl Shell {
    /// The window's Terminal panel, heard from as its shells end.
    pub(super) fn new_terminal_panel(
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TerminalPanel> {
        let terminal = cx.new(TerminalPanel::new);
        cx.subscribe_in(&terminal, window, |this, _, event, window, cx| {
            this.on_terminal_event(event, window, cx)
        })
        .detach();
        terminal
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub fn terminal(&self) -> &Entity<TerminalPanel> {
        &self.terminal
    }

    /// Another project ends every shell of the last one.
    pub(super) fn terminal_follows(
        &mut self,
        root: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.terminal.update(cx, |terminal, cx| {
            terminal.set_project(Some(root), window, cx)
        });
    }

    pub(super) fn on_terminal_event(
        &mut self,
        event: &TerminalPanelEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // Nothing is left to ask about.
            TerminalPanelEvent::LastExited | TerminalPanelEvent::ClosePanel => {
                if self.document(cx).views.contains_key("terminal") {
                    self.workspace.update(cx, |workspace, cx| {
                        workspace.close(&["terminal".into()], cx)
                    });
                }
            }
        }
    }

    /// The panel's tab ×, its ⋯ menu's Close or a key asked to close `views`,
    /// the Terminal among them: its shells end with it, once the writer
    /// agrees to stop what still runs there (`closeAllTerminals`).
    pub(crate) fn close_with_terminal(&mut self, views: Vec<String>, cx: &mut Context<Self>) {
        let shell = cx.entity().downgrade();
        let closing = views.clone();
        let now = crate::terminal::TerminalPanel::confirm_stopping(
            &self.terminal,
            None,
            cx,
            move |_, cx| {
                let views = closing.clone();
                shell
                    .update(cx, |shell, cx| shell.end_terminals_and_close(&views, cx))
                    .ok();
            },
        );
        if now {
            self.end_terminals_and_close(&views, cx);
        }
    }

    fn end_terminals_and_close(&mut self, views: &[String], cx: &mut Context<Self>) {
        self.terminal
            .update(cx, |terminal, cx| terminal.end_all(cx));
        let views = views.to_vec();
        self.workspace
            .update(cx, |workspace, cx| workspace.close(&views, cx));
    }

    /// A switch to another project in this window ends the terminals'
    /// shells, so while a command runs in one it asks first, naming it and
    /// the build when one is under way (`confirmLeavingProject`); agreed, it
    /// goes on to `root`. True when it asked.
    pub(super) fn ask_before_leaving(
        &mut self,
        root: PathBuf,
        closing: Option<PathBuf>,
        cx: &mut Context<Self>,
    ) -> bool {
        let commands = self.terminal.read(cx).running(None, cx);
        if commands.is_empty() {
            return false;
        }
        let mut running: Vec<String> = Vec::new();
        if self.build_task.is_some() {
            running.push(t!("the build").to_string());
        }
        for command in commands {
            let item = if command.is_empty() {
                t!("a command in the terminal").to_string()
            } else {
                t!("“{command}” in the terminal", command = command)
            };
            if !running.contains(&item) {
                running.push(item);
            }
        }
        let name = self.project_name(cx);
        let shell = cx.entity().downgrade();
        crate::confirm::ask(
            crate::confirm::Confirm::new(t!("Switch away from “{name}”?", name = name))
                .body(t!(
                    "Switching interrupts what is still running there: {list}.",
                    list = join_list(&running)
                ))
                .confirm_label(t!("Switch project"))
                .destructive()
                .on_confirm(move |window, cx| {
                    let (root, closing) = (root.clone(), closing.clone());
                    shell
                        .update(cx, |shell, cx| shell.leave_now(root, closing, window, cx))
                        .ok();
                }),
            cx,
        );
        true
    }

    /// ⌃`, the Panels menu and View ▸ Terminal.
    pub(super) fn toggle_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project.is_none() {
            return;
        }
        let shown = self.view_on_screen("terminal", cx);
        self.toggle_view("terminal", window, cx);
        if !shown {
            self.focus_terminal(window, cx);
        }
    }

    /// Another terminal, in the panel brought on screen.
    pub(super) fn new_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project.is_none() {
            return;
        }
        if !self.view_on_screen("terminal", cx) {
            self.show_view("terminal", true, window, cx);
        }
        // Opened first, the terminal is there when the panel, brought on
        // screen, looks for one to open.
        self.terminal
            .update(cx, |terminal, cx| terminal.open_terminal(window, cx));
        self.focus_terminal(window, cx);
    }

    /// The keyboard in the terminal in front once the panel is laid out.
    fn focus_terminal(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let terminal = self.terminal.clone();
        window.defer(cx, move |window, cx| {
            let handle = gpui::Focusable::focus_handle(terminal.read(cx), cx);
            handle.focus(window, cx);
        });
    }
}
