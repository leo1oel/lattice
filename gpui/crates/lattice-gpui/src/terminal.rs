//! The Terminal panel: the Tauri app's (`src/terminal/`) on Zed's
//! alacritty-based terminal.
//!
//! - `launch`: the writer's login shell in the project folder, with
//!   Lattice's environment, through Zed's `TerminalBuilder`.
//! - `screen`: one terminal's screen, its keys, input method, caret blink,
//!   wheel and scrollbar.
//! - `element`: the grid drawn as xterm.js draws it in the Tauri app.
//! - `contrast`: xterm.js's minimum contrast for a program's colours.
//! - `panel`: the tabs, the find field, how a shell ended, the empty state.
//!
//! The panel opens across the foot of the whole workspace (`terminalHome`)
//! and toggles on ⌃` (⌘` is the Mac's next-window key), from the Panels
//! menu, View ▸ Terminal and the palette.

mod contrast;
mod element;
mod launch;
mod panel;
mod screen;

use gpui::{KeyBinding, actions};

pub use panel::{SessionState, TerminalPanel, TerminalPanelEvent};

actions!(
    lattice,
    [
        /// Show or hide the Terminal panel (⌃`).
        ToggleTerminalPanel,
        /// Open another terminal in the Terminal panel.
        NewTerminal,
        /// The find field over the terminal in front (⌘F in the terminal).
        FindInTerminal,
        /// Close the terminal tab in front (⌘W in the terminal).
        CloseTerminalTab,
    ]
);

/// The share of the window's height a newly opened Terminal panel takes
/// (`TERMINAL_SHARE`).
pub const TERMINAL_SHARE: f64 = 0.3;

/// The terminal's keys. ⌃` toggles the panel from anywhere. On macOS, in
/// the terminal, ⌘F finds, ⌘A selects everything, ⌘W closes the tab in
/// front and ⌘K is the command palette, over what Zed's keymap gives its
/// terminal (⌘K clears there, and Zed's ⌘F and ⌘A are its editor's); the
/// Tauri app leaves ⌘ keys to the window the same way. Elsewhere Ctrl+F,
/// Ctrl+A, Ctrl+W and Ctrl+K are the shell's own line-editing keys, so the
/// terminal keeps them, as xterm.js does there.
pub fn key_bindings() -> Vec<KeyBinding> {
    #[allow(unused_mut)]
    let mut bindings = vec![KeyBinding::new("ctrl-`", ToggleTerminalPanel, None)];
    #[cfg(target_os = "macos")]
    bindings.extend([
        KeyBinding::new("cmd-f", FindInTerminal, Some("Terminal")),
        KeyBinding::new("cmd-a", terminal::SelectAll, Some("Terminal")),
        KeyBinding::new("cmd-w", CloseTerminalTab, Some("Terminal")),
        KeyBinding::new(
            "cmd-k",
            crate::shell::commands::CommandPalette,
            Some("Terminal"),
        ),
        // The panel around the screen: its find field, its empty state.
        KeyBinding::new("cmd-f", FindInTerminal, Some("TerminalPanel")),
        KeyBinding::new("cmd-w", CloseTerminalTab, Some("TerminalPanel")),
    ]);
    // Lattice's Ctrl shortcuts (Ctrl+K, Ctrl+W, Ctrl+P…) stand aside for
    // the shell, which xterm.js hands every Ctrl+letter.
    #[cfg(not(target_os = "macos"))]
    bindings.extend(
        ('a'..='z')
            .map(|key| KeyBinding::new(&format!("ctrl-{key}"), gpui::NoAction, Some("Terminal"))),
    );
    bindings
}
