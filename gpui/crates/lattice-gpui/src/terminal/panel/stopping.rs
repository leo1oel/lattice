//! What closing would stop (`confirmStopping` in `terminal-window.ts`): a
//! terminal whose foreground job is not the shell at its prompt runs a
//! command, named by its process; closing its tab, the panel or (from the
//! shell) leaving the project asks first, naming what runs.

use gpui::{App, Context, Entity, Window};
use lattice_i18n::t;

use super::TerminalPanel;

impl TerminalPanel {
    /// What closing `keys` (every tab when `None`) would stop, by command
    /// name ("" when it has none to give).
    pub fn running(&self, keys: Option<&[usize]>, cx: &App) -> Vec<String> {
        self.sessions
            .iter()
            .filter(|session| keys.is_none_or(|keys| keys.contains(&session.key)))
            .filter_map(|session| session.screen.as_ref())
            .filter_map(|screen| running_command(screen.read(cx).terminal().read(cx)))
            .collect()
    }

    /// Ask before stopping what runs in `keys` (every tab when `None`),
    /// then `then` once the writer agrees (`confirmStopping`). True when
    /// nothing runs, and nothing was asked.
    pub fn confirm_stopping(
        panel: &Entity<Self>,
        keys: Option<Vec<usize>>,
        cx: &mut App,
        then: impl Fn(&mut Window, &mut App) + 'static,
    ) -> bool {
        let (running, several) = {
            let panel = panel.read(cx);
            let count = keys.as_ref().map_or(panel.sessions.len(), Vec::len);
            (panel.running(keys.as_deref(), cx), count > 1)
        };
        ask_stopping(running, several, cx, then)
    }

    /// A tab's × (and ⌘W in the panel): close it, asking first while a
    /// command runs in it.
    pub fn request_close(&mut self, key: usize, window: &mut Window, cx: &mut Context<Self>) {
        let panel = cx.entity().downgrade();
        let running = self.running(Some(&[key]), cx);
        let now = ask_stopping(running, false, cx, move |window, cx| {
            panel
                .update(cx, |panel, cx| panel.close(key, window, cx))
                .ok();
        });
        if now {
            self.close(key, window, cx);
        }
    }

    /// ⌘W with the terminal focused: close the tab in front. False when no
    /// tab is open, for the panel itself to close.
    pub fn close_active(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(key) = self.active else {
            return false;
        };
        self.request_close(key, window, cx);
        true
    }
}

/// Ask before stopping the `running` commands (`confirmStopping`), naming
/// them, then `then` once the writer agrees. True when nothing runs, and
/// nothing was asked.
fn ask_stopping(
    running: Vec<String>,
    several: bool,
    cx: &mut App,
    then: impl Fn(&mut Window, &mut App) + 'static,
) -> bool {
    if running.is_empty() {
        return true;
    }
    let mut names: Vec<String> = Vec::new();
    for name in running.into_iter().filter(|name| !name.is_empty()) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let body = if names.is_empty() {
        t!("A command is still running. Closing stops it.").to_string()
    } else {
        t!(
            "{name} is still running. Closing stops it.",
            name = names.join(", ")
        )
    };
    crate::confirm::ask(
        crate::confirm::Confirm::new(if several {
            t!("Close the terminals?")
        } else {
            t!("Close the terminal?")
        })
        .body(body)
        .confirm_label(t!("Close"))
        .destructive()
        .on_confirm(then),
        cx,
    );
    false
}

/// What a terminal's foreground job is, when it is not the shell at its
/// prompt: its command's name, or "" when it cannot be told.
fn running_command(terminal: &terminal::Terminal) -> Option<String> {
    let foreground = terminal.pid()?;
    let shell = terminal.pid_getter()?.fallback_pid();
    if foreground == shell {
        return None;
    }
    #[cfg(unix)]
    let name = lattice_core::terminal::process_name(foreground.as_u32() as i32);
    #[cfg(not(unix))]
    let name = terminal.foreground_process_command_name();
    Some(name.unwrap_or_default())
}
