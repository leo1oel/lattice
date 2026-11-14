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
//! Zed's and alacritty's before it runs the shell in its own place, and
//! PowerShell does the same itself before its prompt; `HOME` is handed over
//! as Lattice has it.

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
    powershell_command(launch, std::env::var_os("LANG").is_some())
}

/// PowerShell has no `env` to start it through, so it sets Lattice's
/// variables and removes Zed's and alacritty's itself, before its prompt.
#[cfg_attr(unix, allow(dead_code))]
fn powershell_command(
    launch: &lattice_core::terminal::ShellLaunch,
    has_lang: bool,
) -> (String, Vec<String>) {
    let quote = |text: &str| format!("'{}'", text.replace('\'', "''"));
    let mut remove: Vec<&str> = vec!["ZED_TERM", "ALACRITTY_WINDOW_ID", "WINDOWID"];
    remove.extend(launch.env_remove.iter().map(String::as_str));
    if !has_lang {
        remove.push("LANG");
    }
    let mut script: Vec<String> = remove
        .into_iter()
        .map(|name| {
            format!(
                "Remove-Item -LiteralPath {} -ErrorAction SilentlyContinue",
                quote(&format!("Env:{name}"))
            )
        })
        .collect();
    script.extend(launch.env.iter().map(|(name, value)| {
        format!(
            "Set-Item -LiteralPath {} -Value {}",
            quote(&format!("Env:{name}")),
            quote(value)
        )
    }));
    let mut args = launch.args.clone();
    args.push("-Command".to_string());
    args.push(script.join("; "));
    (launch.program.to_string_lossy().into_owned(), args)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_sets_lattices_variables_before_its_prompt() {
        let launch = lattice_core::terminal::ShellLaunch {
            program: "powershell.exe".into(),
            args: vec!["-NoLogo".into(), "-NoExit".into()],
            env: vec![
                ("TERM_PROGRAM".into(), "Lattice".into()),
                ("PATH".into(), r"C:\Program Files\it's;C:\bin".into()),
            ],
            env_remove: vec!["LATTICE_PROJECT".into()],
        };
        let (program, args) = powershell_command(&launch, true);
        assert_eq!(program, "powershell.exe");
        assert_eq!(args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert_eq!(args.len(), 4);
        let statements: Vec<&str> = args[3].split("; ").collect();
        assert_eq!(
            statements,
            [
                "Remove-Item -LiteralPath 'Env:ZED_TERM' -ErrorAction SilentlyContinue",
                "Remove-Item -LiteralPath 'Env:ALACRITTY_WINDOW_ID' -ErrorAction SilentlyContinue",
                "Remove-Item -LiteralPath 'Env:WINDOWID' -ErrorAction SilentlyContinue",
                "Remove-Item -LiteralPath 'Env:LATTICE_PROJECT' -ErrorAction SilentlyContinue",
                "Set-Item -LiteralPath 'Env:TERM_PROGRAM' -Value 'Lattice'",
                r"Set-Item -LiteralPath 'Env:PATH' -Value 'C:\Program Files\it''s;C:\bin'",
            ]
        );
        let (_, args) = powershell_command(&launch, false);
        assert!(args[3].contains("Remove-Item -LiteralPath 'Env:LANG'"));
    }

    #[cfg(unix)]
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
