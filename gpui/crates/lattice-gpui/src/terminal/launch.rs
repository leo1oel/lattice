//! Starting a terminal's shell through Zed's terminal, as the Tauri app
//! starts it through lattice-core (`terminal/pty.rs`): the writer's login
//! shell, in the project folder, with Lattice's search path and naming
//! Lattice as the terminal program.
//!
//! Zed's `TerminalBuilder` opens the pty and adds its own variables after
//! the ones it is handed (`ZED_TERM`, `TERM_PROGRAM=zed`, a `LANG` when
//! Lattice has none), and alacritty adds its window id and takes `HOME`
//! from the account record. A shell's startup files read those, so on Unix
//! the shell is started through `env`, which sets Lattice's and removes
//! Zed's and alacritty's before it runs the shell in its own place; `HOME`
//! is handed over as Lattice has it.

use std::{collections::HashMap, path::Path, process::ExitStatus};

use anyhow::Result;
use gpui::{App, Task};
use task::Shell;
use terminal::{
    TerminalBuilder,
    terminal_settings::{AlternateScroll, CursorShape},
};
use util::paths::PathStyle;

/// xterm.js's `scrollback` in the Tauri app.
pub const SCROLLBACK_LINES: usize = 5000;

/// The program and arguments that run `launch`'s shell with its own
/// environment, whatever Zed's terminal adds to the one it is given.
#[cfg(unix)]
fn command(launch: &lattice_core::terminal::ShellLaunch) -> (String, Vec<String>) {
    let mut args = Vec::new();
    let mut unset = |name: &str| {
        args.push("-u".to_string());
        args.push(name.to_string());
    };
    for name in ["ZED_TERM", "ALACRITTY_WINDOW_ID", "WINDOWID"] {
        unset(name);
    }
    for name in &launch.env_remove {
        unset(name);
    }
    // Zed's fallback locale; Lattice's own (`LC_CTYPE`) is in `launch.env`.
    if std::env::var_os("LANG").is_none() {
        unset("LANG");
    }
    args.extend(
        launch
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}")),
    );
    args.push(launch.program.to_string_lossy().into_owned());
    args.extend(launch.args.iter().cloned());
    ("/usr/bin/env".to_string(), args)
}

#[cfg(not(unix))]
fn command(launch: &lattice_core::terminal::ShellLaunch) -> (String, Vec<String>) {
    (
        launch.program.to_string_lossy().into_owned(),
        launch.args.clone(),
    )
}

/// Start a shell in `root`. `exited` hears how it ended: its status, or
/// `None` when it was ended from here.
pub fn start(
    root: &Path,
    window_id: u64,
    exited: async_channel::Sender<Option<ExitStatus>>,
    cx: &App,
) -> (String, Task<Result<TerminalBuilder>>) {
    let launch = lattice_core::terminal::shell_launch();
    let name = launch.name();
    let (program, args) = command(&launch);
    let mut env: HashMap<String, String> = HashMap::default();
    if let Some(home) = std::env::var_os("HOME") {
        env.insert("HOME".into(), home.to_string_lossy().into_owned());
    }
    #[cfg(not(unix))]
    env.extend(launch.env.iter().cloned());
    let task = TerminalBuilder::new(
        Some(root.to_path_buf()),
        terminal::TerminalMode::interactive_with_completion(exited),
        Shell::WithArguments {
            program,
            args,
            title_override: Some(name.clone()),
        },
        env.into_iter().collect(),
        CursorShape::Bar,
        AlternateScroll::On,
        Some(SCROLLBACK_LINES),
        Vec::new(),
        std::time::Duration::from_millis(0),
        false,
        window_id,
        cx,
        Vec::new(),
        PathStyle::local(),
    );
    (name, task)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_shell_runs_through_env_with_lattices_variables() {
        let launch = lattice_core::terminal::ShellLaunch {
            program: "/bin/zsh".into(),
            args: vec!["-l".into()],
            env: vec![("TERM_PROGRAM".into(), "Lattice".into())],
            env_remove: vec!["LATTICE_PROJECT".into()],
        };
        let (program, args) = command(&launch);
        assert_eq!(program, "/usr/bin/env");
        let joined = args.join(" ");
        assert!(joined.contains("-u ZED_TERM"));
        assert!(joined.contains("-u LATTICE_PROJECT"));
        assert!(
            joined.ends_with("TERM_PROGRAM=Lattice /bin/zsh -l"),
            "{joined}"
        );
    }
}
